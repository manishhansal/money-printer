/**
 * paper-trading.controller.ts
 *
 * Public REST endpoints for the paper trading engine.
 * No JWT required — the Chrome Extension polls these endpoints without an
 * authenticated session to display open paper positions.
 */

import { Controller, Get } from '@nestjs/common';
import { PaperTradingService } from './paper-trading.service';

export interface PaperPositionSummary {
  id: string;
  instrument_id: string;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  average_entry_price: string;
  unrealized_pnl: string;
  opened_at: Date;
}

@Controller('paper-trading')
export class PaperTradingController {
  constructor(private readonly paperTradingService: PaperTradingService) {}

  /**
   * Returns all currently open paper positions.
   *
   * Public — no JWT needed. The Chrome Extension sidepanel polls this
   * every 15 seconds to populate the LIVE POSITIONS table with paper P&L.
   *
   * GET /paper-trading/positions
   */
  @Get('positions')
  async getOpenPositions(): Promise<PaperPositionSummary[]> {
    const positions = await this.paperTradingService.getOpenPaperPositions();
    return positions.map((p) => ({
      id: p.id,
      instrument_id: p.instrument_id,
      direction: p.direction as 'LONG' | 'SHORT',
      quantity: p.quantity,
      average_entry_price: p.average_entry_price,
      unrealized_pnl: p.unrealized_pnl ?? '0',
      opened_at: p.opened_at,
    }));
  }

  /**
   * Returns the current paper portfolio balance from Redis.
   *
   * Public — used by the Chrome Extension popup to display P&L.
   *
   * GET /paper-trading/balance
   */
  @Get('balance')
  async getBalance(): Promise<{ balance: string }> {
    const balance = await this.paperTradingService.getPortfolioBalance();
    return { balance };
  }
}
