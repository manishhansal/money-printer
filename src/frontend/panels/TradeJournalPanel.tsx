import React, { useState } from 'react';
import { useApi } from '../hooks/useApi';

interface TradeRow {
  id: string;
  engine: string;
  direction: string;
  quantity: number;
  lot_size: number;
  entry_price: string;
  exit_price: string;
  entry_time: string;
  exit_time: string;
  gross_pnl: string;
  net_pnl: string;
  exit_reason: string;
  signal_score: string | null;
  instrument_id: string;
  tradingSymbol?: string;
}

export function TradeJournalPanel(): React.ReactElement {
  const [engine, setEngine] = useState<'PAPER' | 'LIVE'>('PAPER');
  const { data: trades } = useApi<TradeRow[]>(`/trades/today?engine=${engine}`, 15_000);

  const accent = engine === 'LIVE' ? '#3b82f6' : '#00d4aa';

  const th: React.CSSProperties = {
    fontSize: 9,
    color: '#4b6080',
    letterSpacing: 1,
    textTransform: 'uppercase' as const,
    padding: '5px 8px 4px',
    borderBottom: '1px solid #1a2235',
    textAlign: 'left' as const,
    fontFamily: 'monospace',
  };
  const td: React.CSSProperties = {
    padding: '5px 8px',
    fontSize: 11,
    borderBottom: '1px solid #0f1521',
    fontFamily: 'monospace',
  };

  return (
    <div>
      {/* Engine toggle */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {(['PAPER', 'LIVE'] as const).map((e) => (
          <button
            key={e}
            onClick={() => setEngine(e)}
            style={{
              padding: '4px 12px',
              borderRadius: 3,
              border: `1px solid ${e === engine ? (e === 'LIVE' ? '#3b82f6' : '#00d4aa') : '#1a2235'}`,
              background: e === engine ? `${accent}18` : '#131720',
              color: e === engine ? accent : '#4b6080',
              fontFamily: 'monospace',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {e}
          </button>
        ))}
      </div>

      {!trades?.length ? (
        <div
          style={{
            color: '#4b6080',
            textAlign: 'center',
            padding: '20px 0',
            fontFamily: 'monospace',
            fontSize: 11,
          }}
        >
          No closed trades today
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {[
                  'Instrument',
                  'Dir',
                  'Lots',
                  'Entry',
                  'Exit',
                  'Gross P&L',
                  'Net P&L',
                  'Score',
                  'Reason',
                ].map((h) => (
                  <th key={h} style={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(trades ?? []).map((t) => {
                const netPnl = parseFloat(t.net_pnl);
                const lots = t.lot_size > 0 ? Math.floor(t.quantity / t.lot_size) : '—';
                const pnlColor = netPnl > 0 ? '#22c55e' : netPnl < 0 ? '#ef4444' : '#4b6080';
                return (
                  <tr key={t.id}>
                    <td style={{ ...td, color: accent, fontWeight: 700 }}>
                      {t.tradingSymbol ?? t.instrument_id.slice(0, 8)}
                    </td>
                    <td
                      style={{
                        ...td,
                        color: t.direction === 'LONG' ? '#22c55e' : '#ef4444',
                        fontWeight: 700,
                      }}
                    >
                      {t.direction}
                    </td>
                    <td style={td}>{lots}</td>
                    <td style={td}>₹{parseFloat(t.entry_price).toFixed(2)}</td>
                    <td style={td}>₹{parseFloat(t.exit_price).toFixed(2)}</td>
                    <td
                      style={{ ...td, color: parseFloat(t.gross_pnl) >= 0 ? '#22c55e' : '#ef4444' }}
                    >
                      {parseFloat(t.gross_pnl) >= 0 ? '+' : ''}₹{parseFloat(t.gross_pnl).toFixed(0)}
                    </td>
                    <td style={{ ...td, color: pnlColor, fontWeight: 700 }}>
                      {netPnl >= 0 ? '+' : ''}₹{netPnl.toFixed(0)}
                    </td>
                    <td style={{ ...td, color: '#4b6080' }}>
                      {t.signal_score ? parseFloat(t.signal_score).toFixed(0) : '—'}
                    </td>
                    <td style={{ ...td, color: '#4b6080', fontSize: 10 }}>
                      {t.exit_reason.replace('_', ' ')}
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
