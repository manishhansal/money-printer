/**
 * trailing-stop.module.ts
 *
 * TrailingStopModule — NestJS feature module that provides:
 *
 *  - TrailingStopService          — all 8 trailing stop mechanism computations
 *                                   (Requirements 12.1, 12.6)
 *  - SlRejectionEscalationService — broker-side SL rejection escalation ladder
 *                                   (Requirements 12.7, 12.8, 12.9)
 *
 * Other modules that need to compute trailing stop levels or handle SL
 * rejection escalation should import this module.
 *
 * Requirements: 12.1, 12.6, 12.7, 12.8, 12.9
 */

import { Module } from '@nestjs/common';

import { SlRejectionEscalationModule } from './sl-rejection-escalation.module';
import { TrailingStopService } from './trailing-stop.service';

@Module({
  imports: [
    // Provides SlRejectionEscalationService + re-exports NotificationModule.
    SlRejectionEscalationModule,
  ],
  providers: [TrailingStopService],
  exports: [
    TrailingStopService,
    // Re-export so consumers of TrailingStopModule can inject
    // SlRejectionEscalationService without importing the sub-module directly.
    SlRejectionEscalationModule,
  ],
})
export class TrailingStopModule {}
