/**
 * signal-scanner.service.ts
 *
 * SignalScannerService — cron-based scanner that evaluates live instruments
 * against the strategy pipeline every 2 minutes during market hours.
 *
 * Pipeline:
 *   Redis mkt:snapshot:* (live ticks from DhanWebSocket, keyed by securityId)
 *     → look up instruments table to get DB UUID for each securityId
 *     → evaluate entry conditions per snapshot
 *     → build SignalCandidateInput (instrumentId = DB UUID)
 *     → StrategyService.evaluateSignalCandidate()
 *       → (5 gates) → emit SIGNAL_CANDIDATE_EVENT
 *     → PipelineWiringService → SignalScoringService.scoreAndPersistSignal()
 *       → emit SIGNAL_ACCEPTED_EVENT (if score ≥ 80)
 *     → SignalDispatcherService → PaperTradingService.submitPaperOrder()
 *
 * Key fix: Redis keys are `mkt:snapshot:{securityId}` where securityId is the
 * Dhan platform integer ID.  The StrategyService expects the internal DB UUID
 * (instruments.id), so we JOIN against the instruments table on security_id.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { MarketRegimeService } from '../market-regime/market-regime.service';
import { SessionManagerService } from '../session-manager/session-manager.service';
import { StrategyService } from '../strategy/strategy.service';
import { SniperEntryService } from './sniper-entry.service';
import { LiveTradingService } from '../live-trading/live-trading.service';
import { MarketRegime } from '../market-regime/market-regime.types';
import { SessionPhase } from '../session-manager/session-manager.types';
import { SignalCandidateInput } from '../strategy/strategy.types';
import { SignalComponentScores } from '../signal-scoring/signal-scoring.types';
import { Instruments } from '../../database/entities/instruments.entity';

/** Default position size in lots. */
const DEFAULT_POSITION_SIZE = 1;
const SL_PCT = 0.015;

/** Target distance as fraction of LTP (3.0%) → R:R = 2.0. */
const TARGET_PCT = 0.03;

/** Regime-to-regimeAlignment score (0–15). */
const REGIME_SCORE: Record<string, number> = {
  [MarketRegime.STRONG_BULL]: 15,
  [MarketRegime.WEAK_BULL]: 12,
  [MarketRegime.BREAKOUT]: 11,
  [MarketRegime.SIDEWAYS]: 8,
  [MarketRegime.LOW_VOL]: 6,
  [MarketRegime.HIGH_VOL]: 5,
  [MarketRegime.WEAK_BEAR]: 5,
  [MarketRegime.STRONG_BEAR]: 4,
};

/** Session phases where new entry scanning is permitted. */
const SCANNABLE_PHASES = new Set<SessionPhase>([
  SessionPhase.ORB_FORMATION,
  SessionPhase.MORNING_MOMENTUM,
  SessionPhase.MID_SESSION,
  SessionPhase.AFTERNOON,
  SessionPhase.AFTERNOON_LATE, // 14:30–15:00 IST — entries still allowed
]);

interface SnapshotData {
  ltp: number;
  bidPrice: number | null;
  askPrice: number | null;
  volume: number;
}

@Injectable()
export class SignalScannerService {
  private readonly logger = new Logger(SignalScannerService.name);

  /** In-memory cache: securityId → DB UUID, refreshed each scan. */
  private securityIdToUuidCache = new Map<string, string>();

  constructor(
    private readonly redisService: RedisService,
    private readonly marketRegimeService: MarketRegimeService,
    private readonly sessionManagerService: SessionManagerService,
    private readonly strategyService: StrategyService,
    private readonly sniperEntryService: SniperEntryService,
    private readonly liveTradingService: LiveTradingService,
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
  ) {}

  // ─── Cron: scan every 2 minutes, Mon–Fri ───────────────────────────────────

