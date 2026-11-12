/**
 * dashboard.test.ts
 *
 * Unit tests for the MoneyPrinter Full Dashboard (Requirements 1.1, 14.1, 20.6).
 *
 * All tests exercise pure business-logic exports and state management from
 * dashboard.ts without requiring a DOM or Chrome runtime.
 */

import {
  resetDashboardState,
  renderDashboard,
  handleWebSocketMessage,
  getAlerts,
  getOptionsFlowStaleClass,
  strategyPerformance,
  capitalHistory,
  regimeHeatmap,
  optionsFlow,
  alerts,
  type PerformanceRow,
  type RegimeHeatmapEntry,
  type CapitalDataPoint,
  type OptionsFlowRow,
  type AlertItem,
  type DashboardState,
} from './dashboard';

// ─────────────────────────────────────────────────────────────────────────────
// Test-data factories
// ─────────────────────────────────────────────────────────────────────────────

function makePerformanceRow(overrides: Partial<PerformanceRow> = {}): PerformanceRow {
  return {
    strategyCode: 'ORB_CALL',
    winRate: 0.65,
    expectancy: 1.2,
    netPnl: 5000,
    trades: 20,
    ...overrides,
  };
}

function makeRegimeEntry(overrides: Partial<RegimeHeatmapEntry> = {}): RegimeHeatmapEntry {
  return {
    regime: 'TRENDING_UP',
    signalCount: 10,
    ...overrides,
  };
}

function makeCapitalDataPoint(overrides: Partial<CapitalDataPoint> = {}): CapitalDataPoint {
  return {
    date: '2024-01-01',
    capital: 100000,
    ...overrides,
  };
}

function makeOptionsFlowRow(overrides: Partial<OptionsFlowRow> = {}): OptionsFlowRow {
  return {
    symbol: 'NIFTY',
    netOiChange: 5000,
    putCallRatio: 1.2,
    ivSkew: 0.05,
    largeBlock: false,
    isStale: false,
    ...overrides,
  };
}

