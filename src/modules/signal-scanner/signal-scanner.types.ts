/**
 * signal-scanner.types.ts
 *
 * Shared types for the SignalScannerModule.
 *
 * The scanner evaluates live market snapshots against the strategy pipeline
 * and routes accepted signals to paper or live execution.
 */

/** NestJS event emitted by PipelineWiringService after a signal is scored ≥ 80. */
export const SIGNAL_ACCEPTED_EVENT = 'signal.accepted';

/**
 * Payload for the `signal.accepted` event.
 *
 * Contains everything needed to build an order request for either
 * PaperTradingService or ExecutionService without additional DB lookups.
 */
export interface SignalAcceptedEventPayload {
  /** UUID from the signals table. */
  signalId: string;
  /** UUID of the originating strategy. */
  strategyId: string;
  /** UUID of the target instrument (instruments.id). */
  instrumentId: string;
  /**
   * Dhan platform security ID (instruments.securityId).
   * Used by PaperTradingService to look up `mkt:snapshot:{securityId}`
   * since Redis snapshots are keyed by security ID, not DB UUID.
   */
  securityId: string;
  /** Engine context — 'LIVE' or 'PAPER'. */
  engine: 'LIVE' | 'PAPER';
  /** Trade direction. */
  direction: 'BUY' | 'SELL';
  /** Entry price (INR string). */
  entryPrice: string;
  /** Stop-loss price (INR string). */
  stopLossPrice: string;
  /** Target price (INR string). */
  targetPrice: string;
  /** Proposed position size in lots. */
  positionSize: number;
  /** Final composite score (0–100). */
  compositeScore: number;
  /** Active market regime at signal time. */
  regime: string | null;
}
