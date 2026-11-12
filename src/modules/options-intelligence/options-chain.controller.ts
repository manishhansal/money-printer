/**
 * options-chain.controller.ts
 *
 * GET /options-intelligence/chain?underlying=NIFTY
 *   Builds a full CE/PE strike table by joining GreekValues (from Dhan cache)
 *   with instrument records (DB → strike price, option type, OI) and LTP
 *   snapshots (Redis).
 *
 * GET /options-intelligence/expiries?underlying=NIFTY
 *   Returns available expiry dates.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { OptionsIntelligenceService } from './options-intelligence.service';
import { GreekValues } from './options-intelligence.types';
import { Instruments } from '../../database/entities/instruments.entity';
import { RedisService } from '../redis/redis.service';

const UNDERLYING_SECURITY_IDS: Record<string, number> = {
  NIFTY: 13,
  BANKNIFTY: 25,
  FINNIFTY: 27,
  MIDCPNIFTY: 442,
  SENSEX: 51,
  BANKEX: 1,
};

export interface OptionLeg {
  security_id: string;
  ltp: number;
  bid_price: number;
  ask_price: number;
  oi: number;
  volume: number;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  bid_qty: number;
  ask_qty: number;
}

export interface OptionChainResponse {
  underlying: string;
  expiry: string;
  atm: number;
  pcr: number | null;
  totalCallOi: number | null;
  totalPutOi: number | null;
  strikes: Array<{ strikePrice: number; ce?: OptionLeg; pe?: OptionLeg }>;
}

const emptyChain = (underlying: string, expiry = ''): OptionChainResponse => ({
  underlying,
  expiry,
  atm: 0,
  pcr: null,
  totalCallOi: null,
  totalPutOi: null,
  strikes: [],
});

@Controller('options-intelligence')
export class OptionsChainController {
  constructor(
    private readonly optionsIntelligenceService: OptionsIntelligenceService,
    private readonly redisService: RedisService,
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
  ) {}

  @Get('chain')
  async getOptionChain(@Query('underlying') underlying = 'NIFTY'): Promise<OptionChainResponse> {
    const secId = UNDERLYING_SECURITY_IDS[underlying.toUpperCase()];
    if (!secId) return emptyChain(underlying);

    // 1. Nearest expiry
    let expiries: string[] = [];
    try {
      expiries = await this.optionsIntelligenceService.getActiveExpiries(secId);
    } catch {
      /* graceful */
    }
    if (!expiries.length) return emptyChain(underlying);
    const nearestExpiry = expiries[0];

    // 2. Greeks map  securityId → GreekValues
    let greeksMap = new Map<string, GreekValues>();
    try {
      greeksMap = await this.optionsIntelligenceService.fetchAndCacheGreeks(
        String(secId),
        nearestExpiry,
      );
    } catch {
      /* graceful */
    }
    if (!greeksMap.size) return emptyChain(underlying, nearestExpiry);

    // 3. Batch-load instrument records (strike price, optionType, OI)
    const greekSecIds = Array.from(greeksMap.keys());
    let instruments: Instruments[] = [];
    try {
      instruments = await this.instrumentsRepo.find({
        where: {
          securityId: In(greekSecIds),
          underlying: underlying.toUpperCase(),
          expiryDate: nearestExpiry,
        },
        select: {
          id: true,
          securityId: true,
          strikePrice: true,
          optionType: true,
          openInterest: true,
        },
      });
    } catch {
      /* graceful — no strike grouping */
    }

    // 4. LTP from Redis for each option + index LTP for ATM
    const ltpBySecId = new Map<string, number>();
    await Promise.allSettled(
      greekSecIds.map(async (sid) => {
        const raw = await this.redisService.get(`mkt:snapshot:${sid}`).catch(() => null);
        if (raw) ltpBySecId.set(sid, parseFloat((JSON.parse(raw) as { ltp: string }).ltp));
      }),
    );
    let indexLtp = 0;
    try {
      const raw = await this.redisService.get(`mkt:snapshot:${secId}`);
      if (raw) indexLtp = parseFloat((JSON.parse(raw) as { ltp: string }).ltp);
    } catch {
      /* skip */
    }

    // 5. Build strike map
    type Row = { strikePrice: number; ce?: OptionLeg; pe?: OptionLeg };
    const strikeMap = new Map<number, Row>();

    for (const instr of instruments) {
      if (!instr.strikePrice || !instr.optionType) continue;
      const sp = parseFloat(instr.strikePrice);
      if (!strikeMap.has(sp)) strikeMap.set(sp, { strikePrice: sp });

      const row = strikeMap.get(sp)!;
      const g = greeksMap.get(instr.securityId);
      const leg: OptionLeg = {
        security_id: instr.securityId,
        ltp: g?.ltp ?? ltpBySecId.get(instr.securityId) ?? 0,
        bid_price: g?.bidPrice ?? 0,
        ask_price: g?.askPrice ?? 0,
        oi: g?.oi ?? instr.openInterest ?? 0,
        volume: g?.volume ?? 0,
        iv: g?.iv ?? null,
        delta: g?.delta ?? null,
        gamma: g?.gamma ?? null,
        theta: g?.theta ?? null,
        vega: g?.vega ?? null,
        bid_qty: g?.bidQty ?? 0,
        ask_qty: g?.askQty ?? 0,
      };
      if (instr.optionType === 'CE') row.ce = leg;
      else row.pe = leg;
    }

    // 6. Sort strikes, compute ATM + OI aggregates
    const strikes = [...strikeMap.values()].sort((a, b) => a.strikePrice - b.strikePrice);

    const atm =
      indexLtp > 0 && strikes.length
        ? strikes.reduce((best, s) =>
            Math.abs(s.strikePrice - indexLtp) < Math.abs(best.strikePrice - indexLtp) ? s : best,
          ).strikePrice
        : 0;

    let totalCallOi = 0;
    let totalPutOi = 0;
    for (const s of strikes) {
      totalCallOi += s.ce?.oi ?? 0;
      totalPutOi += s.pe?.oi ?? 0;
    }
    const pcr = totalCallOi > 0 ? totalPutOi / totalCallOi : null;

    return {
      underlying,
      expiry: nearestExpiry,
      atm,
      pcr: pcr !== null ? Math.round(pcr * 1000) / 1000 : null,
      totalCallOi: totalCallOi || null,
      totalPutOi: totalPutOi || null,
      strikes,
    };
  }

  @Get('expiries')
  async getExpiries(@Query('underlying') underlying = 'NIFTY'): Promise<{ expiries: string[] }> {
    const secId = UNDERLYING_SECURITY_IDS[underlying.toUpperCase()];
    if (!secId) return { expiries: [] };
    try {
      const expiries = await this.optionsIntelligenceService.getActiveExpiries(secId);
      return { expiries };
    } catch {
      return { expiries: [] };
    }
  }
}
