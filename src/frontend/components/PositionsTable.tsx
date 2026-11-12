import React from 'react';

export interface PositionRow {
  id: string;
  instrument_id: string;
  tradingSymbol?: string;
  direction: 'LONG' | 'SHORT';
  quantity: number; // units
  lotSize?: number;
  average_entry_price: string;
  current_sl?: string | null;
  unrealized_pnl?: string;
  opened_at: string;
  engine: string;
}

interface PositionsTableProps {
  positions: PositionRow[];
  engine: 'LIVE' | 'PAPER';
}

function elapsed(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function PositionsTable({ positions, engine }: PositionsTableProps): React.ReactElement {
  const accent = engine === 'LIVE' ? '#3b82f6' : '#00d4aa';
  const rows = positions.filter((p) => p.engine === engine);

  const th: React.CSSProperties = {
    fontSize: 9,
    color: '#4b6080',
    letterSpacing: 1,
    textTransform: 'uppercase',
    padding: '6px 8px 4px',
    borderBottom: '1px solid #1a2235',
    textAlign: 'left',
    fontFamily: 'monospace',
  };

  const td: React.CSSProperties = {
    padding: '5px 8px',
    fontSize: 11,
    borderBottom: '1px solid #0f1521',
    fontFamily: 'monospace',
    verticalAlign: 'middle',
  };

  return (
    <div>
      {rows.length === 0 ? (
        <div
          style={{
            color: '#4b6080',
            fontSize: 11,
            textAlign: 'center',
            padding: '20px 0',
            fontFamily: 'monospace',
          }}
        >
          No open positions
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {[
                'Instrument',
                'Dir',
                'Qty (lots/units)',
                'Avg Entry',
                'SL',
                'Unrealised',
                'Time',
              ].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const pnl = parseFloat(p.unrealized_pnl ?? '0');
              const pnlColor = pnl > 0 ? '#22c55e' : pnl < 0 ? '#ef4444' : '#4b6080';
              const lots = p.lotSize && p.lotSize > 0 ? Math.floor(p.quantity / p.lotSize) : '—';
              return (
                <tr key={p.id}>
                  <td style={{ ...td, color: accent, fontWeight: 700 }}>
                    {p.tradingSymbol ?? p.instrument_id.slice(0, 8)}
                  </td>
                  <td
                    style={{
                      ...td,
                      color: p.direction === 'LONG' ? '#22c55e' : '#ef4444',
                      fontWeight: 700,
                    }}
                  >
                    {p.direction === 'LONG' ? '▲' : '▼'} {p.direction}
                  </td>
                  <td style={td}>
                    {lots} lots / {p.quantity} u
                  </td>
                  <td style={{ ...td, color: '#dde4f0' }}>
                    ₹{parseFloat(p.average_entry_price).toFixed(2)}
                  </td>
                  <td style={{ ...td, color: '#f59e0b' }}>
                    {p.current_sl ? `₹${parseFloat(p.current_sl).toFixed(2)}` : '—'}
                  </td>
                  <td style={{ ...td, color: pnlColor, fontWeight: 700 }}>
                    {pnl >= 0 ? '+' : ''}₹{Math.abs(pnl).toFixed(2)}
                  </td>
                  <td style={{ ...td, color: '#4b6080' }}>{elapsed(p.opened_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