function makeAlert(overrides: Partial<AlertItem> = {}): AlertItem {
  return {
    id: `alert-${Math.random().toString(36).slice(2)}`,
    priority: 'MAX',
    title: 'Test Alert',
    message: 'Test alert message',
    ...overrides,
  };
}

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    strategyPerformance: [],
    capitalHistory: [],
    regimeHeatmap: [],
    optionsFlow: [],
    alerts: [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Isolation: reset all state before every test
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetDashboardState();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Strategy performance table renders with correct number of rows
// ─────────────────────────────────────────────────────────────────────────────

test('strategy performance table renders with the correct number of rows', () => {
  const rows = [
    makePerformanceRow({ strategyCode: 'ORB_CALL' }),
    makePerformanceRow({ strategyCode: 'ORB_PUT' }),
    makePerformanceRow({ strategyCode: 'GAP_FADE' }),
  ];

  renderDashboard(makeState({ strategyPerformance: rows }));

  expect(strategyPerformance).toHaveLength(3);
  expect(strategyPerformance[0].strategyCode).toBe('ORB_CALL');
  expect(strategyPerformance[1].strategyCode).toBe('ORB_PUT');
  expect(strategyPerformance[2].strategyCode).toBe('GAP_FADE');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Capital chart data points render in order
// ─────────────────────────────────────────────────────────────────────────────

test('capital chart data points are retained in the order they were provided', () => {
  const points: CapitalDataPoint[] = [
    { date: '2024-01-01', capital: 100000 },
    { date: '2024-01-02', capital: 102500 },
    { date: '2024-01-03', capital: 101000 },
    { date: '2024-01-04', capital: 105000 },
  ];

  renderDashboard(makeState({ capitalHistory: points }));

  expect(capitalHistory).toHaveLength(4);
  expect(capitalHistory[0].date).toBe('2024-01-01');
  expect(capitalHistory[1].date).toBe('2024-01-02');
  expect(capitalHistory[2].date).toBe('2024-01-03');
  expect(capitalHistory[3].date).toBe('2024-01-04');
  expect(capitalHistory.map((p) => p.capital)).toEqual([100000, 102500, 101000, 105000]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Regime heatmap sorted by signal count descending
// ─────────────────────────────────────────────────────────────────────────────

test('regime heatmap is sorted by signal count descending after renderDashboard', () => {
  const unsortedRegimes: RegimeHeatmapEntry[] = [
    { regime: 'CHOPPY', signalCount: 3 },
    { regime: 'TRENDING_UP', signalCount: 15 },
    { regime: 'HIGH_VOLATILITY', signalCount: 8 },
    { regime: 'TRENDING_DOWN', signalCount: 12 },
  ];

  renderDashboard(makeState({ regimeHeatmap: unsortedRegimes }));

  // Highest signal count first
  expect(regimeHeatmap[0].regime).toBe('TRENDING_UP');
  expect(regimeHeatmap[0].signalCount).toBe(15);
  expect(regimeHeatmap[1].regime).toBe('TRENDING_DOWN');
  expect(regimeHeatmap[1].signalCount).toBe(12);
  expect(regimeHeatmap[2].regime).toBe('HIGH_VOLATILITY');
  expect(regimeHeatmap[2].signalCount).toBe(8);
  expect(regimeHeatmap[3].regime).toBe('CHOPPY');
  expect(regimeHeatmap[3].signalCount).toBe(3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Options Flow row shows stale indicator when isStale=true
// ─────────────────────────────────────────────────────────────────────────────

test('options flow row carries stale CSS class when isStale is true', () => {
  // Pure helper used by the DOM renderer
  expect(getOptionsFlowStaleClass(true)).toBe('options-flow-stale');
  expect(getOptionsFlowStaleClass(false)).toBe('');

  // Verify the isStale flag is preserved in module state after renderDashboard
  const staleRow = makeOptionsFlowRow({ symbol: 'BANKNIFTY', isStale: true });
  const freshRow = makeOptionsFlowRow({ symbol: 'NIFTY', isStale: false });

  renderDashboard(makeState({ optionsFlow: [staleRow, freshRow] }));

  expect(optionsFlow[0].symbol).toBe('BANKNIFTY');
  expect(optionsFlow[0].isStale).toBe(true);
  expect(optionsFlow[1].symbol).toBe('NIFTY');
  expect(optionsFlow[1].isStale).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: WebSocket 'PERFORMANCE_UPDATE' updates strategyPerformance
// ─────────────────────────────────────────────────────────────────────────────

test("WebSocket 'PERFORMANCE_UPDATE' message replaces strategyPerformance state", () => {
  const updatedRows: PerformanceRow[] = [
    makePerformanceRow({ strategyCode: 'ORB_CALL', winRate: 0.7, netPnl: 8500, trades: 25 }),
    makePerformanceRow({ strategyCode: 'VWAP_REVERSION', winRate: 0.6, netPnl: 3200, trades: 18 }),
  ];

  handleWebSocketMessage({ type: 'PERFORMANCE_UPDATE', payload: updatedRows });

  expect(strategyPerformance).toHaveLength(2);
  expect(strategyPerformance[0].strategyCode).toBe('ORB_CALL');
  expect(strategyPerformance[0].winRate).toBe(0.7);
  expect(strategyPerformance[0].netPnl).toBe(8500);
  expect(strategyPerformance[1].strategyCode).toBe('VWAP_REVERSION');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: WebSocket 'ALERT' adds to alerts array
// ─────────────────────────────────────────────────────────────────────────────

test("WebSocket 'ALERT' message appends the alert to the alerts array", () => {
  expect(getAlerts()).toHaveLength(0);

  const firstAlert = makeAlert({
    id: 'ws-alert-1',
    priority: 'MAX',
    title: 'Kill Switch Triggered',
  });
  handleWebSocketMessage({ type: 'ALERT', payload: firstAlert });

  const afterFirst = getAlerts();
  expect(afterFirst).toHaveLength(1);
  expect(afterFirst[0].id).toBe('ws-alert-1');
  expect(afterFirst[0].title).toBe('Kill Switch Triggered');

  // A second ALERT message appends without replacing
  handleWebSocketMessage({
    type: 'ALERT',
    payload: makeAlert({ id: 'ws-alert-2', priority: 'CRITICAL' }),
  });
  expect(getAlerts()).toHaveLength(2);
  expect(getAlerts()[1].id).toBe('ws-alert-2');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Unknown WebSocket message type is ignored gracefully
// ─────────────────────────────────────────────────────────────────────────────

test('unknown WebSocket message type does not throw and leaves state unchanged', () => {
  // Pre-populate state with a PERFORMANCE_UPDATE so we can verify it stays
  handleWebSocketMessage({
    type: 'PERFORMANCE_UPDATE',
    payload: [makePerformanceRow({ strategyCode: 'ORB_CALL' })],
  });
  expect(strategyPerformance).toHaveLength(1);

  // Unknown type — must not throw
  expect(() => {
    handleWebSocketMessage({ type: 'UNKNOWN_EVENT_TYPE', payload: { foo: 'bar' } });
  }).not.toThrow();

  // All state arrays remain unchanged
  expect(strategyPerformance).toHaveLength(1);
  expect(capitalHistory).toHaveLength(0);
  expect(regimeHeatmap).toHaveLength(0);
  expect(optionsFlow).toHaveLength(0);
  expect(alerts).toHaveLength(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: resetDashboardState clears all data
// ─────────────────────────────────────────────────────────────────────────────

test('resetDashboardState clears every dashboard state array', () => {
  // Populate all panels
  renderDashboard({
    strategyPerformance: [makePerformanceRow()],
    capitalHistory: [makeCapitalDataPoint()],
    regimeHeatmap: [makeRegimeEntry()],
    optionsFlow: [makeOptionsFlowRow()],
    alerts: [makeAlert()],
  });

  expect(strategyPerformance).toHaveLength(1);
  expect(capitalHistory).toHaveLength(1);
  expect(regimeHeatmap).toHaveLength(1);
  expect(optionsFlow).toHaveLength(1);
  expect(alerts).toHaveLength(1);

  resetDashboardState();

  expect(strategyPerformance).toHaveLength(0);
  expect(capitalHistory).toHaveLength(0);
  expect(regimeHeatmap).toHaveLength(0);
  expect(optionsFlow).toHaveLength(0);
  expect(alerts).toHaveLength(0);
  expect(getAlerts()).toHaveLength(0);
});
