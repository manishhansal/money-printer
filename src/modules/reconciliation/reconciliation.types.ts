/**
 * reconciliation.types.ts
 *
 * Shared types and interfaces for the ReconciliationModule.
 *
 * Requirements: 12.4, 17.6, 19.1, 19.2, 19.3
 */

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle status of a reconciliation run.
 */
export enum ReconciliationStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  /** The run was aborted because it did not complete within its time budget. */
  TIMEOUT = 'TIMEOUT',
}

/**
 * Trigger source of a reconciliation run.
 */
export enum ReconciliationType {
  /** Scheduled End-of-Day run at 15:30 IST (Requirement 17.6, 19.1). */
  EOD = 'EOD',
  /** Triggered immediately on DhanAPI reconnection (Requirement 19.3). */
  RECONNECTION = 'RECONNECTION',
}

/**
 * Category of a detected discrepancy.
 */
export enum DiscrepancyType {
  /**
   * A CloudEngine order with a dhan_order_id that cannot be found in the
   * Dhan orderbook (Requirement 19.1).
   */
  ORDER_NOT_FOUND_IN_DHAN = 'ORDER_NOT_FOUND_IN_DHAN',
  /**
   * Net position quantity or instrument differs between CloudEngine and Dhan
   * (Requirements 17.6, 19.2).
   */
  POSITION_MISMATCH = 'POSITION_MISMATCH',
  /**
   * Dhan reports a fill whose orderId does not match any CloudEngine order
   * (Requirement 19.5).
   */
  UNRECOGNIZED_EXECUTION = 'UNRECOGNIZED_EXECUTION',
  /**
   * CloudEngine net P&L, Dhan broker P&L, and CapitalLedger are not within
   * the ₹1 tolerance (Requirement 19.6).
   */
  PNL_MISMATCH = 'PNL_MISMATCH',
}

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metadata record for a single reconciliation run.
 * Persisted to AuditLogs on every execution (Requirement 19.4).
 */
export interface ReconciliationRun {
  /** UUID for this run — used as the reconciliationId for acknowledgment. */
  id: string;
  /** Whether this was an EOD or reconnection-triggered run. */
  type: ReconciliationType;
  /** UTC timestamp when the run began. */
  startedAt: Date;
  /** UTC timestamp when the run finished (undefined if still running). */
  completedAt?: Date;
  /** Final status of the run. */
  status: ReconciliationStatus;
  /** Total number of discrepancies detected. */
  discrepanciesFound: number;
  /** Optional free-text notes (e.g. timeout message, error detail). */
  notes?: string;
}

/**
 * A single detected discrepancy between CloudEngine state and Dhan broker state.
 */
export interface DiscrepancyRecord {
  /** Category of the discrepancy. */
  type: DiscrepancyType;
  /** Dhan platform order ID involved (if applicable). */
  dhanOrderId?: string;
  /** CloudEngine internal order UUID involved (if applicable). */
  cloudOrderId?: string;
  /** Human-readable explanation of why this was flagged. */
  reason: string;
  /** Arbitrary structured context for the discrepancy. */
  details?: Record<string, unknown>;
}

/**
 * Result of a P&L agreement check (Requirement 19.6).
 *
 * Returned by `ReconciliationService.verifyPnlAgreement()`.
 */
export interface PnlAgreementResult {
  /** True when all three P&L values agree within ₹1.00 tolerance. */
  agreement: boolean;
  /**
   * Human-readable description of the first detected discrepancy.
   * Present only when `agreement` is false.
   */
  discrepancy?: string;
}

/**
 * Result returned by `verifySLStatusAfterReconnect`.
 * Requirement 12.4 — ReconciliationService reports SL discrepancies to TrailingStopEngine.
 */
export interface SLVerificationResult {
  /**
   * Position IDs whose broker-side SL order was found active in the Dhan orderbook.
   */
  verified: string[];
  /**
   * Position IDs whose broker-side SL order was not found, was cancelled,
   * rejected, or expired in the Dhan orderbook.
   */
  inactive: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Error types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown internally when a timed reconciliation operation exceeds its budget.
 * Used as a sentinel in Promise.race so the caller can distinguish a genuine
 * reconciliation error from a timeout.
 */
export class ReconciliationTimeoutError extends Error {
  constructor(operationName: string, timeoutMs: number) {
    super(`Reconciliation operation "${operationName}" timed out after ${timeoutMs} ms`);
    this.name = 'ReconciliationTimeoutError';
  }
}
