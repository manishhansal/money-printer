/**
 * orders.controller.ts
 *
 * GET /orders/today — returns all orders placed today for the React Orders panel.
 */

import { Controller, Get, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { Order } from '../../database/entities/orders.entity';
import { getISTStartOfDay } from '../../common/utils/ist-time.utils';

@Controller('orders')
export class OrdersController {
  constructor(
    @InjectRepository(Order)
    private readonly ordersRepo: Repository<Order>,
  ) {}

  /**
   * GET /orders/today?engine=LIVE|PAPER
   * Returns all orders created since midnight IST today.
   */
  @Get('today')
  async getTodayOrders(@Query('engine') engine?: string): Promise<Order[]> {
    const startOfDay = getISTStartOfDay();

    const whereClause: Record<string, unknown> = {
      created_at: MoreThanOrEqual(startOfDay),
    };
    if (engine === 'LIVE' || engine === 'PAPER') {
      whereClause['engine'] = engine;
    }

    return this.ordersRepo.find({
      where: whereClause as any,
      order: { created_at: 'DESC' },
      take: 200,
    });
  }
}