  /**
   * Main scan loop — runs every 2 minutes on weekdays.
   * Skips the scan when the session phase is not tradeable.
   */
  @Cron('*/2 * * * 1-5', { timeZone: 'Asia/Kolkata' })
  async scanForSignals(): Promise<void> {
    const phase = this.sessionManagerService.getCurrentPhase();

    if (!SCANNABLE_PHASES.has(phase)) {
      this.logger.debug(`[Scanner] Skipping scan — phase=${phase}`);
      return;
    }

    const regime = this.marketRegimeService.getCurrentRegime();
    const isOpeningPhase = phase === SessionPhase.OPENING_VOLATILITY;

    this.logger.log(`[Scanner] Starting scan — phase=${phase} regime=${regime}`);

    const snapshotKeys = await this.redisService.keys('mkt:snapshot:*');
    if (snapshotKeys.length === 0) {
      this.logger.warn('[Scanner] No market snapshots in Redis — data feed may be down');
      return;
    }

    // ── Build securityId → DB UUID cache for this scan cycle ─────────────────
    // Redis keys are `mkt:snapshot:{securityId}` (Dhan platform integer IDs).
    // evaluateSignalCandidate requires the instruments table UUID (instruments.id).
    const securityIds = snapshotKeys.map((k) => k.replace('mkt:snapshot:', ''));
    await this.refreshInstrumentCache(securityIds);

    if (this.securityIdToUuidCache.size === 0) {
      this.logger.warn(
        `[Scanner] None of the ${securityIds.length} snapshot securityIds ` +
          `matched instruments in the DB — verify instruments table is seeded`,
      );
      return;
    }

    this.logger.log(
      `[Scanner] Instrument cache loaded: ${this.securityIdToUuidCache.size}/${securityIds.length} ` +
        `securityIds resolved to DB UUIDs`,
    );

    let evaluated = 0;
    let skipped = 0;
    let noInstrument = 0;

    for (const key of snapshotKeys) {
      const securityId = key.replace('mkt:snapshot:', '');
      const instrumentId = this.securityIdToUuidCache.get(securityId);

      if (!instrumentId) {
        noInstrument++;
        continue;
      }

      const snapshot = await this.loadSnapshot(key);
      if (!snapshot || !this.isEligible(snapshot)) {
        skipped++;
        continue;
      }

      const candidate = this.buildCandidate(
        instrumentId,
        securityId,
        snapshot,
        regime,
        isOpeningPhase,
      );

      try {
        await this.strategyService.evaluateSignalCandidate(candidate);
        evaluated++;
      } catch (err) {
        this.logger.error(
          `[Scanner] evaluateSignalCandidate failed for ${instrumentId}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `[Scanner] Scan complete — evaluated=${evaluated} skipped=${skipped} ` +
        `noInstrument=${noInstrument} total=${snapshotKeys.length}`,
    );
  }

  // ─── On-demand scan (dashboard debug trigger) ──────────────────────────────

  /**
   * Fires when the dashboard calls GET /debug/scan.
   * Runs a full scan immediately — bypasses the session phase guard so the
   * operator can force a scan at any time (e.g. pre-market testing or
   * manual trigger outside market hours).
   */
  @OnEvent('debug.trigger_scan')
  async onDebugTriggerScan(): Promise<void> {
    this.logger.log('[Scanner] On-demand scan triggered by dashboard — bypassing phase guard');
    // Temporarily inject a fake snapshot if none exist so the scan can run.
    const snapshotKeys = await this.redisService.keys('mkt:snapshot:*');

    if (snapshotKeys.length === 0) {
      this.logger.warn(
        '[Scanner] No market snapshots — on-demand scan cannot evaluate any instruments',
      );
      return;
    }

    // Run the scan pipeline directly (copy of scanForSignals sans phase check).
    const regime = this.marketRegimeService.getCurrentRegime();
    const securityIds = snapshotKeys.map((k) => k.replace('mkt:snapshot:', ''));
    await this.refreshInstrumentCache(securityIds);

    if (this.securityIdToUuidCache.size === 0) {
      this.logger.warn('[Scanner] No snapshot securityIds matched instruments in DB');
      return;
    }

    let evaluated = 0;
    for (const key of snapshotKeys) {
      const securityId = key.replace('mkt:snapshot:', '');
      const instrumentId = this.securityIdToUuidCache.get(securityId);
      if (!instrumentId) continue;

      const snapshot = await this.loadSnapshot(key);
      if (!snapshot || !this.isEligible(snapshot)) continue;

      const candidate = this.buildCandidate(instrumentId, securityId, snapshot, regime, false);
      try {
        await this.strategyService.evaluateSignalCandidate(candidate);
        evaluated++;
      } catch (err) {
        this.logger.error(`[Scanner] evaluateSignalCandidate failed: ${(err as Error).message}`);
      }
    }
    this.logger.log(`[Scanner] On-demand scan complete — evaluated=${evaluated}`);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Fetches instruments from the DB matching the given securityIds and
   * updates the in-memory cache (securityId → DB UUID).
   */
  private async refreshInstrumentCache(securityIds: string[]): Promise<void> {
    this.securityIdToUuidCache.clear();
    if (securityIds.length === 0) return;

    try {
      const instruments = await this.instrumentsRepo
        .createQueryBuilder('i')
        .select(['i.id', 'i.securityId'])
        .where('i.security_id IN (:...ids)', { ids: securityIds })
        .getMany();

      for (const instr of instruments) {
        this.securityIdToUuidCache.set(instr.securityId, instr.id);
      }
    } catch (err) {
      this.logger.error(`[Scanner] Failed to load instrument cache: ${(err as Error).message}`);
    }
  }

  private async loadSnapshot(key: string): Promise<SnapshotData | null> {
    try {
      const raw = await this.redisService.get(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as {
        ltp?: string;
        bidPrice?: string | null;
        askPrice?: string | null;
        volume?: string;
      };

      const ltp = parseFloat(parsed.ltp ?? '0');
      const bidPrice = parsed.bidPrice ? parseFloat(parsed.bidPrice) : null;
      const askPrice = parsed.askPrice ? parseFloat(parsed.askPrice) : null;
      const volume = parseInt(parsed.volume ?? '0', 10);

      if (isNaN(ltp)) return null;
      return { ltp, bidPrice, askPrice, volume };
    } catch {
      return null;
    }
  }

  private isEligible(snapshot: SnapshotData): boolean {
    // Build a MarketSnapshot-compatible object for SniperEntryService.
    const marketSnapshot = {
      ltp: String(snapshot.ltp),
      bidPrice: snapshot.bidPrice !== null ? String(snapshot.bidPrice) : null,
      askPrice: snapshot.askPrice !== null ? String(snapshot.askPrice) : null,
      volume: String(snapshot.volume),
      oi: null,
      timestamp: Date.now(),
    };

    const result = this.sniperEntryService.evaluate({
      snapshot: marketSnapshot,
      direction: 'BUY', // default direction for eligibility pre-check
    });

    if (!result.eligible) {
      this.logger.debug(
        `[Scanner] Sniper filter rejected — ${result.primaryFailureReason ?? result.failingFilters.join(', ')}`,
      );
      return false;
    }
    return true;
  }

  private buildCandidate(
    instrumentId: string,
    securityId: string,
    snapshot: SnapshotData,
    regime: MarketRegime,
    isOpeningPhase: boolean,
  ): SignalCandidateInput {
    const ltp = snapshot.ltp;
    // Direction: options buying always uses BUY transaction type regardless of
    // market direction.  CE vs PE selection (which encodes the directional bet)
    // happens downstream in ContractSelectionService.  Using BUY here prevents
    // the paper engine's short-selling guard from incorrectly rejecting options
    // entries in a bearish regime.
    const direction = 'BUY';

    const slDist = ltp * SL_PCT;
    const targetDist = ltp * TARGET_PCT;

    const entryPrice = ltp;
    const stopLossPrice = direction === 'BUY' ? ltp - slDist : ltp + slDist;
    const targetPrice = direction === 'BUY' ? ltp + targetDist : ltp - targetDist;
    const safeSl = Math.max(stopLossPrice, 0.01);
    const rrRatio = targetDist / slDist; // 2.0

    const componentScores = this.computeComponentScores(snapshot, regime, rrRatio);

    // ── Engine selection: LIVE when armed, PAPER otherwise ──────────────────
    // Fix for DEFECT-001: previously this was hardcoded to 'PAPER', making the
    // live trading pipeline unreachable from the automatic scanner cron even
    // when the engine was ARMED.  Now reads the actual armed state so that
    // signals generated during an active live session route to the live
    // execution path.
    //
    // The dispatcher (SignalDispatcherService.dispatchToLive) performs a
    // redundant isArmed() check as belt-and-suspenders, so it is safe for the
    // scanner to set engine='LIVE' here without bypassing any safety gate.
    const engine: 'LIVE' | 'PAPER' = this.liveTradingService.isArmed() ? 'LIVE' : 'PAPER';

    const measuredInputs: Record<string, unknown> = {
      ltp,
      bidPrice: snapshot.bidPrice,
      askPrice: snapshot.askPrice,
      volume: snapshot.volume,
      regime,
      securityId, // passed through so PipelineWiring can relay it to dispatcher
      approxRrRatio: rrRatio,
      slPct: SL_PCT,
      targetPct: TARGET_PCT,
      scannerVersion: '1.0',
      engineMode: engine,
    };

    return {
      instrumentId,
      engine,
      direction: direction as 'BUY' | 'SELL',
      currentRegime: regime,
      isOpeningPhase,
      entryConditionsMet: true,
      entryPrice: entryPrice.toFixed(2),
      stopLossPrice: safeSl.toFixed(2),
      targetPrice: targetPrice.toFixed(2),
      positionSize: DEFAULT_POSITION_SIZE,
      componentScores,
      measuredInputs,
    };
  }

  private computeComponentScores(
    snapshot: SnapshotData,
    regime: MarketRegime,
    rrRatio: number,
  ): SignalComponentScores {
    const regimeAlignment = REGIME_SCORE[regime] ?? 7;

    const priceStructure = snapshot.bidPrice !== null && snapshot.askPrice !== null ? 12 : 10;

    const volumeConfirmation = snapshot.volume > 100 ? 13 : snapshot.volume > 0 ? 10 : 7;
    const momentum = 8;
    const vwapTrendAlignment = 8;

    let optionsFuturesConfirmation = 8;
    if (snapshot.bidPrice !== null && snapshot.askPrice !== null && snapshot.bidPrice > 0) {
      const spreadPct = (snapshot.askPrice! - snapshot.bidPrice) / snapshot.ltp;
      optionsFuturesConfirmation = spreadPct < 0.05 ? 12 : spreadPct < 0.1 ? 10 : 8;
    }

    let liquidityExecution = 8;
    if (snapshot.bidPrice !== null && snapshot.askPrice !== null) {
      const spreadPct = (snapshot.askPrice! - snapshot.bidPrice) / snapshot.ltp;
      liquidityExecution = spreadPct < 0.01 ? 10 : spreadPct < 0.05 ? 9 : 8;
    }

    const rrQuality = rrRatio >= 2.0 ? 10 : rrRatio >= 1.5 ? 8 : 5;

    return {
      regimeAlignment,
      priceStructure,
      volumeConfirmation,
      momentum,
      vwapTrendAlignment,
      optionsFuturesConfirmation,
      liquidityExecution,
      rrQuality,
    };
  }
}
