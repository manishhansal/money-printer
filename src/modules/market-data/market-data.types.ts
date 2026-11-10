/**
 * market-data.types.ts
 *
 * Shared types, event constants, and payload interfaces for the
 * MarketDataModule feed-staleness sub-system.
 *
 * These event names are consumed by:
 *  - RiskEngine (task 16) — MARKET_DATA_STALE_EVENT → block new order submissions
 *  - RiskEngine (task 16) — MARKET_DATA_FRESH_EVENT → unblock new order submissions
 *
 * Requirements: 9.6, 18.7
 */

// ─────────────────────────────────────────────────────────────────────────────
// Market data snapshot (Requirements: 18.7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Live market data snapshot for a single instrument.
 *
 * All price/volume fields are strings to preserve decimal precision
 * across boundaries without floating-point rounding. `null` values
 * indicate the field was not present in the feed tick (e.g. no open
 * interest for equity indices).
 *
 * Stored as `mkt:snapshot:{instrument_id}` in Redis (TTL: 2 s).
 */
export interface MarketSnapshot {
  /** Last traded price */
  ltp: string;
  /** Best bid price — null if not available */
  bidPrice: string | null;
  /** Best ask price — null if not available */
  askPrice: string | null;
  /** Total traded volume for the session */
  volume: string;
  /** Open interest — null for non-derivative instruments */
  oi: string | null;
  /** Unix epoch milliseconds when this tick was received */
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// NestJS event constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emitted when the market data feed age exceeds `max_allowed_data_age`.
 * RiskEngine subscribes to this event to block new order submissions.
 *
 * Payload: MarketDataStaleEvent
 */
export const MARKET_DATA_STALE_EVENT = 'market.data.stale';

/**
 * Emitted when fresh market data is received after a period of staleness.
 * RiskEngine subscribes to this event to unblock new order submissions.
 *
 * Payload: MarketDataFreshEvent
 */
export const MARKET_DATA_FRESH_EVENT = 'market.data.fresh';

/**
 * Emitted (or listened for) when a market data tick arrives from the
 * Dhan WebSocket feed. MarketDataService updates lastTickReceivedAt
 * on every occurrence.
 *
 * The WebSocket client (task 6.1) is responsible for emitting this event
 * on each incoming tick.
 */
export const MARKET_TICK_RECEIVED_EVENT = 'market.tick.received';

// ─────────────────────────────────────────────────────────────────────────────
// Event payload interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload for the `market.data.stale` NestJS event.
 *
 * Consumers (e.g. RiskEngine) use dataAgeMs and maxAllowedMs to log the
 * specific reason for blocking new orders.
 */
export interface MarketDataStaleEvent {
  /** Milliseconds since the last received market data tick. */
  dataAgeMs: number;
  /** Configured maximum allowed data age in milliseconds. */
  maxAllowedMs: number;
  /** UTC timestamp when staleness was first detected. */
  detectedAt: Date;
}

/**
 * Payload for the `market.data.fresh` NestJS event.
 */
export interface MarketDataFreshEvent {
  /** UTC timestamp when data freshness was confirmed after a stale period. */
  detectedAt: Date;
}
