import React from 'react';
import { useApi } from '../hooks/useApi';

interface HealthInfo {
  status: string;
  info?: Record<string, { status: string; message?: string }>;
}

interface DebugStats {
  signalEvals?: number;
  paperOrders?: number;
  paperFills?: number;
  instruments?: number;
  lastScanAt?: string;
  backendUptimeSeconds?: number;
}

function HealthRow({
  name,
  status,
  detail,
}: {
  name: string;
  status: string;
  detail?: string;
}): React.ReactElement {
  const ok = status === 'up';
  const color = ok ? '#22c55e' : '#ef4444';

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '3px 0',
        borderBottom: '1px solid #1a2235',
        fontSize: 10,
        fontFamily: 'monospace',
      }}
    >
      <span style={{ color: '#4b6080' }}>{name}</span>
      <span style={{ color, fontWeight: 700 }}>{ok ? '✓ OK' : (detail ?? '✗ ERROR')}</span>
    </div>
  );
}

export function SystemHealth(): React.ReactElement {
  const { data: health } = useApi<HealthInfo>('/health', 10_000);
  const { data: stats } = useApi<DebugStats>('/debug/stats', 10_000);

  const checks = health?.info ?? {};

  return (
    <div>
      {Object.entries(checks).map(([key, v]) => (
        <HealthRow key={key} name={key.replace(/_/g, ' ')} status={v.status} detail={v.message} />
      ))}
      {stats && (
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid #1a2235' }}>
          {[
            { l: 'Signal evaluations', v: stats.signalEvals?.toLocaleString() ?? '—' },
            { l: 'Paper orders', v: stats.paperOrders?.toLocaleString() ?? '—' },
            { l: 'Paper fills', v: stats.paperFills?.toLocaleString() ?? '—' },
            { l: 'Instruments', v: stats.instruments?.toLocaleString() ?? '—' },
          ].map(({ l, v }) => (
            <div
              key={l}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 10,
                color: '#4b6080',
                fontFamily: 'monospace',
                padding: '2px 0',
              }}
            >
              <span>{l}</span>
              <span style={{ color: '#dde4f0' }}>{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
