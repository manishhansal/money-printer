import React from 'react';

export interface SignalItem {
  signal: {
    id: string;
    direction: 'BUY' | 'SELL';
    entryPrice: string;
    stopLossPrice: string;
    targetPrice: string;
    positionSize: number;
    compositeScore: string;
    status: string;
    regime: string | null;
    signalTimestamp: string;
    strategy?: { code: string };
  };
  rank: number;
  expectedValue?: number;
}

interface SignalListProps {
  signals: SignalItem[];
}

export function SignalList({ signals }: SignalListProps): React.ReactElement {
  if (!signals.length) {
    return (
      <div
        style={{
          color: '#4b6080',
          fontSize: 11,
          textAlign: 'center',
          padding: '12px 0',
          fontFamily: 'monospace',
        }}
      >
        No active signals
      </div>
    );
  }

  return (
    <div>
      {signals.slice(0, 20).map((item) => {
        const { signal } = item;
        const score = parseFloat(signal.compositeScore);
        const scoreColor = score >= 90 ? '#22c55e' : score >= 80 ? '#f59e0b' : '#ef4444';
        const dirColor = signal.direction === 'BUY' ? '#22c55e' : '#ef4444';
        const ts = new Date(signal.signalTimestamp).toLocaleTimeString('en-IN', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
        });

        return (
          <div
            key={signal.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 0',
              borderBottom: '1px solid #1a2235',
              fontFamily: 'monospace',
              fontSize: 11,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontWeight: 700, color: '#3b82f6' }}>
                  {signal.strategy?.code ?? '?'}
                </span>
                <span style={{ color: dirColor, fontSize: 10 }}>{signal.direction}</span>
                <span
                  style={{
                    fontSize: 9,
                    padding: '1px 4px',
                    borderRadius: 2,
                    background: '#1a2235',
                    color: signal.status === 'active' ? '#22c55e' : '#4b6080',
                  }}
                >
                  {signal.status}
                </span>
              </div>
              <div style={{ color: '#4b6080', fontSize: 10, marginTop: 1 }}>
                ₹{parseFloat(signal.entryPrice).toFixed(1)} · R:R{' '}
                {item.expectedValue?.toFixed(1) ?? '—'} · {ts}
              </div>
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: scoreColor,
                minWidth: 32,
                textAlign: 'right',
              }}
            >
              {score.toFixed(0)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
