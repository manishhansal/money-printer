import React from 'react';

export interface EngineStats {
  netPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  balance: string;
  tradeCount: number;
  openPositions: number;
  drawdown: number;
}

interface EngineCardProps {
  label: string;
  color: string; // '#00d4aa' for paper, '#3b82f6' for live
  stats: EngineStats | null;
  badge?: React.ReactNode;
}

function fmt(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n >= 0 ? '+' : '-'}₹${abs}`;
}

export function EngineCard({ label, color, stats, badge }: EngineCardProps): React.ReactElement {
  const pnl = stats?.netPnl ?? 0;
  const pnlColor = pnl > 0 ? '#22c55e' : pnl < 0 ? '#ef4444' : '#4b6080';

  return (
    <div
      style={{
        background: '#131720',
        border: `1px solid ${color}44`,
        borderTop: `2px solid ${color}`,
        borderRadius: 4,
        padding: '12px 16px',
        minWidth: 200,
        flex: '1 1 200px',
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 3,
            color,
            fontFamily: 'monospace',
          }}
        >
          {label}
        </span>
        {badge}
      </div>

      {/* Main P&L */}
      <div style={{ fontSize: 24, fontWeight: 700, color: pnlColor, lineHeight: 1 }}>
        {fmt(pnl)}
      </div>
      <div style={{ fontSize: 10, color: '#4b6080', marginTop: 2 }}>
        Balance: {stats?.balance ?? '—'}
      </div>

      {/* Stats row */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          marginTop: 10,
          paddingTop: 8,
          borderTop: '1px solid #1a2235',
        }}
      >
        {[
          { v: stats?.openPositions ?? 0, l: 'Positions' },
          { v: stats?.tradeCount ?? 0, l: 'Trades' },
          {
            v: `${((stats?.drawdown ?? 0) * 100).toFixed(1)}%`,
            l: 'Drawdown',
            red: (stats?.drawdown ?? 0) < -0.01,
          },
        ].map(({ v, l, red }) => (
          <div key={l} style={{ textAlign: 'center' }}>
            <div
              style={{
                fontSize: 16,
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
