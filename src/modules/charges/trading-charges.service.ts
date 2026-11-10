/**
 * trading-charges.service.ts
 *
 * Single authoritative source for NSE F&O options trading charge calculations.
 *
 * Replaces the duplicated private `calculateTradingCosts()` methods in
 * PaperTradingService and BacktestService, ensuring cost-model parity across
 * all engines (live, paper, backtest).
 *
 * Rate basis: Dhan broker, NSE options, effective October 2024.
 *
 *   Component          Rate                        Applied on
 *   ─────────────────  ──────────────────────────  ───────────────────────
 *   Brokerage          ₹20 flat per order × 2      both legs (entry + exit)
 *   STT                0.1% of sell-side premium   sell leg only  (Budget 2024)
 *   Exchange charges   0.053% of total turnover    buy + sell
 *   GST                18% of (brokerage + exchange) both legs
 *   SEBI charges       ₹10 per crore turnover      buy + sell
 *   Stamp duty         0.003% of buy-side turnover buy leg only
 */

import { Injectable } from '@nestjs/common';
import { TradingCharges } from './trading-charges.types';

@Injectable()
export class TradingChargesService {
  // ── Rate constants (all named for auditability) ───────────────────────────

  /** ₹20 flat per executed order. Multiply by 2 for a round-trip trade. */
  static readonly BROKERAGE_PER_ORDER = 20;

  /**
   * STT rate on sell-side premium.
   * Increased from 0.0625% to 0.1% by the Union Budget 2024
   * (effective 1 October 2024).
   */
  static readonly STT_RATE = 0.001; // 0.1%

  /** NSE exchange transaction charge (flat rate, effective post-Oct 2023). */
  static readonly EXCHANGE_CHARGE_RATE = 0.00053; // 0.053%

  /** GST rate applied on brokerage + exchange charges. */
  static readonly GST_RATE = 0.18; // 18%

  /**
   * SEBI regulatory turnover fee.
   * ₹10 per crore = ₹10 / ₹1,00,00,000 = 0.000001.
   */
  static readonly SEBI_RATE = 0.000001; // ₹10/crore

  /** Stamp duty on buy-side turnover only. */
  static readonly STAMP_DUTY_RATE = 0.00003; // 0.003%

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Calculate all NSE F&O options trading charges for a single round-trip trade.
   *
   * @param entryPrice  Volume-weighted average entry price (INR per unit).
   * @param exitPrice   Volume-weighted average exit price (INR per unit).
   * @param quantity    Number of units (not lots).
   * @returns           Full charge breakdown plus total (all in INR).
   *
   * @example
   * // Nifty CE bought at ₹150, sold at ₹200, 50 units
   * const charges = chargesService.calculate(150, 200, 50);
   * // charges.stt     = 200 * 50 * 0.001 = ₹10.00
   * // charges.total   ≈ ₹57.95
   * // net P&L         = (200-150)*50 - 57.95 = ₹2492.05
   */
  calculate(entryPrice: number, exitPrice: number, quantity: number): TradingCharges {
    const buyTurnover = entryPrice * quantity;
    const sellTurnover = exitPrice * quantity;
    const totalTurnover = buyTurnover + sellTurnover;

    const brokerage = TradingChargesService.BROKERAGE_PER_ORDER * 2;
    const stt = sellTurnover * TradingChargesService.STT_RATE;
    const exchangeCharges = totalTurnover * TradingChargesService.EXCHANGE_CHARGE_RATE;
    const gst = (brokerage + exchangeCharges) * TradingChargesService.GST_RATE;
    const sebiCharges = totalTurnover * TradingChargesService.SEBI_RATE;
    const stampDuty = buyTurnover * TradingChargesService.STAMP_DUTY_RATE;

    const total = brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty;

    return { brokerage, stt, exchangeCharges, gst, sebiCharges, stampDuty, total };
  }

  /**
   * Format a TradingCharges breakdown as a human-readable string.
   * Useful for log lines and trade journal notes.
   *
   * @example
   * "Brokerage: ₹40.00 | STT: ₹10.0000 | Exchange: ₹1.8550 | GST: ₹7.5339 | SEBI: ₹0.0175 | Stamp: ₹0.2250 | Total: ₹59.6264"
   */
  formatBreakdown(charges: TradingCharges): string {
    return (
      `Brokerage: ₹${charges.brokerage.toFixed(2)} | ` +
      `STT: ₹${charges.stt.toFixed(4)} | ` +
      `Exchange: ₹${charges.exchangeCharges.toFixed(4)} | ` +
      `GST: ₹${charges.gst.toFixed(4)} | ` +
      `SEBI: ₹${charges.sebiCharges.toFixed(4)} | ` +
      `Stamp: ₹${charges.stampDuty.toFixed(4)} | ` +
      `Total: ₹${charges.total.toFixed(4)}`
    );
  }
}
