/**
 * market-intelligence.controller.ts
 *
 * GET /market-data/intelligence — returns live market data for NIFTY, BANKNIFTY,
 * FINNIFTY, India VIX, and current market regime for the React MarketIntelligence panel.
 *
 * GET /market-data/candles/:instrumentId — returns intraday 1-minute candles
 * for the React CandlestickChart component.
 */

import { Controller, Get, Param, Query } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { MarketRegimeService } from '../market-regime/market-regime.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HistoricalCandles } from '../../database/entities/historical-candles.entity';

export interface IndexQuote {
  symbol: string;
  ltp: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  volume: number;
}

export interface MarketIntelligenceResponse {
  indices: IndexQuote[];
  indiaVix: number;
  regime: string;
  regimeRationale?: string;
  marketBreadth?: number;
  relativeVolume?: number;
  lastUpdatedAt: string;
}

export interface CandleData {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Index underlying symbols → their typical Dhan security IDs (approximate). */
const INDEX_SECURITY_IDS: Record<string, string> = {
  NIFTY: '13',
  BANKNIFTY: '25',
  FINNIFTY: '27',
};

@Controller('market-data')
export class MarketIntelligenceController {
  constructor(
    private readonly redisService: RedisService,
    private readonly marketRegimeService: MarketRegimeService,
    @InjectRepository(HistoricalCandles)
    private readonly candlesRepo: Repository<HistoricalCandles>,
  ) {}

  /**
   * GET /market-data/intelligence
   * Returns live market data for the MarketIntelligence React panel.
   */
  @Get('intelligence')
  async getIntelligence(): Promise<MarketIntelligenceResponse> {
    const indices: IndexQuote[] = [];

    // Try to load index snapshots from Redis market feed.
    for (const [symbol, securityId] of Object.entries(INDEX_SECURITY_IDS)) {
      try {
        const [rawSnap, rawOpen] = await Promise.all([
          this.redisService.get(`mkt:snapshot:${securityId}`),
          this.redisService.get(`mkt:dayopen:${securityId}`),
        ]);
        if (rawSnap) {
          const snap = JSON.parse(rawSnap) as {
            ltp: string;
            bidPrice: string | null;
            askPrice: string | null;
            volume: string;
            oi: string | null;
            timestamp: number;
          };
          const ltp = parseFloat(snap.ltp);
          const dayOpen = rawOpen ? parseFloat(rawOpen) : 0;
          const change = dayOpen > 0 ? ltp - dayOpen : 0;
          const changePct = dayOpen > 0 ? (change / dayOpen) * 100 : 0;
          indices.push({
            symbol,
            ltp,
            change: Math.round(change * 100) / 100,
            changePct: Math.round(changePct * 100) / 100,
            high: ltp,
            low: ltp,
            volume: parseInt(snap.volume, 10),
          });
        }
      } catch {
        /* skip on Redis errors */
      }
    }

    // Get current regime.
    const regime = this.marketRegimeService.getCurrentRegime();

    return {
      indices,
      indiaVix: 0, // VIX not separately tracked in current feed
      regime: String(regime),
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  /**
   * GET /market-data/candles/:instrumentId?granularity=1m&limit=120
   * Returns historical intraday candles for the CandlestickChart component.
   */
  @Get('candles/:instrumentId')
  async getCandles(
    @Param('instrumentId') instrumentId: string,
    @Query('granularity') granularity = '1m',
    @Query('limit') limitStr = '120',
  ): Promise<CandleData[]> {
    const limit = Math.min(500, Math.max(1, parseInt(limitStr, 10)));

    try {
      const candles = await this.candlesRepo.find({
        where: { instrumentId: instrumentId, granularity: granularity === '1m' ? '1' : '5' } as any,
        order: { timestamp: 'DESC' },
        take: limit,
      });

      return candles.reverse().map((c) => ({
        timestamp: c.timestamp.toISOString(),
        open: parseFloat(c.openPrice),
        high: parseFloat(c.highPrice),
        low: parseFloat(c.lowPrice),
        close: parseFloat(c.closePrice),
        volume: c.volume ? Number(c.volume) : 0,
      }));
    } catch {
      return []; // graceful empty on DB errors
    }
  }
}
