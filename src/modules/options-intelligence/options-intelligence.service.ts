/**
 * options-intelligence.service.ts
 *
 * OptionsIntelligenceService — task 11.1
 *
 * Responsibilities:
 *  - Fetch live option chain data via DhanApiClient.getOptionChain().
 *  - Extract and cache Delta, Gamma, Theta, and Vega for every CE and PE leg
 *    present in the response.
 *  - Enforce a hard 60-second staleness ceiling: getGreeks() and
 *    areGreeksFresh() both reject values older than GREEKS_MAX_AGE_MS.
 *
 * Public API:
 *  - fetchAndCacheGreeks(underlying, expiry)  — fetch + populate cache
 *  - getGreeks(securityId)                   — read from cache, null if stale
 *  - areGreeksFresh(securityId)              — true only if cached & < 60 s
 *
 * Cache storage:
 *  The in-process Map cache is keyed by the string form of DhanOptionLeg
 *  `security_id`. Each entry stores a GreekValues object whose `computedAt`
 *  field is set to the wall-clock time of the fetch call, not the individual
 *  strike parse time (all values from one fetch share the same `computedAt`).
 *
 * Configuration (via ConfigService / environment variables):
 *  - UNDERLYING_SEGMENT  — Dhan exchange segment for the underlying
 *                          (default: 'IDX_I', suitable for NSE index options)
 *
 * Requirements: 7.1
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DhanApiClient } from '../dhan/dhan-api.client';
import { DhanExchangeSegment } from '../dhan/dhan-api.types';
import { GreekValues, GREEKS_MAX_AGE_MS } from './options-intelligence.types';

@Injectable()
export class OptionsIntelligenceService {
  private readonly logger = new Logger(OptionsIntelligenceService.name);

  /**
   * In-memory Greeks cache.
   * Key:   string form of DhanOptionLeg.security_id
   * Value: GreekValues with a computedAt timestamp
   */
  private readonly greeksCache = new Map<string, GreekValues>();

  constructor(
    private readonly dhanApiClient: DhanApiClient,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetches the full option chain for the given underlying and expiry,
   * parses Delta, Gamma, Theta, and Vega from every CE and PE leg,
   * writes the results into the in-memory cache, and returns the newly
   * computed Map.
   *
   * @param underlying  String representation of the underlying security ID
   *                    (e.g. "13443" for NIFTY 50). Parsed to a number before
   *                    forwarding to the Dhan API.
   * @param expiry      Expiry date in YYYY-MM-DD format.
   * @returns           Map of securityId → GreekValues for all legs found in
   *                    the option chain response.
   *
   * Requirements: 7.1
   */
  async fetchAndCacheGreeks(underlying: string, expiry: string): Promise<Map<string, GreekValues>> {
    const underlyingScrip = parseInt(underlying, 10);
    const segment =
      this.configService.get<string>('UNDERLYING_SEGMENT') ?? ('IDX_I' as DhanExchangeSegment);

    this.logger.debug(
      `Fetching option chain: underlying=${underlying} ` + `segment=${segment} expiry=${expiry}`,
    );

    const response = await this.dhanApiClient.getOptionChain(underlyingScrip, segment, expiry);

    // All legs fetched in this call share the same computedAt timestamp,
    // ensuring the staleness clock starts from a single, consistent point.
    const computedAt = new Date();
    const result = new Map<string, GreekValues>();

    for (const strike of Object.values(response.data.oc)) {
      // Process CE leg
      if (strike.ce) {
        const leg = strike.ce;
        const securityId = String(leg.security_id);
        const greekValues: GreekValues = {
          delta: leg.greeks.delta,
          gamma: leg.greeks.gamma,
          theta: leg.greeks.theta,
          vega: leg.greeks.vega,
          computedAt,
          instrumentId: securityId,
        };
        this.greeksCache.set(securityId, greekValues);
        result.set(securityId, greekValues);
      }

      // Process PE leg
      if (strike.pe) {
        const leg = strike.pe;
        const securityId = String(leg.security_id);
        const greekValues: GreekValues = {
          delta: leg.greeks.delta,
          gamma: leg.greeks.gamma,
          theta: leg.greeks.theta,
          vega: leg.greeks.vega,
          computedAt,
          instrumentId: securityId,
        };
        this.greeksCache.set(securityId, greekValues);
        result.set(securityId, greekValues);
      }
    }

    this.logger.debug(
      `Cached Greeks for ${result.size} contracts ` +
        `(underlying=${underlying}, expiry=${expiry})`,
    );

    return result;
  }

  /**
   * Returns the cached GreekValues for the given security ID, or `null` if:
   *  - No entry exists in the cache for this securityId, OR
   *  - The cached entry's computedAt is more than GREEKS_MAX_AGE_MS (60 s) ago.
   *
   * Consumers MUST treat a null return as "Greeks unavailable" and MUST NOT
   * use stale values for contract selection (Requirement 7.1).
   *
   * @param securityId  Dhan security ID of the options contract (as a string).
   * @returns           GreekValues if cached and fresh; null otherwise.
   *
   * Requirements: 7.1
   */
  getGreeks(securityId: string): GreekValues | null {
    const cached = this.greeksCache.get(securityId);
    if (!cached) {
      return null;
    }

    const ageMs = Date.now() - cached.computedAt.getTime();
    if (ageMs > GREEKS_MAX_AGE_MS) {
      this.logger.debug(
        `Greeks for securityId=${securityId} are stale ` +
          `(age=${ageMs} ms > max=${GREEKS_MAX_AGE_MS} ms)`,
      );
      return null;
    }

    return cached;
  }

  /**
   * Returns `true` if and only if cached Greeks exist for the given security
   * ID AND were computed strictly less than GREEKS_MAX_AGE_MS (60 s) ago.
   *
   * Use this as a lightweight pre-check before calling `getGreeks()` when
   * callers want a boolean gate without needing the values themselves.
   *
   * @param securityId  Dhan security ID of the options contract (as a string).
   * @returns           true if fresh Greeks are available; false otherwise.
   *
   * Requirements: 7.1
   */
  areGreeksFresh(securityId: string): boolean {
    const cached = this.greeksCache.get(securityId);
    if (!cached) {
      return false;
    }
    return Date.now() - cached.computedAt.getTime() < GREEKS_MAX_AGE_MS;
  }
}
