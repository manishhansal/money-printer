import React from 'react';
import { useApi } from '../hooks/useApi';

interface RiskMetrics {
  engine: string;
  dailyLossState: string;
  losingTradeCount: number;
  dailyLossLimitRupees: number;
  currentDailyLoss: number;
  openPositionsCount: number;
  maxConcurrentTrades: number;
}

function StatusBadge({ state }: { state: string }): React.ReactElement {
  const color =
    state === 'NORMAL' ? '#22c55e' : state === 'TWO_LOSS_LOCKOUT' ? '#f59e0b' : '#ef4444';

  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        padding: '2px 6px',
        borderRadius: 3,
        background: `${color}22`,
        color,
        border: `1px solid ${color}44`,
        letterSpacing: 1,
        fontFamily: 'monospace',
      }}
    >
      {state}
    </span>
  );
}

interface MetricRowProps {
  label: string;
  value: React.ReactNode;
}
function MetricRow({ label, value }: MetricRowProps): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '4px 0',
        borderBottom: '1px solid #1a2235',
        fontSize: 11,
        fontFamily: 'monospace',
      }}
    >
      <span style={{ color: '#4b6080' }}>{label}</span>
      <span style={{ color: '#dde4f0', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

export function RiskCenter(): React.ReactElement {
  const { data: live } = useApi<RiskMetrics>('/risk/state/LIVE', 5_000);
  const { data: paper } = useApi<RiskMetrics>('/risk/state/PAPER', 5_000);

  return (
    <div>
      {[
        { label: '📄 Paper', data: paper },
        { label: '🔴 Live', data: live },
      ].map(({ label, data }) => (
        <div key={label} style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#4b6080',
              letterSpacing: 2,
              textTransform: 'uppercase',
              marginBottom: 6,
              fontFamily: 'monospace',
            }}
          >
            {label}
          </div>
          {data ? (
            <>
              <MetricRow label="State" value={<StatusBadge state={data.dailyLossState} />} />
              <MetricRow label="Losing trades today" value={`${data.losingTradeCount} / 2`} />
              <MetricRow
                label="Daily loss"
                value={
                  <span style={{ color: data.currentDailyLoss > 0 ? '#ef4444' : '#22c55e' }}>
                    ₹{data.currentDailyLoss.toFixed(0)} / ₹{data.dailyLossLimitRupees.toFixed(0)}
                  </span>
                }
              />
              <MetricRow
                label="Open positions"
                value={`${data.openPositionsCount} / ${data.maxConcurrentTrades}`}
              />
            </>
          ) : (
            <div style={{ color: '#4b6080', fontSize: 10, fontFamily: 'monospace' }}>Loading…</div>
          )}
        </div>
      ))}
    </div>
  );
}
