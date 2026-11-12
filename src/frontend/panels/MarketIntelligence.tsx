/**
 * MarketIntelligence.tsx — Live market data for major NSE indices.
 *
 * Displays NIFTY, BANKNIFTY, FINNIFTY, India VIX, and current market regime.
 * Polls the backend every 5 seconds for the latest LTP and regime data.
 */

import React from 'react';
import { useApi } from '../hooks/useApi';

interface IndexQuote {
  symbol: string;
  ltp: number;
  change: number; // absolute change from previous close
  changePct: number; // percentage change
  high: number;
  low: number;
  volume: number;
}

interface MarketIntelligenceData {
  indices: IndexQuote[];
  indiaVix: number;
  regime: string;
  regimeRationale?: string;
  marketBreadth?: number; // 0-100
  relativeVolume?: number;
  lastUpdatedAt: string;
}

function IndexCard({ quote }: { quote: IndexQuote }): React.ReactElement {
  const up = quote.change >= 0;
  const color = up ? '#22c55e' : '#ef4444';

  return (
    <div
      style={{
        background: '#0d1117',
        border: `1px solid ${color}33`,
        borderRadius: 4,
        padding: '8px 12px',
        flex: '1 1 140px',
        minWidth: 140,
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: '#4b6080',
          letterSpacing: 2,
          textTransform: 'uppercase' as const,
          fontFamily: 'monospace',
          marginBottom: 3,
        }}
      >
        {quote.symbol}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#dde4f0', fontFamily: 'monospace' }}>
        {quote.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </div>
      <div style={{ fontSize: 11, color, fontFamily: 'monospace', marginTop: 2 }}>
        {up ? '+' : ''}
        {quote.change.toFixed(2)} ({up ? '+' : ''}
        {quote.changePct.toFixed(2)}%)
      </div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          marginTop: 4,
          fontSize: 9,
          color: '#4b6080',
          fontFamily: 'monospace',
        }}
      >
        <span>H: {quote.high.toLocaleString('en-IN')}</span>
        <span>L: {quote.low.toLocaleString('en-IN')}</span>
      </div>
    </div>
  );
}

function regimeColor(regime: string): string {
  if (regime.includes('STRONG_BULL')) return '#22c55e';
  if (regime.includes('WEAK_BULL')) return '#86efac';
  if (regime.includes('BREAKOUT')) return '#3b82f6';
  if (regime.includes('STRONG_BEAR')) return '#ef4444';
  if (regime.includes('WEAK_BEAR')) return '#fca5a5';
  if (regime.includes('HIGH_VOL')) return '#f59e0b';
  if (regime.includes('SIDEWAYS') || regime.includes('LOW_VOL')) return '#4b6080';
  return '#4b6080';
}

export function MarketIntelligence(): React.ReactElement {
  const { data, loading } = useApi<MarketIntelligenceData>('/market-data/intelligence', 5_000);

  if (loading && !data) {
    return (
      <div style={{ color: '#4b6080', fontFamily: 'monospace', fontSize: 11, padding: '12px 0' }}>
        Loading market data…
      </div>
    );
  }

  const vixColor =
    (data?.indiaVix ?? 0) > 20 ? '#ef4444' : (data?.indiaVix ?? 0) > 15 ? '#f59e0b' : '#22c55e';
  const regime = data?.regime ?? '—';

  return (
    <div>
      {/* Index quotes */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {(data?.indices ?? []).map((q) => (
          <IndexCard key={q.symbol} quote={q} />
        ))}

        {/* VIX card */}
        {data?.indiaVix !== undefined && (
          <div
            style={{
              background: '#0d1117',
              border: `1px solid ${vixColor}33`,
              borderRadius: 4,
              padding: '8px 12px',
              flex: '1 1 100px',
              minWidth: 100,
            }}
          >
            <div
              style={{
                fontSize: 9,
                color: '#4b6080',
                letterSpacing: 2,
                textTransform: 'uppercase' as const,
                fontFamily: 'monospace',
                marginBottom: 3,
              }}
            >
              India VIX
            </div>
            <div
              style={{ fontSize: 20, fontWeight: 700, color: vixColor, fontFamily: 'monospace' }}
            >
              {data.indiaVix.toFixed(2)}
            </div>
            <div style={{ fontSize: 9, color: vixColor, fontFamily: 'monospace', marginTop: 2 }}>
              {data.indiaVix > 20 ? 'HIGH VOL' : data.indiaVix > 15 ? 'ELEVATED' : 'LOW VOL'}
            </div>
          </div>
        )}
      </div>

      {/* Regime + breadth */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          padding: '8px 12px',
          background: '#0d1117',
          border: '1px solid #1a2235',
          borderRadius: 4,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 9,
              color: '#4b6080',
              letterSpacing: 1,
              textTransform: 'uppercase' as const,
              fontFamily: 'monospace',
            }}
          >
            Market Regime
          </div>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 3,
              background: `${regimeColor(regime)}22`,
              color: regimeColor(regime),
              border: `1px solid ${regimeColor(regime)}44`,
              letterSpacing: 1,
              fontFamily: 'monospace',
            }}
          >
            {regime.replace('_', ' ')}
          </span>
        </div>

        {data?.marketBreadth !== undefined && (
          <div>
            <div
              style={{
                fontSize: 9,
                color: '#4b6080',
                letterSpacing: 1,
                textTransform: 'uppercase' as const,
                fontFamily: 'monospace',
              }}
            >
              Market Breadth
            </div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: data.marketBreadth > 50 ? '#22c55e' : '#ef4444',
                fontFamily: 'monospace',
              }}
            >
              {data.marketBreadth.toFixed(1)}%
            </div>
          </div>
        )}

        {data?.relativeVolume !== undefined && (
          <div>
            <div
              style={{
                fontSize: 9,
                color: '#4b6080',
                letterSpacing: 1,
                textTransform: 'uppercase' as const,
                fontFamily: 'monospace',
              }}
            >
              Rel. Volume
            </div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: data.relativeVolume > 1.5 ? '#3b82f6' : '#4b6080',
                fontFamily: 'monospace',
              }}
            >
              {data.relativeVolume.toFixed(2)}×
            </div>
          </div>
        )}

        {data?.lastUpdatedAt && (
          <div
            style={{ marginLeft: 'auto', fontSize: 9, color: '#4b6080', fontFamily: 'monospace' }}
          >
            Updated: {new Date(data.lastUpdatedAt).toLocaleTimeString('en-IN', { hour12: false })}
          </div>
        )}
      </div>

      {data?.regimeRationale && (
        <div
          style={{
            marginTop: 6,
            fontSize: 9,
            color: '#4b6080',
            fontFamily: 'monospace',
            fontStyle: 'italic',
          }}
        >
          {data.regimeRationale.slice(0, 200)}
        </div>
      )}
    </div>
  );
}
