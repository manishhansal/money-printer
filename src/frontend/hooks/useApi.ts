/**
 * useApi.ts — lightweight REST polling hook for MoneyPrinter dashboard.
 * Uses SWR-like semantics: fetch on mount + interval, return { data, loading, error }.
 */

import { useState, useEffect, useCallback } from 'react';

const API_BASE =
  (typeof window !== 'undefined' &&
    (window as unknown as Record<string, string>)['MONEYPRINTER_API_URL']) ||
  'http://localhost:3002';

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useApi<T>(path: string, intervalMs = 10_000): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as T;
      setData(json);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void fetch_();
    const timer = setInterval(() => void fetch_(), intervalMs);
    return () => clearInterval(timer);
  }, [fetch_, intervalMs]);

  return { data, loading, error, refetch: fetch_ };
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}
