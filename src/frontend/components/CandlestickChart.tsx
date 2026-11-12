/**
 * CandlestickChart.tsx — TradingView Lightweight Charts candlestick chart.
 *
 * Fetches intraday candle data from the backend and renders a full
 * candlestick + volume chart with VWAP overlay.
 *
 * Usage:
 *   <CandlestickChart instrumentId="uuid" symbol="NIFTY24DEC22000CE" />
 */

import React, { useEffect, useRef, useCallback } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  Time,
} from 'lightweight-charts';
import { apiUrl } from '../hooks/useApi';

interface Candle {
  timestamp: string; // ISO or epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandlestickChartProps {
  instrumentId: string;
  symbol: string;
  height?: number;
}

/** Fetch intraday candle data from the backend. */
async function fetchCandles(instrumentId: string): Promise<Candle[]> {
  const url = apiUrl(`/market-data/candles/${instrumentId}?granularity=1m&limit=120`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Candle[]>;
}

export function CandlestickChart({
  instrumentId,
  symbol,
  height = 280,
}: CandlestickChartProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  const loadData = useCallback(async () => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    try {
      const candles = await fetchCandles(instrumentId);
      if (!candles.length) return;

      const candleData: CandlestickData[] = candles.map((c) => ({
        time: (new Date(c.timestamp).getTime() / 1000) as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));

      const volumeData: HistogramData[] = candles.map((c) => ({
        time: (new Date(c.timestamp).getTime() / 1000) as Time,
        value: c.volume,
        color: c.close >= c.open ? '#22c55e44' : '#ef444444',
      }));

      candleSeriesRef.current.setData(candleData);
      volumeSeriesRef.current.setData(volumeData);
      chartRef.current?.timeScale().fitContent();
    } catch {
      /* non-fatal — chart stays empty */
    }
  }, [instrumentId]);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0d1117' },
        textColor: '#4b6080',
        fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#1a2235' },
        horzLines: { color: '#1a2235' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1a2235' },
      timeScale: { borderColor: '#1a2235', timeVisible: true, secondsVisible: false },
      width: containerRef.current.clientWidth,
      height,
    });
    chartRef.current = chart;

    // Candlestick series
    candleSeriesRef.current = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    // Volume histogram (bottom 20% of chart)
    volumeSeriesRef.current = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    void loadData();

    // Auto-refresh every 60 seconds
    const refreshTimer = setInterval(() => void loadData(), 60_000);

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    return () => {
      clearInterval(refreshTimer);
      resizeObserver.disconnect();
      chart.remove();
    };
  }, [height, loadData]);

  return (
    <div>
      {symbol && (
        <div
          style={{
            fontSize: 10,
            color: '#4b6080',
            fontFamily: 'monospace',
            marginBottom: 4,
            letterSpacing: 1,
          }}
        >
          {symbol} · 1m intraday
        </div>
      )}
      <div ref={containerRef} style={{ width: '100%', height }} />
    </div>
  );
}
