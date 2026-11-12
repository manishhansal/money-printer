import React from 'react';
import { useApi } from '../hooks/useApi';
import { SignalList, SignalItem } from '../components/SignalList';

interface RankedSignalResponse {
  signals?: SignalItem[];
}

export function MarketScanner(): React.ReactElement {
  const { data, loading, refetch } = useApi<RankedSignalResponse>('/signals/ranked', 10_000);
  const signals = data?.signals ?? [];

  const btn: React.CSSProperties = {
    padding: '5px 12px',
    borderRadius: 3,
    border: '1px solid #1a2235',
    background: '#131720',
    color: '#00d4aa',
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: 700,
    cursor: 'pointer',
    letterSpacing: 1,
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <div style={{ color: '#4b6080', fontSize: 11, fontFamily: 'monospace' }}>
          {loading ? 'Scanning…' : `${signals.length} active opportunities ranked by quality score`}
        </div>
        <button style={btn} onClick={refetch}>
          ↻ Rescan
        </button>
      </div>
      <SignalList signals={signals} />
    </div>
  );
}
