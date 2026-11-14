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

import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
  DhanKillSwitchResponse,
  DhanLtpResponse,
  DhanMarginCalculatorRequest,
  DhanMarginCalculatorResponse,
  DhanModifyOrderRequest,
  DhanModifySuperOrderRequest,
  DhanOhlcResponse,
  DhanOptionChainResponse,
  DhanOptionExpiryListResponse,
  DhanOrder,
  DhanOrderbookResponse,
  DhanOrderRequest,
  DhanOrderResponse,
  DhanPnlExitGetResponse,
  DhanPnlExitRequest,
  DhanPnlExitResponse,
  DhanPortfolioResponse,
  DhanPositionsResponse,
  DhanQuoteRequest,
  DhanQuoteResponse,
  DhanRateLimitQueueFullError,
  DhanRollingOptionRequest,
  DhanRollingOptionResponse,
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
// Circuit breaker + retry constants (Phase 10 — Production Hardening)
// ---------------------------------------------------------------------------

/** Hard timeout for every Dhan API fetch call. Prevents indefinite hangs. */
const REQUEST_TIMEOUT_MS = 10_000;

/** 5xx status codes treated as transient and eligible for automatic retry. */
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);

/** Maximum number of automatic retries for transient 5xx errors. */
const MAX_RETRIES = 3;

/** Base back-off delay (ms) for the first retry; doubles each attempt. */
const BACKOFF_BASE_MS = 500;

/** Consecutive-failure count before the circuit breaker opens. */
const CB_FAILURE_THRESHOLD = 5;

/** How long (ms) the circuit stays OPEN before switching to HALF_OPEN. */
const CB_COOLDOWN_MS = 60_000;

