/**
 * Toast.tsx — Lightweight toast notification system for MoneyPrinter dashboard.
 *
 * Usage:
 *   const { addToast } = useToast();
 *   addToast('Order submitted', 'success');
 *   addToast('Risk limit hit', 'error');
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  createdAt: number;
}

const TOAST_DURATION_MS = 4_000;

const TOAST_COLORS: Record<ToastType, { bg: string; border: string; text: string }> = {
  success: { bg: '#22c55e18', border: '#22c55e', text: '#22c55e' },
  error: { bg: '#ef444418', border: '#ef4444', text: '#ef4444' },
  warning: { bg: '#f59e0b18', border: '#f59e0b', text: '#f59e0b' },
  info: { bg: '#3b82f618', border: '#3b82f6', text: '#3b82f6' },
};

const TOAST_ICONS: Record<ToastType, string> = {
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
};

interface ToastContextValue {
  addToast: (message: string, type?: ToastType) => void;
}

export const ToastContext = React.createContext<ToastContextValue>({
  addToast: () => {},
});

export function useToast(): ToastContextValue {
  return React.useContext(ToastContext);
}

/** ToastProvider — wrap your app with this to enable toast notifications. */
export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counterRef = useRef(0);

  const addToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = `toast-${++counterRef.current}`;
    setToasts((prev) => [...prev, { id, message, type, createdAt: Date.now() }]);
  }, []);

  // Auto-remove toasts after duration
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((t) => now - t.createdAt < TOAST_DURATION_MS));
    }, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toasts]);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* Toast container — fixed bottom-right */}
      <div
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => {
          const colors = TOAST_COLORS[t.type];
          return (
            <div
              key={t.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 14px',
                borderRadius: 4,
                border: `1px solid ${colors.border}44`,
                background: colors.bg,
                backdropFilter: 'blur(8px)',
                fontFamily: 'monospace',
                fontSize: 11,
                color: '#dde4f0',
                pointerEvents: 'auto',
                maxWidth: 320,
                boxShadow: `0 4px 12px rgba(0,0,0,0.5), 0 0 0 1px ${colors.border}22`,
                animation: 'toastIn 0.2s ease',
              }}
            >
              <span style={{ color: colors.text, fontSize: 13, flexShrink: 0 }}>
                {TOAST_ICONS[t.type]}
              </span>
              <span style={{ flex: 1 }}>{t.message}</span>
              <button
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#4b6080',
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: '0 0 0 4px',
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </ToastContext.Provider>
  );
}
