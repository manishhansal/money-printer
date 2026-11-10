/**
 * sidepanel.test.ts
 *
 * Unit tests for the MoneyPrinter Side Panel (Requirement 1.1).
 *
 * All tests exercise pure business-logic exports from sidepanel.ts and
 * require no DOM or Chrome runtime — the test environment is Node.js.
 */

import {
  resetState,
  updateSignalFeed,
  addToAlertQueue,
  acknowledgeAlert,
  updatePosition,
  getPnlColorClass,
  getSignalStatusText,
  signalFeed,
  alertQueue,
  positions,
  MAX_SIGNAL_FEED_SIZE,
  type Signal,
  type Alert,
  type Position,
} from './sidepanel';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: `sig-${Math.random().toString(36).slice(2)}`,
    strategyCode: 'ORB_CALL',
    score: 75,
    status: 'active',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: `alert-${Math.random().toString(36).slice(2)}`,
    priority: 'MAX',
    title: 'SL Rejection Escalation',
    message: '3 consecutive broker-side SL rejections for NIFTY23D2122000CE',
    acknowledged: false,
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: `pos-${Math.random().toString(36).slice(2)}`,
    symbol: 'NIFTY23D21 22000 CE',
    entryPrice: 120.5,
    currentPrice: 135.0,
    unrealizedPnl: 1450.0,
    direction: 'LONG',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset state before every test for isolation
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetState();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Signal feed truncated to last 10 signals
// ─────────────────────────────────────────────────────────────────────────────

test('signal feed is truncated to the last 10 signals', () => {
  // Build 12 signals with distinct, incrementing timestamps so ordering is
  // deterministic regardless of insertion order.
  const baseTime = new Date('2024-01-01T09:00:00.000Z').getTime();
  const signals: Signal[] = Array.from({ length: 12 }, (_, i) =>
    makeSignal({
      id: `sig-${i}`,
      timestamp: new Date(baseTime + i * 1000),
    }),
  );

  updateSignalFeed(signals);

  // The module-level export reflects the updated state.
  expect(signalFeed.length).toBe(MAX_SIGNAL_FEED_SIZE);
  expect(signalFeed.length).toBe(10);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Signals ordered newest-first
// ─────────────────────────────────────────────────────────────────────────────

test('signals are ordered newest-first after updateSignalFeed', () => {
  const t1 = new Date('2024-01-01T09:00:00.000Z');
  const t2 = new Date('2024-01-01T09:01:00.000Z');
  const t3 = new Date('2024-01-01T09:02:00.000Z');

  // Insert intentionally out-of-order.
  updateSignalFeed([
    makeSignal({ id: 'old', timestamp: t1 }),
    makeSignal({ id: 'newest', timestamp: t3 }),
    makeSignal({ id: 'mid', timestamp: t2 }),
  ]);

  expect(signalFeed[0].id).toBe('newest');
  expect(signalFeed[1].id).toBe('mid');
  expect(signalFeed[2].id).toBe('old');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: MAX-priority alerts are added to the alert queue
// ─────────────────────────────────────────────────────────────────────────────

test('MAX-priority alert is added to the alert queue', () => {
  const alert = makeAlert({ id: 'max-1', priority: 'MAX' });
  addToAlertQueue(alert);

  expect(alertQueue).toHaveLength(1);
  expect(alertQueue[0].id).toBe('max-1');
  expect(alertQueue[0].priority).toBe('MAX');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: INFO alerts are NOT shown in the alert queue
// ─────────────────────────────────────────────────────────────────────────────

test('INFO alert is not added to the alert queue', () => {
  const infoAlert = makeAlert({ id: 'info-1', priority: 'INFO' });
  const warnAlert = makeAlert({ id: 'warn-1', priority: 'WARNING' });
  const critAlert = makeAlert({ id: 'crit-1', priority: 'CRITICAL' });

  addToAlertQueue(infoAlert);
  addToAlertQueue(warnAlert);
  addToAlertQueue(critAlert);

  // None of the non-MAX alerts should be present.
  expect(alertQueue).toHaveLength(0);
  expect(alertQueue.find((a) => a.id === 'info-1')).toBeUndefined();
  expect(alertQueue.find((a) => a.id === 'warn-1')).toBeUndefined();
  expect(alertQueue.find((a) => a.id === 'crit-1')).toBeUndefined();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Acknowledging an alert removes it from the queue
// ─────────────────────────────────────────────────────────────────────────────

test('acknowledgeAlert removes the alert from the queue', () => {
  const a1 = makeAlert({ id: 'alert-a', priority: 'MAX' });
  const a2 = makeAlert({ id: 'alert-b', priority: 'MAX' });

  addToAlertQueue(a1);
  addToAlertQueue(a2);
  expect(alertQueue).toHaveLength(2);

  acknowledgeAlert('alert-a');

  expect(alertQueue).toHaveLength(1);
  expect(alertQueue[0].id).toBe('alert-b');
  expect(alertQueue.find((a) => a.id === 'alert-a')).toBeUndefined();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Position P&L CSS class — green for positive, red for negative
// ─────────────────────────────────────────────────────────────────────────────

test('getPnlColorClass returns pnl-positive for positive P&L and pnl-negative for negative P&L', () => {
  // Positive P&L → green class
  expect(getPnlColorClass(1450.0)).toBe('pnl-positive');
  expect(getPnlColorClass(0.01)).toBe('pnl-positive');

  // Zero is treated as non-negative → green class
  expect(getPnlColorClass(0)).toBe('pnl-positive');

  // Negative P&L → red class
  expect(getPnlColorClass(-500.0)).toBe('pnl-negative');
  expect(getPnlColorClass(-0.01)).toBe('pnl-negative');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Real-time P&L update updates the existing position row (no duplicate)
// ─────────────────────────────────────────────────────────────────────────────

test('updatePosition updates the existing position entry without duplicating it', () => {
  const posId = 'pos-nifty-ce';

  const initial = makePosition({ id: posId, currentPrice: 120.0, unrealizedPnl: 500.0 });
  updatePosition(initial);
  expect(positions.size).toBe(1);
  expect(positions.get(posId)?.unrealizedPnl).toBe(500.0);

  // Simulate a real-time P&L tick — same id, new price and P&L.
  const updated = makePosition({ id: posId, currentPrice: 135.0, unrealizedPnl: 1450.0 });
  updatePosition(updated);

  // Still exactly one entry.
  expect(positions.size).toBe(1);
  // The entry now carries the updated values.
  expect(positions.get(posId)?.currentPrice).toBe(135.0);
  expect(positions.get(posId)?.unrealizedPnl).toBe(1450.0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: Signal with 'rejected' status shows rejection reason
// ─────────────────────────────────────────────────────────────────────────────

test('getSignalStatusText returns rejection reason for rejected signals', () => {
  const rejectedSignal = makeSignal({
    status: 'rejected',
    rejectionReason: 'Score below threshold (42 < 60)',
  });

  const text = getSignalStatusText(rejectedSignal);

  expect(text).toContain('Rejected');
  expect(text).toContain('Score below threshold (42 < 60)');
  expect(text).toBe('Rejected: Score below threshold (42 < 60)');
});

test('getSignalStatusText returns plain status for non-rejected signals', () => {
  expect(getSignalStatusText(makeSignal({ status: 'active' }))).toBe('active');
  expect(getSignalStatusText(makeSignal({ status: 'expired' }))).toBe('expired');
});
