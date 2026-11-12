/**
 * trades.controller.ts
 *
 * GET /trades/today?engine=LIVE|PAPER — returns today's closed trades
 * for the React TradeJournal panel.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { Trade } from '../../database/entities/trades.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { getISTStartOfDay } from '../../common/utils/ist-time.utils';

@Controller('trades')
export class TradesController {
  constructor(
    @InjectRepository(Trade)
    private readonly tradesRepo: Repository<Trade>,
    @InjectRepository(PaperTrade)
    private readonly paperTradesRepo: Repository<PaperTrade>,
  ) {}

  /**
   * GET /trades/today?engine=LIVE|PAPER
   * Returns all closed trades since midnight IST for the specified engine.
   */
  @Get('today')
  async getTodayTrades(@Query('engine') engine = 'PAPER') {
    const startOfDay = getISTStartOfDay();

    if (engine === 'LIVE') {
      return this.tradesRepo.find({
        where: { entry_time: MoreThanOrEqual(startOfDay) },
        order: { entry_time: 'DESC' },
        take: 100,
      });
    }

    return this.paperTradesRepo.find({
      where: { entry_time: MoreThanOrEqual(startOfDay) },
      order: { entry_time: 'DESC' },
      take: 100,
    });
  }
}
