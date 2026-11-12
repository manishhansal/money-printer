/**
 * useWebSocket.ts — WebSocket hook for real-time MoneyPrinter dashboard updates.
 * Auto-reconnects with exponential backoff (1s→2s→4s→8s→16s, cap 30s).
 */

import { useState, useEffect, useRef, useCallback } from 'react';

export type WsStatus = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

export interface WsMessage {
  event: string;
  data: unknown;
}

const WS_URL =
  (typeof window !== 'undefined' &&
    (window as unknown as Record<string, string>)['MONEYPRINTER_WS_URL']) ||
  'ws://localhost:3003';

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const MAX_BACKOFF_MS = 30_000;

export function useWebSocket(onMessage: (msg: WsMessage) => void): WsStatus {
  const [status, setStatus] = useState<WsStatus>('CONNECTING');
  const wsRef = useRef<WebSocket | null>(null);
  const attemptsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
    }

    setStatus('CONNECTING');
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('CONNECTED');
      attemptsRef.current = 0;
    };

    ws.onmessage = (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data as string) as WsMessage;
        onMessageRef.current(parsed);
      } catch {
        /* ignore malformed messages */
      }
    };

    ws.onclose = () => {
      setStatus('DISCONNECTED');
      const delay = Math.min(BACKOFF_MS[attemptsRef.current] ?? MAX_BACKOFF_MS, MAX_BACKOFF_MS);
      attemptsRef.current += 1;
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      setStatus('ERROR');
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  return status;
}
