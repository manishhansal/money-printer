/**
 * MarketActivityHeatmapService — tracks valid trade signal activity across
 * three dimensions over the trailing 30 trading days:
 *
 *   - byInstrument:  signal count keyed by trading symbol
 *   - byTimeOfDay:   signal count keyed by 60-minute IST bucket label
 *   - byRegime:      signal count keyed by market regime code
 *
 * "Valid" signals are those with status in ('active', 'accepted', 'executed').
 * Signals with an unresolvable instrument are excluded from byInstrument but
 * still contribute to byTimeOfDay and byRegime.  Signals with a null regime
 * are excluded from byRegime only.
 *
 * Requirements: 14.7
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';

import { Signals, SignalEngine, SignalStatus } from '../../database/entities/signals.entity';
import { Instruments } from '../../database/entities/instruments.entity';

/** IST offset from UTC in milliseconds (5 h 30 min). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Signal statuses considered "valid trade signals" (Req 14.7). */
const VALID_STATUSES: SignalStatus[] = ['active', 'accepted', 'executed'];

/**
 * 30 trading days expressed in calendar days.
 * NSE trades Mon–Fri ~252 days/year → 30 trading days ≈ 30 × (7/5) = 42 calendar days.
 */
const TRADING_WINDOW_CALENDAR_DAYS = 42;

export interface HeatmapData {
  /** Count of valid signals per trading symbol (e.g. "NIFTY24JAN21000CE"). */
  byInstrument: Record<string, number>;
  /** Count of valid signals per 60-minute IST time-of-day bucket (e.g. "09:15-10:15"). */
  byTimeOfDay: Record<string, number>;
  /** Count of valid signals per market regime code (e.g. "BULL_TREND"). */
  byRegime: Record<string, number>;
  /** UTC timestamp when this heatmap was computed. */
  generatedAt: Date;
  /** Nominal window length in trading days. */
  windowDays: 30;
}

@Injectable()
export class MarketActivityHeatmapService {
  constructor(
    @InjectRepository(Signals)
    private readonly signalsRepo: Repository<Signals>,

    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
  ) {}

  /**
   * Compute signal activity counts across instrument, time-of-day, and regime
   * dimensions for the specified trading engine over the trailing 30 trading days.
   *
   * Requirements: 14.7
   */
  async getHeatmap(engine: 'LIVE' | 'PAPER'): Promise<HeatmapData> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - TRADING_WINDOW_CALENDAR_DAYS);

    const signals = await this.signalsRepo.find({
      where: {
        engine: engine as SignalEngine,
        status: In(VALID_STATUSES),
        signalTimestamp: MoreThanOrEqual(cutoff),
      },
      select: {
        instrumentId: true,
        signalTimestamp: true,
        regime: true,
      },
    });

    if (signals.length === 0) {
      return {
        byInstrument: {},
        byTimeOfDay: {},
        byRegime: {},
        generatedAt: new Date(),
        windowDays: 30,
      };
    }

    // Resolve all distinct instrument IDs to trading symbols in a single batch query.
    const instrumentIds = [...new Set(signals.map((s) => s.instrumentId))];
    const instrumentSymbolById = await this.buildInstrumentSymbolMap(instrumentIds);

    const byInstrument: Record<string, number> = {};
    const byTimeOfDay: Record<string, number> = {};
    const byRegime: Record<string, number> = {};

    for (const signal of signals) {
      // ── Instrument dimension ────────────────────────────────────────────
      const symbol = instrumentSymbolById.get(signal.instrumentId);
      if (symbol !== undefined) {
        byInstrument[symbol] = (byInstrument[symbol] ?? 0) + 1;
      }

      // ── Time-of-day dimension ───────────────────────────────────────────
      const bucket = this.getTimeOfDayBucket(signal.signalTimestamp);
      byTimeOfDay[bucket] = (byTimeOfDay[bucket] ?? 0) + 1;

      // ── Regime dimension ────────────────────────────────────────────────
      if (signal.regime !== null) {
        byRegime[signal.regime] = (byRegime[signal.regime] ?? 0) + 1;
      }
    }

    return {
      byInstrument,
      byTimeOfDay,
      byRegime,
      generatedAt: new Date(),
      windowDays: 30,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Fetches instruments for the given IDs and returns a Map from UUID to
   * trading symbol.  Returns an empty Map when `ids` is empty.
   */
  private async buildInstrumentSymbolMap(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();

    const rows = await this.instrumentsRepo.find({
      where: { id: In(ids) },
      select: { id: true, tradingSymbol: true },
    });

    return new Map(rows.map((i) => [i.id, i.tradingSymbol]));
  }

  /**
   * Derives the 60-minute IST time-of-day bucket label for a UTC timestamp.
   *
   * Windows start at 09:15 IST.  Examples:
   *   09:15–10:14 IST  →  "09:15-10:15"
   *   10:15–11:14 IST  →  "10:15-11:15"
   *
   * Signals arriving before 09:15 IST (pre-market) are placed in a
   * "pre-market" bucket so they are never silently dropped.
   *
   * Matches the identical method in AnalyticsService for consistency.
   */
  private getTimeOfDayBucket(signalTimestampUtc: Date): string {
    // Shift UTC → IST (+5h 30m)
    const ist = new Date(signalTimestampUtc.getTime() + IST_OFFSET_MS);
    const totalMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();

    /** 09:15 IST expressed in minutes since midnight. */
    const MARKET_OPEN_MIN = 9 * 60 + 15;

    if (totalMinutes < MARKET_OPEN_MIN) {
      return 'pre-market';
    }

    const minutesFromOpen = totalMinutes - MARKET_OPEN_MIN;
    const bucketIndex = Math.floor(minutesFromOpen / 60);
    const startMin = MARKET_OPEN_MIN + bucketIndex * 60;
    const endMin = startMin + 60;

    const pad = (n: number) => n.toString().padStart(2, '0');
    const fmt = (mins: number) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

    return `${fmt(startMin)}-${fmt(endMin)}`;
  }
}
