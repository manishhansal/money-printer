/**
 * dhan-api.client.ts
 *
 * DhanApiClient — typed HTTP client for all official Dhan/DhanHQ v2 endpoints.
 *
 * Design rules (Requirements 3.1, 3.2, 3.3, 3.6, 3.7, 3.9):
 *  1. Only officially documented Dhan endpoints are called.
 *  2. Session token is fetched from SecretsService on every request (never stored locally).
 *  3. HTTP 401/403 → invalidate the token via SecretsService.set('', '') equivalent
 *     and throw DhanAuthFailureError without retry.
 *  4. Rate-limit queue: buffers up to 50 pending requests; retries after Retry-After
 *     window. When queue is at capacity, throws DhanRateLimitQueueFullError.
 *  5. No secret values appear in logs (keys are logged, values are not).
 *  6. Content-Type: application/json and access-token header on every request.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretsService } from '../secrets/secrets.service';
import {
  DhanAuthFailureError,
  DhanAuthResponse,
  DhanCancelOrderResponse,
  DhanCandleRequest,
  DhanCandleResponse,
  DhanErrorResponse,
  DhanFundLimitResponse,
  DhanHistoricalCandleRequest,
  DhanIntradayCandleRequest,
  DhanModifyOrderRequest,
  DhanModifySuperOrderRequest,
  DhanOptionChainResponse,
  DhanOrderbookResponse,
  DhanOrderRequest,
  DhanOrderResponse,
  DhanPortfolioResponse,
  DhanPositionsResponse,
  DhanQuoteRequest,
  DhanQuoteResponse,
  DhanRateLimitQueueFullError,
  DhanSuperOrderRequest,
  DhanSuperOrderResponse,
  DhanTradebookResponse,
} from './dhan-api.types';

// ---------------------------------------------------------------------------
// Rate-limit queue types
// ---------------------------------------------------------------------------

/** Maximum pending requests before the queue is considered full. */
const RATE_LIMIT_QUEUE_MAX = 50;

/** A deferred unit of work placed in the rate-limit queue. */
interface QueueEntry<T> {
  /** Factory that (re-)executes the Dhan HTTP call. */
  execute: () => Promise<T>;
  /** Resolves or rejects the caller's Promise. */
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason: unknown) => void;
}

// ---------------------------------------------------------------------------
// DhanApiClient
// ---------------------------------------------------------------------------

@Injectable()
export class DhanApiClient implements OnModuleDestroy {
  private readonly logger = new Logger(DhanApiClient.name);

  /** Base URL for all Dhan REST calls. */
  private readonly baseUrl: string;

  /** Pending rate-limited requests. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly rateLimitQueue: QueueEntry<any>[] = [];

  /** True while a rate-limit retry timer is running. */
  private rateLimitTimerActive = false;

