import React, { useState } from 'react';
import { useApi } from '../hooks/useApi';

interface OptionChainLeg {
  security_id: string;
  ltp: number;
  bid_price: number;
  ask_price: number;
  oi: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  bid_qty: number;
  ask_qty: number;
}

interface OptionStrike {
  strikePrice: number;
  ce?: OptionChainLeg;
  pe?: OptionChainLeg;
}

interface OptionChainResponse {
  underlying: string;
  expiry: string;
  atm: number;
  strikes: OptionStrike[];
  pcr?: number;
  totalCallOi?: number;
  totalPutOi?: number;
}

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];

function greekFmt(v: number | undefined): string {
  if (v === undefined || v === null) return '—';
  return v.toFixed(3);
}

export function OptionsIntelligencePanel(): React.ReactElement {
  const [underlying, setUnderlying] = useState('NIFTY');

  const { data: chain } = useApi<OptionChainResponse>(
    `/options-intelligence/chain?underlying=${underlying}`,
    15_000,
  );

  const th: React.CSSProperties = {
    fontSize: 9,
    color: '#4b6080',
    letterSpacing: 1,
    textTransform: 'uppercase' as const,
    padding: '4px 8px',
    borderBottom: '1px solid #1a2235',
    textAlign: 'center' as const,
    fontFamily: 'monospace',
  };
  const td: React.CSSProperties = {
    padding: '4px 8px',
    fontSize: 10,
    borderBottom: '1px solid #0f1521',
    fontFamily: 'monospace',
    textAlign: 'center' as const,
  };

  const strikes = chain?.strikes ?? [];

  return (
    <div>
      {/* Underlying selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {UNDERLYINGS.map((u) => (
          <button
            key={u}
            onClick={() => setUnderlying(u)}
            style={{
              padding: '4px 10px',
              borderRadius: 3,
              border: `1px solid ${u === underlying ? '#00d4aa' : '#1a2235'}`,
              background: u === underlying ? '#00d4aa18' : '#131720',
              color: u === underlying ? '#00d4aa' : '#4b6080',
              fontFamily: 'monospace',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {u}
          </button>
        ))}
        {chain && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              color: '#4b6080',
              fontFamily: 'monospace',
              alignSelf: 'center',
            }}
          >
            ATM: {chain.atm} · PCR: {chain.pcr?.toFixed(2) ?? '—'} · Expiry: {chain.expiry}
          </span>
        )}
      </div>

      {!strikes.length ? (
        <div
          style={{
            color: '#4b6080',
            textAlign: 'center',
            padding: '20px 0',
            fontFamily: 'monospace',
            fontSize: 11,
          }}
        >
          {chain ? 'No option chain data available' : 'Loading option chain…'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 400 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
            <thead>
              <tr style={{ background: '#0d1117' }}>
                <th style={{ ...th, color: '#00d4aa' }}>CE OI</th>
                <th style={{ ...th, color: '#00d4aa' }}>CE Vol</th>
                <th style={{ ...th, color: '#00d4aa' }}>CE IV%</th>
                <th style={{ ...th, color: '#00d4aa' }}>CE Δ</th>
                <th style={{ ...th, color: '#00d4aa' }}>CE LTP</th>
                <th style={{ ...th, color: '#dde4f0', background: '#1a2235' }}>Strike</th>
                <th style={{ ...th, color: '#ef4444' }}>PE LTP</th>
                <th style={{ ...th, color: '#ef4444' }}>PE Δ</th>
                <th style={{ ...th, color: '#ef4444' }}>PE IV%</th>
                <th style={{ ...th, color: '#ef4444' }}>PE Vol</th>
                <th style={{ ...th, color: '#ef4444' }}>PE OI</th>
              </tr>
            </thead>
            <tbody>
              {strikes.map((strike) => {
                const isAtm = chain && Math.abs(strike.strikePrice - chain.atm) < 50;
                return (
                  <tr key={strike.strikePrice} style={isAtm ? { background: '#1a2235' } : {}}>
                    <td style={{ ...td, color: '#4b6080' }}>
                      {strike.ce?.oi?.toLocaleString() ?? '—'}
                    </td>
                    <td style={{ ...td, color: '#4b6080' }}>
                      {strike.ce?.volume?.toLocaleString() ?? '—'}
                    </td>
                    <td style={{ ...td, color: '#f59e0b' }}>{strike.ce?.iv?.toFixed(1) ?? '—'}</td>
                    <td style={{ ...td, color: '#00d4aa' }}>{greekFmt(strike.ce?.delta)}</td>
                    <td style={{ ...td, color: '#00d4aa', fontWeight: isAtm ? 700 : 400 }}>
                      {strike.ce?.ltp?.toFixed(2) ?? '—'}
                    </td>
                    <td
                      style={{
                        ...td,
                        background: '#1a2235',
                        color: isAtm ? '#dde4f0' : '#4b6080',
                        fontWeight: 700,
                        letterSpacing: 1,
                      }}
                    >
                      {strike.strikePrice}
                    </td>
                    <td style={{ ...td, color: '#ef4444', fontWeight: isAtm ? 700 : 400 }}>
                      {strike.pe?.ltp?.toFixed(2) ?? '—'}
                    </td>
                    <td style={{ ...td, color: '#ef4444' }}>{greekFmt(strike.pe?.delta)}</td>
                    <td style={{ ...td, color: '#f59e0b' }}>{strike.pe?.iv?.toFixed(1) ?? '—'}</td>
                    <td style={{ ...td, color: '#4b6080' }}>
                      {strike.pe?.volume?.toLocaleString() ?? '—'}
                    </td>
                    <td style={{ ...td, color: '#4b6080' }}>
                      {strike.pe?.oi?.toLocaleString() ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
