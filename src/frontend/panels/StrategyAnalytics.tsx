import React from 'react';
import { useApi } from '../hooks/useApi';

interface PerformanceMetrics {
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgWinner: number;
  avgLoser: number;
  expectancy: number;
  profitFactor: number | string;
  maxDrawdown: number;
  netPnl: number;
  grossPnl: number;
  totalCharges: number;
}

type Engines = 'LIVE' | 'PAPER';

function MetricsGrid({
  metrics,
  engine,
}: {
  metrics: PerformanceMetrics;
  engine: Engines;
}): React.ReactElement {
  const accent = engine === 'LIVE' ? '#3b82f6' : '#00d4aa';
  const pnlColor = metrics.netPnl > 0 ? '#22c55e' : metrics.netPnl < 0 ? '#ef4444' : '#4b6080';

  const items = [
    { l: 'Trades', v: metrics.tradeCount },
    { l: 'Win Rate', v: `${(metrics.winRate * 100).toFixed(1)}%` },
    { l: 'Avg Winner', v: `₹${metrics.avgWinner.toFixed(0)}` },
    { l: 'Avg Loser', v: `₹${metrics.avgLoser.toFixed(0)}`, red: metrics.avgLoser < 0 },
    {
      l: 'Expectancy',
      v: typeof metrics.expectancy === 'number' ? metrics.expectancy.toFixed(2) : '—',
    },
    {
      l: 'Profit Factor',
      v:
        typeof metrics.profitFactor === 'number'
          ? metrics.profitFactor.toFixed(2)
          : metrics.profitFactor,
    },
    { l: 'Max Drawdown', v: `${(metrics.maxDrawdown * 100).toFixed(1)}%`, red: true },
    { l: 'Charges', v: `₹${metrics.totalCharges.toFixed(0)}` },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 3,
            color: accent,
            fontFamily: 'monospace',
          }}
        >
          {engine} ENGINE
        </span>
        <span style={{ fontSize: 20, fontWeight: 700, color: pnlColor }}>
          {metrics.netPnl >= 0 ? '+' : ''}₹{Math.abs(metrics.netPnl).toFixed(0)}
        </span>
        <span style={{ fontSize: 10, color: '#4b6080', fontFamily: 'monospace' }}>net P&L</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {items.map(({ l, v, red }) => (
          <div
            key={l}
            style={{
              background: '#0d1117',
              border: '1px solid #1a2235',
              borderRadius: 3,
              padding: '6px 8px',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: red ? '#ef4444' : '#dde4f0',
                fontFamily: 'monospace',
              }}
            >
              {v}
            </div>
            <div
              style={{
                fontSize: 9,
                color: '#4b6080',
                textTransform: 'uppercase',
                letterSpacing: 1,
                marginTop: 2,
              }}
            >
              {l}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StrategyAnalytics(): React.ReactElement {
  const { data: paperMetrics } = useApi<PerformanceMetrics>(
    '/analytics/metrics?engine=PAPER',
    30_000,
  );
  const { data: liveMetrics } = useApi<PerformanceMetrics>(
    '/analytics/metrics?engine=LIVE',
    30_000,
  );

  const empty: PerformanceMetrics = {
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    winRate: 0,
    avgWinner: 0,
    avgLoser: 0,
    expectancy: 0,
    profitFactor: '—',
    maxDrawdown: 0,
    netPnl: 0,
    grossPnl: 0,
    totalCharges: 0,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <MetricsGrid metrics={paperMetrics ?? empty} engine="PAPER" />
      <MetricsGrid metrics={liveMetrics ?? empty} engine="LIVE" />
    </div>
  );
}
