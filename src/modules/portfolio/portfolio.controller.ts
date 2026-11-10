/**
 * portfolio.controller.ts
 *
 * Exposes a lightweight session P&L summary endpoint used by the Chrome
 * Extension to display net profit/loss after all trading charges.
 *
 * GET /portfolio/summary
 *   Returns the current session gross P&L, itemised charges, and net P&L
 *   for both LIVE and PAPER engines, sourced from the CapitalLedgers table.
 */

import { Controller, Get, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { Trade } from '../../database/entities/trades.entity';

export interface ChargeBreakdown {
  brokerage: number;
  stt: number;
  exchangeCharges: number;
  gst: number;
  sebiCharges: number;
  stampDuty: number;
  total: number;
}

export interface EnginePnlSummary {
  grossPnl: number;
  charges: ChargeBreakdown;
  netPnl: number;
  tradeCount: number;
}

export interface PortfolioSummaryResponse {
  paper: EnginePnlSummary;
  live: EnginePnlSummary;
  timestamp: string;
}

/** Sum all charge columns from an array of trade rows into a ChargeBreakdown. */
function sumCharges(
  rows: Array<{
    brokerage: string;
    stt: string;
    exchange_charges: string;
    gst: string;
    sebi_charges: string;
    stamp_duty: string;
  }>,
): ChargeBreakdown {
  const sum = (field: string[]) => field.reduce((a, v) => a + parseFloat(v || '0'), 0);
  return {
    brokerage: sum(rows.map((r) => r.brokerage)),
    stt: sum(rows.map((r) => r.stt)),
    exchangeCharges: sum(rows.map((r) => r.exchange_charges)),
    gst: sum(rows.map((r) => r.gst)),
    sebiCharges: sum(rows.map((r) => r.sebi_charges)),
    stampDuty: sum(rows.map((r) => r.stamp_duty)),
    total:
      sum(rows.map((r) => r.brokerage)) +
      sum(rows.map((r) => r.stt)) +
      sum(rows.map((r) => r.exchange_charges)) +
      sum(rows.map((r) => r.gst)) +
      sum(rows.map((r) => r.sebi_charges)) +
      sum(rows.map((r) => r.stamp_duty)),
  };
}

function buildSummary(
  rows: Array<{
    gross_pnl: string;
    net_pnl: string;
    brokerage: string;
    stt: string;
    exchange_charges: string;
    gst: string;
    sebi_charges: string;
    stamp_duty: string;
  }>,
): EnginePnlSummary {
  const grossPnl = rows.reduce((a, r) => a + parseFloat(r.gross_pnl || '0'), 0);
  const netPnl = rows.reduce((a, r) => a + parseFloat(r.net_pnl || '0'), 0);
  return {
    grossPnl: Math.round(grossPnl * 100) / 100,
    charges: sumCharges(rows),
    netPnl: Math.round(netPnl * 100) / 100,
    tradeCount: rows.length,
  };
}

@Controller('portfolio')
export class PortfolioController {
  constructor(
    @InjectRepository(PaperTrade)
    private readonly paperTradesRepo: Repository<PaperTrade>,

    @InjectRepository(Trade)
    private readonly tradesRepo: Repository<Trade>,
  ) {}

  /**
   * GET /portfolio/summary
   *
   * Returns today's session P&L for both engines with full charge breakdown.
   * "Today" is defined as trades closed since midnight UTC — covers the full
   * NSE trading session (09:15–15:30 IST) in a single calendar day.
   *
   * Response shape:
   * {
   *   paper: { grossPnl, charges: { brokerage, stt, ... }, netPnl, tradeCount },
   *   live:  { grossPnl, charges: { brokerage, stt, ... }, netPnl, tradeCount },
   *   timestamp: "2026-11-11T04:30:00.000Z"
   * }
   */
  @Get('summary')
  @UseGuards(JwtAuthGuard)
  async getSummary(): Promise<PortfolioSummaryResponse> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const [paperRows, liveRows] = await Promise.all([
      this.paperTradesRepo
        .createQueryBuilder('t')
        .select([
          't.gross_pnl',
          't.net_pnl',
          't.brokerage',
          't.stt',
          't.exchange_charges',
          't.gst',
          't.sebi_charges',
          't.stamp_duty',
        ])
        .where('t.exit_time >= :start', { start: startOfDay })
        .getRawMany<{
          t_gross_pnl: string;
          t_net_pnl: string;
          t_brokerage: string;
          t_stt: string;
          t_exchange_charges: string;
          t_gst: string;
          t_sebi_charges: string;
          t_stamp_duty: string;
        }>(),

      this.tradesRepo
        .createQueryBuilder('t')
        .select([
          't.gross_pnl',
          't.net_pnl',
          't.brokerage',
          't.stt',
          't.exchange_charges',
          't.gst',
          't.sebi_charges',
          't.stamp_duty',
        ])
        .where('t.exit_time >= :start', { start: startOfDay })
        .getRawMany<{
          t_gross_pnl: string;
          t_net_pnl: string;
          t_brokerage: string;
          t_stt: string;
          t_exchange_charges: string;
          t_gst: string;
          t_sebi_charges: string;
          t_stamp_duty: string;
        }>(),
    ]);

    // TypeORM getRawMany prefixes column names with the alias — normalise them.
    const normalise = (raw: Record<string, string>) => ({
      gross_pnl: raw['t_gross_pnl'] ?? raw['gross_pnl'] ?? '0',
      net_pnl: raw['t_net_pnl'] ?? raw['net_pnl'] ?? '0',
      brokerage: raw['t_brokerage'] ?? raw['brokerage'] ?? '0',
      stt: raw['t_stt'] ?? raw['stt'] ?? '0',
      exchange_charges: raw['t_exchange_charges'] ?? raw['exchange_charges'] ?? '0',
      gst: raw['t_gst'] ?? raw['gst'] ?? '0',
      sebi_charges: raw['t_sebi_charges'] ?? raw['sebi_charges'] ?? '0',
      stamp_duty: raw['t_stamp_duty'] ?? raw['stamp_duty'] ?? '0',
    });

    return {
      paper: buildSummary(paperRows.map((r) => normalise(r as unknown as Record<string, string>))),
      live: buildSummary(liveRows.map((r) => normalise(r as unknown as Record<string, string>))),
      timestamp: new Date().toISOString(),
    };
  }
}
