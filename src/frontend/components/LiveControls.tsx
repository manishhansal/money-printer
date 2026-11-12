import React, { useState } from 'react';
import { useApi, apiPost } from '../hooks/useApi';

interface ArmedStateData {
  armedState: 'DISARMED' | 'ARMED_PENDING' | 'ARMED';
}

export function LiveControls(): React.ReactElement {
  const { data, refetch } = useApi<ArmedStateData>('/live-trading/status', 3_000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const armedState = data?.armedState ?? 'DISARMED';

  async function call(path: string): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await apiPost(path);
      refetch();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const stateColor =
    armedState === 'ARMED' ? '#22c55e' : armedState === 'ARMED_PENDING' ? '#f59e0b' : '#4b6080';

  const btn = (
    label: string,
    path: string,
    bg: string,
    color: string,
    disabled = false,
  ): React.ReactElement => (
    <button
      onClick={() => void call(path)}
      disabled={disabled || busy}
      style={{
        flex: 1,
        padding: '6px 10px',
        borderRadius: 4,
        border: `1px solid ${color}44`,
        background: `${bg}`,
        color,
        fontFamily: 'monospace',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1,
        cursor: disabled || busy ? 'not-allowed' : 'pointer',
        opacity: disabled || busy ? 0.5 : 1,
        textTransform: 'uppercase',
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      {/* State badge */}
      <div
        style={{
          textAlign: 'center',
          padding: 6,
          marginBottom: 8,
          borderRadius: 4,
          background: `${stateColor}18`,
          color: stateColor,
          fontFamily: 'monospace',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 2,
          border: `1px solid ${stateColor}33`,
          animation: armedState === 'ARMED_PENDING' ? 'pulse 1s infinite' : 'none',
        }}
      >
        {armedState === 'ARMED'
          ? '✓ ARMED — LIVE ACTIVE'
          : armedState === 'ARMED_PENDING'
            ? '⏳ PENDING CONFIRMATION'
            : 'DISARMED'}
      </div>

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        {btn(
          '① Activate',
          '/live-trading/arm/request',
          '#22c55e18',
          '#22c55e',
          armedState !== 'DISARMED',
        )}
        {armedState === 'ARMED_PENDING' &&
          btn('② Confirm', '/live-trading/arm/confirm', '#3b82f618', '#3b82f6')}
        {btn(
          'Disarm',
          '/live-trading/arm/disarm',
          '#ef444418',
          '#ef4444',
          armedState === 'DISARMED',
        )}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {btn('⚠ Kill Switch', '/live-trading/kill-switch', '#ef444440', '#fff')}
      </div>

      {err && (
        <div style={{ color: '#ef4444', fontSize: 10, marginTop: 6, fontFamily: 'monospace' }}>
          {err}
        </div>
      )}
    </div>
  );
}
