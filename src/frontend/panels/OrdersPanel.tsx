import React from 'react';
import { useApi } from '../hooks/useApi';

interface OrderRow {
  id: string;
  engine: string;
  dhan_order_id: string | null;
  dhan_correlation_id: string | null;
  instrument_id: string;
  transaction_type: string;
  order_type: string;
  quantity: number;
  status: string;
  price: string | null;
  filled_quantity: number;
  average_fill_price: string | null;
  submitted_at: string | null;
  created_at: string;
}

export function OrdersPanel(): React.ReactElement {
  const { data: orders } = useApi<OrderRow[]>('/orders/today', 5_000);

  const th: React.CSSProperties = {
    fontSize: 9,
    color: '#4b6080',
    letterSpacing: 1,
    textTransform: 'uppercase' as const,
    padding: '6px 8px 4px',
    borderBottom: '1px solid #1a2235',
    textAlign: 'left' as const,
    fontFamily: 'monospace',
  };
  const td: React.CSSProperties = {
    padding: '5px 8px',
    fontSize: 11,
    borderBottom: '1px solid #0f1521',
    fontFamily: 'monospace',
    verticalAlign: 'middle' as const,
  };

  const statusColor = (s: string): string =>
    s === 'complete' || s === 'submitted'
      ? '#22c55e'
      : s === 'rejected' || s === 'cancelled'
        ? '#ef4444'
        : s === 'partial'
          ? '#f59e0b'
          : '#4b6080';

  if (!orders?.length) {
    return (
      <div
        style={{
          color: '#4b6080',
          textAlign: 'center',
          padding: '20px 0',
          fontFamily: 'monospace',
          fontSize: 11,
        }}
      >
        No orders today
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {[
              'Engine',
              'Direction',
              'Type',
              'Qty',
              'Price',
              'Filled',
              'Avg Fill',
              'Status',
              'Time',
            ].map((h) => (
              <th key={h} style={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(orders ?? []).map((o) => {
            const ts = o.submitted_at
              ? new Date(o.submitted_at).toLocaleTimeString('en-IN', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '—';
            const fillPct = o.quantity > 0 ? Math.round((o.filled_quantity / o.quantity) * 100) : 0;
            return (
              <tr key={o.id}>
                <td
                  style={{
                    ...td,
                    color: o.engine === 'LIVE' ? '#3b82f6' : '#00d4aa',
                    fontWeight: 700,
                  }}
                >
                  {o.engine}
                </td>
                <td
                  style={{
                    ...td,
                    color: o.transaction_type === 'BUY' ? '#22c55e' : '#ef4444',
                    fontWeight: 700,
                  }}
                >
                  {o.transaction_type}
                </td>
                <td style={{ ...td, color: '#4b6080' }}>{o.order_type}</td>
                <td style={td}>{o.quantity}</td>
                <td style={td}>{o.price ? `₹${parseFloat(o.price).toFixed(2)}` : 'MKT'}</td>
                <td style={td}>
                  <span
                    style={{
                      color: fillPct === 100 ? '#22c55e' : fillPct > 0 ? '#f59e0b' : '#4b6080',
                    }}
                  >
                    {o.filled_quantity}/{o.quantity}
                  </span>
                </td>
                <td style={td}>
                  {o.average_fill_price ? `₹${parseFloat(o.average_fill_price).toFixed(2)}` : '—'}
                </td>
                <td style={{ ...td }}>
                  <span
                    style={{
                      fontSize: 9,
                      padding: '2px 5px',
                      borderRadius: 2,
                      fontWeight: 700,
                      background: `${statusColor(o.status)}22`,
                      color: statusColor(o.status),
                      border: `1px solid ${statusColor(o.status)}44`,
                    }}
                  >
                    {o.status.toUpperCase()}
                  </span>
                </td>
                <td style={{ ...td, color: '#4b6080' }}>{ts}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
