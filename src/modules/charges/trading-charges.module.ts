import { Module } from '@nestjs/common';
import { TradingChargesService } from './trading-charges.service';

/**
 * TradingChargesModule
 *
 * Provides and exports TradingChargesService — the single authoritative
 * source of NSE F&O charge calculations. Import this module in any module
 * that needs to compute trading costs (PaperTrading, Backtest, Execution).
 */
@Module({
  providers: [TradingChargesService],
  exports: [TradingChargesService],
})
export class TradingChargesModule {}
