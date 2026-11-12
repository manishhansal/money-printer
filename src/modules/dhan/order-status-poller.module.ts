/**
 * order-status-poller.module.ts
 *
 * Registers OrderStatusPollerService which polls Dhan every 15 seconds during
 * market hours to detect FILLED / PARTIAL_FILL / REJECTED order transitions.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

import { Order } from '../../database/entities/orders.entity';
import { DhanApiModule } from './dhan-api.module';
import { SessionManagerModule } from '../session-manager/session-manager.module';
import { NotificationModule } from '../notification/notification.module';
import { OrderStatusPollerService } from './order-status-poller.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([Order]),
    DhanApiModule,
    SessionManagerModule,
    NotificationModule,
  ],
  providers: [OrderStatusPollerService],
  exports: [OrderStatusPollerService],
})
export class OrderStatusPollerModule {}
