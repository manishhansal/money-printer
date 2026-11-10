/**
 * sl-rejection-escalation.module.ts
 *
 * SlRejectionEscalationModule — NestJS feature module that provides
 * SlRejectionEscalationService for broker-side SL rejection escalation.
 *
 * This module is imported by TrailingStopModule so that the escalation
 * service is available wherever trailing stop management occurs.
 *
 * Requirements: 12.7, 12.8, 12.9
 */

import { Module } from '@nestjs/common';

import { NotificationModule } from '../notification/notification.module';
import { SlRejectionEscalationService } from './sl-rejection-escalation.service';

@Module({
  imports: [
    // Provides NotificationService for CRITICAL / MAX alert publishing.
    NotificationModule,
  ],
  providers: [SlRejectionEscalationService],
  exports: [SlRejectionEscalationService],
})
export class SlRejectionEscalationModule {}
