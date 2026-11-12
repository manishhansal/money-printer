/**
 * Skeleton.tsx — Loading skeleton components for MoneyPrinter dashboard.
 *
 * Usage:
 *   <Skeleton width={200} height={16} />
 *   <SkeletonTable rows={5} cols={6} />
 *   <SkeletonCard />
 */

import React from 'react';

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  borderRadius?: number;
  style?: React.CSSProperties;
}

/** Animated loading placeholder for a single line/block. */
export function Skeleton({
  width = '100%',
  height = 14,
  borderRadius = 2,
  style,
}: SkeletonProps): React.ReactElement {
  return (
    <div
      style={{
        width,
        height,
        borderRadius,
        background: 'linear-gradient(90deg, #1a2235 25%, #2a3245 50%, #1a2235 75%)',
        backgroundSize: '200% 100%',
        animation: 'skeletonShimmer 1.5s infinite',
        ...style,
      }}
    />
  );
}

/** Table skeleton — multiple rows and columns. */
export function SkeletonTable({
  rows = 5,
  cols = 5,
}: {
  rows?: number;
  cols?: number;
}): React.ReactElement {
  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} height={10} width={`${100 / cols}%`} />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} height={12} width={`${100 / cols}%`} />
          ))}
        </div>
      ))}
      <style>{`
        @keyframes skeletonShimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

/** Card skeleton for engine P&L cards. */
export function SkeletonCard(): React.ReactElement {
  return (
    <div
      style={{
        background: '#131720',
        border: '1px solid #1a2235',
        borderRadius: 4,
        padding: '12px 16px',
        flex: '1 1 200px',
      }}
    >
      <Skeleton width={80} height={10} style={{ marginBottom: 10 }} />
      <Skeleton width={120} height={24} style={{ marginBottom: 6 }} />
      <Skeleton width={100} height={10} style={{ marginBottom: 12 }} />
      <div style={{ display: 'flex', gap: 16 }}>
        <Skeleton width={40} height={16} />
        <Skeleton width={40} height={16} />
        <Skeleton width={50} height={16} />
      </div>
    </div>
  );
}