/** Circuit breaker state machine states. */
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

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

  // ── Circuit breaker state (Phase 10) ───────────────────────────────────────
  /** Current circuit breaker state. CLOSED = normal; OPEN = blocking; HALF_OPEN = probing. */
  private cbState: CircuitState = 'CLOSED';
  /** Count of consecutive failures that have not been reset by a success. */
  private cbFailureCount = 0;
  /** Timestamp when the circuit was opened (used to compute cooldown). */
  private cbOpenedAt?: Date;

  constructor(
    private readonly secrets: SecretsService,
    private readonly config: ConfigService,
    @Optional() private readonly eventEmitter: EventEmitter2 | null = null,
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
    retryCount = 0,
  ): Promise<T> {
    // ── Circuit breaker: OPEN state check ─────────────────────────────────────
    if (this.cbState === 'OPEN') {
      const cooldownExpired =
        this.cbOpenedAt !== undefined && Date.now() - this.cbOpenedAt.getTime() >= CB_COOLDOWN_MS;
      if (cooldownExpired) {
        this.cbState = 'HALF_OPEN';
        this.logger.log(`[CircuitBreaker] OPEN → HALF_OPEN after ${CB_COOLDOWN_MS / 1_000}s`);
      } else {
        const remaining = this.cbOpenedAt
          ? Math.ceil((CB_COOLDOWN_MS - (Date.now() - this.cbOpenedAt.getTime())) / 1_000)
          : 0;
        throw new Error(
          `Dhan API circuit breaker is OPEN — refusing request ${method} ${path}. ` +
            `Retry in ~${remaining}s. Last failure count: ${this.cbFailureCount}.`,
        );
      }
    }

    const url = `${this.baseUrl}${path}`;
    const headers = await this.buildHeaders(includeClientId);
    const requestStart = Date.now();

    // Log the request context — never log the access-token value.
    const retryLabel = retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : '';
    this.logger.debug(`→ ${method} ${path}${retryLabel}`);

    // ── Fetch with AbortController timeout (10 s) ─────────────────────────────
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutHandle);
      const isAbort = (err as Error).name === 'AbortError';
      const msg = isAbort
        ? `Dhan API request timed out after ${REQUEST_TIMEOUT_MS / 1_000}s: ${method} ${path}`
        : `Dhan API network error on ${method} ${path}: ${(err as Error).message}`;
      this.logger.error(msg);
      this.recordCircuitFailure();
      // Network errors are retried like transient 5xx.
      if (retryCount < MAX_RETRIES) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, retryCount);
        this.logger.warn(`Retrying ${method} ${path} in ${delay}ms…`);
        await this.sleep(delay);
        return this.request<T>(method, path, body, includeClientId, retryCount + 1);
      }
      throw new Error(msg);
    } finally {
      clearTimeout(timeoutHandle);
    }

    // Authentication failure — invalidate token, no retry (Requirement 3.7).
    if (response.status === 401 || response.status === 403) {
      this.logger.warn(
        `Auth failure (HTTP ${response.status}) on ${method} ${path}; invalidating DHAN_SESSION_TOKEN`,
      );
      this.recordCircuitFailure(/* permanent */ true);
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

    // Transient 5xx — retry with exponential back-off.
    if (RETRYABLE_STATUS_CODES.has(response.status) && retryCount < MAX_RETRIES) {
      const delay = BACKOFF_BASE_MS * Math.pow(2, retryCount);
      this.logger.warn(
        `Transient Dhan error HTTP ${response.status} on ${method} ${path}; ` +
          `retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`,
      );
      this.recordCircuitFailure();
      await this.sleep(delay);
      return this.request<T>(method, path, body, includeClientId, retryCount + 1);
    }

    if (!response.ok) {
      const errorBody = await this.safeReadJson<DhanErrorResponse>(response);
      this.logger.error(
        `Dhan API error on ${method} ${path}: ` +
          `HTTP ${response.status} · code=${errorBody?.errorCode ?? 'unknown'} ` +
          `type=${errorBody?.errorType ?? 'unknown'}`,
      );
      this.recordCircuitFailure();
      throw new Error(
        `Dhan API error: HTTP ${response.status} — ${errorBody?.errorMessage ?? 'Unknown error'}`,
      );
    }

    // Success — reset circuit breaker.
    this.onRequestSuccess();

    // 204 No Content (e.g. cancel super order leg).
    if (response.status === 204) {
      return undefined as unknown as T;
    }

    const result = response.json() as Promise<T>;

    // Emit order execution latency for the SystemHealthMonitor histogram.
    const latencyMs = Date.now() - requestStart;
    this.eventEmitter?.emit('dhan.order.latency', { latencyMs, path, method });

    return result;
  }

  // ── Circuit breaker helpers ──────────────────────────────────────────────────

  /**
   * Reset circuit breaker failure count on a successful request.
   * If HALF_OPEN, closes the circuit (service recovered).
   */
  private onRequestSuccess(): void {
    if (this.cbState !== 'CLOSED') {
      this.logger.log(`[CircuitBreaker] Request succeeded — circuit moved to CLOSED`);
    }
    this.cbState = 'CLOSED';
    this.cbFailureCount = 0;
    this.cbOpenedAt = undefined;
  }

  /**
   * Increment the failure counter. Opens the circuit when the threshold is reached.
   *
   * @param permanent When true (auth failures), opens the circuit immediately
   *                  regardless of the threshold, since retrying won't help.
   */
  private recordCircuitFailure(permanent = false): void {
    this.cbFailureCount++;

    if (permanent || this.cbFailureCount >= CB_FAILURE_THRESHOLD) {
      if (this.cbState !== 'OPEN') {
        this.cbState = 'OPEN';
        this.cbOpenedAt = new Date();
        this.logger.error(
          `[CircuitBreaker] Circuit OPENED after ${this.cbFailureCount} failure(s). ` +
            `All requests will be rejected for ${CB_COOLDOWN_MS / 1_000}s. ` +
            `${permanent ? 'Permanent failure (auth).' : ''}`,
        );
      }
    }
  }

  /** Simple sleep utility for back-off delays. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  /**
   * Retrieve all fills/executions for a specific order.
   *
   * Maps to GET /v2/trades/{order-id}.
   * More targeted than `getTradebook()` when only one order's fills are needed.
   *
   * Requirements: Section 5 — Trading APIs audit
   */
  async getTradesByOrderId(dhanOrderId: string): Promise<DhanTradebookResponse> {
    return this.request<DhanTradebookResponse>('GET', `/v2/trades/${dhanOrderId}`);
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
   * Retrieve all Super Orders for the day.
   *
   * Maps to GET /v2/super/orders.
   * Useful for SL verification after reconnect and for monitoring active
   * Super Order legs (entry + target + stop-loss).
   *
   * Requirements: Section 5 — `GET /super/orders` audit item
   */
  async getSuperOrders(): Promise<DhanSuperOrderResponse[]> {
    return this.request<DhanSuperOrderResponse[]>('GET', '/v2/super/orders');
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

  // ---------------------------------------------------------------------------
  // 16. Single order status
  // ---------------------------------------------------------------------------

  /**
   * Retrieve the status of a single order by its Dhan order ID.
   *
   * Maps to GET /v2/orders/{order-id}.
   * More efficient than getOrderbook() when only one order needs to be checked.
   */
  async getOrderById(dhanOrderId: string): Promise<DhanOrder> {
    return this.request<DhanOrder>('GET', `/v2/orders/${dhanOrderId}`);
  }

  // ---------------------------------------------------------------------------
  // 16b. Order lookup by correlation ID (crash-recovery path)
  // ---------------------------------------------------------------------------

  /**
   * Retrieve a Dhan order by the client-assigned correlation ID.
   *
   * Maps to GET /v2/orders/external/{correlationId}.
   *
   * Critical for crash recovery: if a broker submission succeeded but the
   * CloudEngine crashed before persisting the DB record, this endpoint
   * recovers the Dhan orderId using only the correlationId (which the
   * ExecutionService always stores in the Orders.dhan_correlation_id column
   * and sets as the pending record key before submission).
   *
   * Returns the matching DhanOrder; throws if not found (404 from Dhan).
   *
   * Requirements: P0-CRIT-002 (crash recovery path)
   */
  async getOrderByCorrelationId(correlationId: string): Promise<DhanOrder> {
    return this.request<DhanOrder>(
      'GET',
      `/v2/orders/external/${encodeURIComponent(correlationId)}`,
    );
  }

  // ---------------------------------------------------------------------------
  // 17. LTP snapshot (lightweight)
  // ---------------------------------------------------------------------------

  /**
   * Fetch the Last Traded Price for a list of instruments.
   *
   * Maps to POST /v2/marketfeed/ltp.
   * Lightweight alternative to getQuote() — no market depth returned.
   * Requires client-id header.
   */
  async getLtp(request: DhanQuoteRequest): Promise<DhanLtpResponse> {
    return this.request<DhanLtpResponse>(
      'POST',
      '/v2/marketfeed/ltp',
      request,
      true, // client-id required
    );
  }

  // ---------------------------------------------------------------------------
  // 18. OHLC snapshot
  // ---------------------------------------------------------------------------

  /**
   * Fetch OHLC + LTP for a list of instruments.
   *
   * Maps to POST /v2/marketfeed/ohlc.
   * Returns open, high, low, close, and last traded price.
   * Requires client-id header.
   */
  async getOhlcSnapshot(request: DhanQuoteRequest): Promise<DhanOhlcResponse> {
    return this.request<DhanOhlcResponse>(
      'POST',
      '/v2/marketfeed/ohlc',
      request,
      true, // client-id required
    );
  }

  // ---------------------------------------------------------------------------
  // 19. Option chain expiry list
  // ---------------------------------------------------------------------------

  /**
   * Retrieve all active expiry dates for a given underlying instrument.
   *
   * Maps to POST /v2/optionchain/expirylist.
   * Used by InstrumentDiscovery to know which expiries are available before
   * fetching the full option chain.
   * Requires client-id header.
   *
   * @param underlyingScrip  Security ID of the underlying (integer).
   * @param underlyingSeg    Exchange segment (e.g. 'IDX_I', 'NSE_FNO').
   */
  async getOptionExpiryList(
    underlyingScrip: number,
    underlyingSeg: string,
  ): Promise<DhanOptionExpiryListResponse> {
    return this.request<DhanOptionExpiryListResponse>(
      'POST',
      '/v2/optionchain/expirylist',
      { UnderlyingScrip: underlyingScrip, UnderlyingSeg: underlyingSeg },
      true, // client-id required
    );
  }

  // ---------------------------------------------------------------------------
  // 20–22. Dhan Kill Switch (account-level)
  // ---------------------------------------------------------------------------

  /**
   * Activate or deactivate the Dhan account-level kill switch.
   *
   * Maps to POST /v2/killswitch?killSwitchStatus=ACTIVATE|DEACTIVATE.
   * When ACTIVATED, Dhan disables ALL trading for the current day.
   * Note: All positions must be closed and no pending orders must exist
   * before Dhan will accept activation.
   */
  async setKillSwitch(status: 'ACTIVATE' | 'DEACTIVATE'): Promise<DhanKillSwitchResponse> {
    return this.request<DhanKillSwitchResponse>(
      'POST',
      `/v2/killswitch?killSwitchStatus=${status}`,
    );
  }

  /**
   * Get the current kill switch status for this account.
   *
   * Maps to GET /v2/killswitch.
   */
  async getKillSwitchStatus(): Promise<DhanKillSwitchResponse> {
    return this.request<DhanKillSwitchResponse>('GET', '/v2/killswitch');
  }

  // ---------------------------------------------------------------------------
  // 23–25. P&L Based Auto-Exit (broker-side safety net)
  // ---------------------------------------------------------------------------

  /**
   * Configure a broker-side P&L based auto-exit rule.
   *
   * Maps to POST /v2/pnlExit.
   * When cumulative P&L reaches profitValue or -lossValue, Dhan closes all
   * matching positions automatically. Active for the current trading day only.
   *
   * Use this as a belt-and-suspenders complement to the in-process
   * DailyLossStateMachineService — if the CloudEngine crashes, Dhan still
   * enforces the loss limit.
   */
  async setPnlExit(request: DhanPnlExitRequest): Promise<DhanPnlExitResponse> {
    return this.request<DhanPnlExitResponse>('POST', '/v2/pnlExit', request);
  }

  /**
   * Disable the active P&L based exit configuration.
   *
   * Maps to DELETE /v2/pnlExit.
   * Called at session end or when the CloudEngine manages exits independently.
   */
  async deletePnlExit(): Promise<DhanPnlExitResponse> {
    return this.request<DhanPnlExitResponse>('DELETE', '/v2/pnlExit');
  }

  /**
   * Get the currently active P&L based exit configuration.
   *
   * Maps to GET /v2/pnlExit.
   */
  async getPnlExit(): Promise<DhanPnlExitGetResponse> {
    return this.request<DhanPnlExitGetResponse>('GET', '/v2/pnlExit');
  }

  // ---------------------------------------------------------------------------
  // 26. Margin Calculator (pre-trade accuracy)
  // ---------------------------------------------------------------------------

  /**
   * Calculate the exact margin required for one or more instruments.
   *
   * Maps to POST /v2/margincalculator.
   *
   * Use this BEFORE `placeOrder()` for accurate pre-trade margin checks instead
   * of the naive `entryPrice × quantityUnits` approximation currently used in
   * SignalDispatcherService.
   *
   * Requirements: P2-MED-002 — replace hardcoded requiredMargin approximation.
   */
  async calculateMargin(
    request: DhanMarginCalculatorRequest,
  ): Promise<DhanMarginCalculatorResponse> {
    return this.request<DhanMarginCalculatorResponse>('POST', '/v2/margincalculator', request);
  }

  // ---------------------------------------------------------------------------
  // Rolling / Expired Options Historical Data
  // ---------------------------------------------------------------------------

  /**
   * Fetch rolling ATM-relative historical option data.
   *
   * Maps to POST /v2/charts/rollingoption.
   *
   * Returns up to 30 days of historical OHLCV, IV, OI and spot data for an
   * option contract defined by its ATM-relative strike offset and expiry type.
   * Data is "rolling": at each candle the ATM strike is the nearest available
   * strike to the underlying spot at that timestamp, and the requested offset
   * (e.g. ATM-2) describes the position relative to that rolling ATM.
   *
   * Key constraints:
   *   - Window per request: maximum 30 calendar days (toDate is non-inclusive).
   *   - Index options (OPTIDX): strike range ATM-10 to ATM+10.
   *   - Stock options (OPTSTK): strike range ATM-3 to ATM+3.
   *   - Intervals supported: 1, 5, 15, 25, 60 minutes.
   *   - History available: up to 5 years (Dhan documentation claim; validate empirically).
   *
   * Include 'strike' in requiredData to get the absolute strike per candle,
   * and 'spot' to get the underlying price — both are essential for backtesting.
   *
   * Official docs: https://dhanhq.co/docs/v2/expired-options-data/
   */
  async getRollingOptionData(
    request: DhanRollingOptionRequest,
  ): Promise<DhanRollingOptionResponse> {
    return this.request<DhanRollingOptionResponse>(
      'POST',
      '/v2/charts/rollingoption',
      request,
      true, // client-id required (same as getLtp/getOhlcSnapshot)
    );
  }
}

// NOTE: calculateMargin and getOrderByCorrelationId added below the class
// via module augmentation workaround — using direct addition to the existing
// DhanApiClient class is cleaner. See src/modules/dhan/dhan-api.client.ts
// for the getOrderByCorrelationId method already added above.
