import React, { useState, useEffect } from 'react';
import { WsStatus } from '../hooks/useWebSocket';
import { useApi } from '../hooks/useApi';

interface HealthData {
  status: string;
  info?: Record<string, { status: string }>;
}

interface TopBarProps {
  wsStatus: WsStatus;
  sessionPhase: string;
}

function dot(ok: boolean): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        marginRight: 4,
        background: ok ? '#22c55e' : '#ef4444',
        boxShadow: ok ? '0 0 5px #22c55e' : '0 0 5px #ef4444',
      }}
    />
  );
}

export function TopBar({ wsStatus, sessionPhase }: TopBarProps): React.ReactElement {
  const [clock, setClock] = useState('--:--:-- IST');
  const { data: health } = useApi<HealthData>('/health', 15_000);

  useEffect(() => {
    const tick = (): void => {
      setClock(
        new Date().toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour12: false,
        }) + ' IST',
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const wsOk = wsStatus === 'CONNECTED';
  const dbOk = health?.info?.postgresql_connection?.status === 'up';
  const redisOk = health?.info?.redis_availability?.status === 'up';
  const dhanOk = health?.info?.dhan_api_connectivity?.status === 'up';

  const phaseColor =
    sessionPhase === 'CLOSING'
      ? '#ef4444'
      : sessionPhase.startsWith('AFTERNOON')
        ? '#f59e0b'
        : sessionPhase === 'MARKET_CLOSED'
          ? '#4b6080'
          : '#22c55e';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        height: 40,
        background: '#131720',
        borderBottom: '1px solid #1a2235',
        position: 'sticky',
        top: 0,
        zIndex: 200,
        fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
        fontSize: 11,
      }}
    >
      {/* Brand */}
      <div style={{ fontSize: 14, fontWeight: 800, color: '#00d4aa', letterSpacing: 2 }}>
        ⚡ MONEYPRINTER
      </div>

      {/* Centre: phase + connections */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 3,
            letterSpacing: 1,
            background: `${phaseColor}22`,
            color: phaseColor,
            border: `1px solid ${phaseColor}44`,
          }}
        >
          {sessionPhase || '—'}
        </span>
        <span style={{ color: '#4b6080' }}>
          {dot(wsOk)}WS&nbsp;&nbsp;{dot(dhanOk)}Dhan&nbsp;&nbsp;{dot(dbOk)}DB&nbsp;&nbsp;
          {dot(redisOk)}Redis
        </span>
      </div>

      {/* Clock */}
      <div style={{ color: '#dde4f0', fontWeight: 600 }}>{clock}</div>
    </div>
  );
}