  /** NodeJS timer reference so we can clean it up on module destroy. */
  private rateLimitTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly secrets: SecretsService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config.get<string>('DHAN_API_BASE_URL', 'https://api.dhan.co');
  }

  onModuleDestroy(): void {
    if (this.rateLimitTimer) {
      clearTimeout(this.rateLimitTimer);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch the Dhan session token from SecretsService.
   * Never stored on this class (Requirement 3.3).
   */
  private async getSessionToken(): Promise<string> {
    return this.secrets.get('DHAN_SESSION_TOKEN');
  }

  /**
   * Fetch the Dhan client ID from SecretsService.
   */
  private async getClientId(): Promise<string> {
    return this.secrets.get('DHAN_CLIENT_ID');
  }

  /**
   * Build standard headers for every Dhan request.
   * client-id header is included for endpoints that require it (quote, option chain).
   */
  private async buildHeaders(includeClientId = false): Promise<Record<string, string>> {
    const token = await this.getSessionToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'access-token': token,
    };
    if (includeClientId) {
      headers['client-id'] = await this.getClientId();
    }
    return headers;
  }

  /**
   * Core HTTP dispatcher.
   *
   * - Attaches auth headers on every call.
   * - On HTTP 401/403: invalidates token, throws DhanAuthFailureError (no retry).
   * - On HTTP 429: adds the request to the rate-limit queue (if space available).
   * - All other non-OK responses: throws with error body context.
   * - Sensitive values are never logged.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    includeClientId = false,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = await this.buildHeaders(includeClientId);

    // Log the request context — never log the access-token value.
    this.logger.debug(`→ ${method} ${path}`);

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // Authentication failure — invalidate token, no retry (Requirement 3.7).
    if (response.status === 401 || response.status === 403) {
      this.logger.warn(
        `Auth failure (HTTP ${response.status}) on ${method} ${path}; invalidating DHAN_SESSION_TOKEN`,
      );
      await this.invalidateToken();
      throw new DhanAuthFailureError(response.status as 401 | 403, `${method} ${path}`);
    }

    // Rate-limit response — queue or reject (Requirements 3.6, 3.9).
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 1;

      return this.enqueueRateLimitedRequest<T>(
        () => this.request<T>(method, path, body, includeClientId),
        retryAfterSeconds,
      );
    }

    if (!response.ok) {
      const errorBody = await this.safeReadJson<DhanErrorResponse>(response);
      // Log the error type/code — never the token.
      this.logger.error(
        `Dhan API error on ${method} ${path}: ` +
          `HTTP ${response.status} · code=${errorBody?.errorCode ?? 'unknown'} ` +
          `type=${errorBody?.errorType ?? 'unknown'}`,
      );
      throw new Error(
        `Dhan API error: HTTP ${response.status} — ${errorBody?.errorMessage ?? 'Unknown error'}`,
      );
    }

    // 204 No Content (e.g. cancel super order leg).
    if (response.status === 204) {
      return undefined as unknown as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * Invalidate the stored session token by overwriting it with an empty string
   * so that any subsequent call will fail fast at the Dhan layer rather than
   * silently using a revoked token.
   */
  private async invalidateToken(): Promise<void> {
    try {
      await this.secrets.set('DHAN_SESSION_TOKEN', '');
      this.logger.warn('DHAN_SESSION_TOKEN has been invalidated');
    } catch (err) {
      this.logger.error(`Failed to invalidate DHAN_SESSION_TOKEN: ${(err as Error).message}`);
    }
  }

  /**
   * Add a failed request to the rate-limit queue.
   *
   * Requirements 3.6 and 3.9:
   *  - If queue has room (< 50 entries) → add and schedule retry after retryAfterSeconds.
   *  - If queue is at capacity → throw DhanRateLimitQueueFullError immediately.
   */
  private enqueueRateLimitedRequest<T>(
    execute: () => Promise<T>,
    retryAfterSeconds: number,
  ): Promise<T> {
    if (this.rateLimitQueue.length >= RATE_LIMIT_QUEUE_MAX) {
      this.logger.warn(`Rate-limit queue at capacity (${RATE_LIMIT_QUEUE_MAX}); rejecting request`);
      throw new DhanRateLimitQueueFullError();
    }

    return new Promise<T>((resolve, reject) => {
      this.rateLimitQueue.push({ execute, resolve, reject });
      this.logger.debug(
        `Request queued for retry (queue size: ${this.rateLimitQueue.length}); ` +
          `retry in ${retryAfterSeconds}s`,
      );
      this.scheduleRateLimitFlush(retryAfterSeconds);
    });
  }

  /**
   * Schedule draining the rate-limit queue after the specified delay.
   * If a timer is already running we do not reset it — the existing timer
   * will eventually fire and drain all currently queued entries.
   */
  private scheduleRateLimitFlush(delaySeconds: number): void {
    if (this.rateLimitTimerActive) {
      return;
    }
    this.rateLimitTimerActive = true;
    this.rateLimitTimer = setTimeout(() => {
      this.rateLimitTimerActive = false;
      void this.flushRateLimitQueue();
    }, delaySeconds * 1_000);
  }

  /** Drain all queued rate-limited requests sequentially. */
  private async flushRateLimitQueue(): Promise<void> {
    this.logger.debug(`Flushing rate-limit queue (${this.rateLimitQueue.length} entries)`);
    // Snapshot the queue and clear it before processing so that any new 429s
    // that arrive during flush go back onto a fresh queue entry.
    const entries = this.rateLimitQueue.splice(0, this.rateLimitQueue.length);
    for (const entry of entries) {
      try {
        const result = await entry.execute();
        entry.resolve(result);
      } catch (err) {
        entry.reject(err);
      }
    }
  }

  /** Safely read JSON from a Response without throwing on parse failure. */
  private async safeReadJson<T>(response: Response): Promise<T | null> {
    try {
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Authentication
  // ---------------------------------------------------------------------------

  /**
   * Obtain a new Dhan access token.
   *
   * Note: Dhan v2 does not expose a token-generation REST endpoint that requires
   * no prior token — the access token is generated via the Dhan web portal and
   * provided as a long-lived secret. This method documents the conceptual
   * "authentication" step: it retrieves the current token from SecretsService
   * and returns it in a DhanAuthResponse shape so callers can verify validity.
   *
   * Requirement 3.2 — authentication endpoint category.
   */
  async getAccessToken(): Promise<DhanAuthResponse> {
    const token = await this.getSessionToken();
    const clientId = await this.getClientId();
    // Dhan tokens are long-lived and configured in the portal; we return the
    // stored token wrapped in the auth response shape. No API call is needed
    // for this category as Dhan v2 has no REST token-issuance endpoint.
    return {
      accessToken: token,
      dhanClientId: clientId,
      // Dhan tokens don't carry an expiry in a machine-readable field via REST;
      // we return a sentinel far-future date to indicate "valid until revoked".
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Live quotes (REST snapshot)
  // ---------------------------------------------------------------------------

  /**
   * Fetch full market depth quote for the requested instruments.
   *
   * Maps to POST /v2/marketfeed/quote.
   * Requirement 3.2 — live quotes endpoint category.
   *
   * @param request  Map of exchangeSegment → securityId[].
   */
  async getQuote(request: DhanQuoteRequest): Promise<DhanQuoteResponse> {
    return this.request<DhanQuoteResponse>(
      'POST',
      '/v2/marketfeed/quote',
      request,
      true, // client-id header required
    );
  }

  // ---------------------------------------------------------------------------
  // 3. Historical candles
  // ---------------------------------------------------------------------------

  /**
   * Fetch historical OHLCV candles.
   *
   * Routes to /v2/charts/historical (daily) or /v2/charts/intraday (minute)
   * based on the presence of an `interval` field in the request.
   *
   * Requirement 3.2 — historical candles endpoint category.
   */
  async getHistoricalCandles(request: DhanCandleRequest): Promise<DhanCandleResponse> {
    const isIntraday = 'interval' in request;
    const path = isIntraday ? '/v2/charts/intraday' : '/v2/charts/historical';

    // Build endpoint-specific body (remove cross-type fields).
    const body: DhanHistoricalCandleRequest | DhanIntradayCandleRequest = isIntraday
      ? (request as DhanIntradayCandleRequest)
      : (request as DhanHistoricalCandleRequest);

    return this.request<DhanCandleResponse>('POST', path, body);
  }

  // ---------------------------------------------------------------------------
  // 4. Option chain
  // ---------------------------------------------------------------------------

  /**
   * Fetch the full option chain for an underlying + expiry.
   *
   * Maps to POST /v2/optionchain.
   * Requirement 3.2 — option chains endpoint category.
   *
   * @param underlyingScrip  Security ID of the underlying (integer).
   * @param underlyingSeg    Exchange segment (e.g. 'IDX_I', 'NSE_FNO').
   * @param expiryDate       Expiry date in YYYY-MM-DD format.
   */
  async getOptionChain(
    underlyingScrip: number,
    underlyingSeg: string,
    expiryDate: string,
  ): Promise<DhanOptionChainResponse> {
    return this.request<DhanOptionChainResponse>(
      'POST',
      '/v2/optionchain',
      {
        UnderlyingScrip: underlyingScrip,
        UnderlyingSeg: underlyingSeg,
        Expiry: expiryDate,
      },
      true, // client-id header required
    );
  }

  // ---------------------------------------------------------------------------
  // 5. Order placement
  // ---------------------------------------------------------------------------

  /**
   * Place a new order.
   *
   * Maps to POST /v2/orders.
   * Requirement 3.2 — order placement endpoint category.
   */
  async placeOrder(request: DhanOrderRequest): Promise<DhanOrderResponse> {
    return this.request<DhanOrderResponse>('POST', '/v2/orders', request);
  }

  // ---------------------------------------------------------------------------
  // 6. Order modification
  // ---------------------------------------------------------------------------

  /**
   * Modify a pending order.
   *
   * Maps to PUT /v2/orders/{order-id}.
   * Requirement 3.2 — order modification endpoint category.
   */
  async modifyOrder(orderId: string, request: DhanModifyOrderRequest): Promise<DhanOrderResponse> {
    return this.request<DhanOrderResponse>('PUT', `/v2/orders/${orderId}`, request);
  }

  // ---------------------------------------------------------------------------
  // 7. Order cancellation
  // ---------------------------------------------------------------------------

  /**
   * Cancel a pending order.
   *
   * Maps to DELETE /v2/orders/{order-id}.
   * Requirement 3.2 — order cancellation endpoint category.
   */
  async cancelOrder(orderId: string): Promise<DhanCancelOrderResponse> {
    return this.request<DhanCancelOrderResponse>('DELETE', `/v2/orders/${orderId}`);
  }

  // ---------------------------------------------------------------------------
  // 8. Positions
  // ---------------------------------------------------------------------------

  /**
   * Retrieve all open positions.
   *
   * Maps to GET /v2/positions.
   * Requirement 3.2 — positions endpoint category.
   */
  async getPositions(): Promise<DhanPositionsResponse> {
    return this.request<DhanPositionsResponse>('GET', '/v2/positions');
  }

  // ---------------------------------------------------------------------------
  // 9. Portfolio / holdings
  // ---------------------------------------------------------------------------

  /**
   * Retrieve holdings in the demat account.
   *
   * Maps to GET /v2/holdings.
   * Requirement 3.2 — portfolio endpoint category.
   */
  async getPortfolio(): Promise<DhanPortfolioResponse> {
    return this.request<DhanPortfolioResponse>('GET', '/v2/holdings');
  }

  // ---------------------------------------------------------------------------
  // 10. Tradebook
  // ---------------------------------------------------------------------------

  /**
   * Retrieve all trades for the day.
   *
   * Maps to GET /v2/trades.
   * Requirement 3.2 — tradebook endpoint category.
   */
  async getTradebook(): Promise<DhanTradebookResponse> {
    return this.request<DhanTradebookResponse>('GET', '/v2/trades');
  }

  // ---------------------------------------------------------------------------
  // 11. Orderbook
  // ---------------------------------------------------------------------------

  /**
   * Retrieve all orders for the day.
   *
   * Maps to GET /v2/orders.
   * Requirement 3.2 — orderbook endpoint category.
   */
  async getOrderbook(): Promise<DhanOrderbookResponse> {
    return this.request<DhanOrderbookResponse>('GET', '/v2/orders');
  }

  // ---------------------------------------------------------------------------
  // 12–14. Super Orders
  // ---------------------------------------------------------------------------

  /**
   * Place a new Super Order (entry + target + stop-loss legs).
   *
   * Maps to POST /v2/super/orders.
   * Requirement 3.2 — Super Orders endpoint category.
   */
  async placeSuperOrder(request: DhanSuperOrderRequest): Promise<DhanSuperOrderResponse> {
    return this.request<DhanSuperOrderResponse>('POST', '/v2/super/orders', request);
  }

  /**
   * Modify a pending Super Order leg.
   *
   * Maps to PUT /v2/super/orders/{order-id}.
   * Requirement 3.2 — Super Orders endpoint category.
   */
  async modifySuperOrder(
    orderId: string,
    request: DhanModifySuperOrderRequest,
  ): Promise<DhanSuperOrderResponse> {
    return this.request<DhanSuperOrderResponse>('PUT', `/v2/super/orders/${orderId}`, request);
  }

  /**
   * Cancel a Super Order leg.
   *
   * Maps to DELETE /v2/super/orders/{order-id}/{order-leg}.
   * The Dhan API returns 204 No Content; this method returns void.
   * Requirement 3.2 — Super Orders endpoint category.
   */
  async cancelSuperOrder(
    orderId: string,
    orderLeg: 'ENTRY_LEG' | 'TARGET_LEG' | 'STOP_LOSS_LEG' = 'ENTRY_LEG',
  ): Promise<void> {
    await this.request<void>('DELETE', `/v2/super/orders/${orderId}/${orderLeg}`);
  }

  // ---------------------------------------------------------------------------
  // 15. Fund limit
  // ---------------------------------------------------------------------------

  /**
   * Retrieve available funds and margin limits.
   *
   * Maps to GET /v2/fundlimit.
   * Requirement 3.2 — fund limit endpoint category.
   */
  async getFundLimit(): Promise<DhanFundLimitResponse> {
    return this.request<DhanFundLimitResponse>('GET', '/v2/fundlimit');
  }
}
