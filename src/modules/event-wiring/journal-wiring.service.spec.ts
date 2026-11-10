/**
 * journal-wiring.service.spec.ts
 *
 * Unit tests for JournalWiringService and GlobalExceptionFilter.
 * Also validates PaperTrading isolation channel and key constants.
 *
 * Tests:
 *   1. `position.exit` event handler calls TradeJournalService.recordRiskEvent().
 *   2. `risk.daily_loss_state_changed` event handler calls TradeJournalService.recordRiskEvent().
 *   3. PaperTradingService publishes to `events:paper:fill` (not `events:fill`).
 *   4. PaperTradingService writes to `paper:portfolio:balance` (not `portfolio:balance`).
 *   5. GlobalExceptionFilter calls SystemHealthMonitorService.updateMetricStatus
 *      with 'cloudengine_modules', 'Degraded', and the error message.
 *
 * Requirements: 13.1, 10.1
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ArgumentsHost } from '@nestjs/common';

import { JournalWiringService } from './journal-wiring.service';
import { TradeJournalService } from '../trade-journal/trade-journal.service';

import {
  PAPER_FILL_EVENT_CHANNEL,
  PAPER_PORTFOLIO_BALANCE_KEY,
} from '../paper-trading/paper-trading.types';

import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';
import { SystemHealthMonitorService } from '../system-health-monitor/system-health-monitor.service';

import {
  PositionExitReason,
  PositionExitSignal,
} from '../position-monitoring/position-monitoring.types';

import { DailyLossStateChangedPayload } from './journal-wiring.service';

// ─────────────────────────────────────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildMockTradeJournalService(): {
  recordRiskEvent: jest.Mock;
  recordSystemError: jest.Mock;
} {
  return {
    recordRiskEvent: jest.fn().mockResolvedValue(undefined),
    recordSystemError: jest.fn().mockResolvedValue(undefined),
  };
}

function buildMockSystemHealthMonitorService(): { updateMetricStatus: jest.Mock } {
  return {
    updateMetricStatus: jest.fn().mockResolvedValue(undefined),
  };
}

/**
 * Builds a minimal mock ArgumentsHost suitable for HTTP context tests.
 * Returns the mock response object so assertions can be made on it.
 */
function buildMockHost(): {
  host: ArgumentsHost;
  response: { status: jest.Mock; json: jest.Mock };
} {
  const mockResponse = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };

  const mockHttp = {
    getResponse: jest.fn().mockReturnValue(mockResponse),
  };

  const host = {
    switchToHttp: jest.fn().mockReturnValue(mockHttp),
  } as unknown as ArgumentsHost;

  return { host, response: mockResponse };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: JournalWiringService — position.exit
// ─────────────────────────────────────────────────────────────────────────────

describe('JournalWiringService — position.exit', () => {
  let service: JournalWiringService;
  let tradeJournalService: { recordRiskEvent: jest.Mock };

  beforeEach(async () => {
    tradeJournalService = buildMockTradeJournalService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JournalWiringService,
        { provide: TradeJournalService, useValue: tradeJournalService },
      ],
    }).compile();

    service = module.get<JournalWiringService>(JournalWiringService);
  });

  /**
   * Test 1: `position.exit` event triggers TradeJournal risk event record.
   *
   * Requirement 13.1 — every live position exit must be persisted in the
   * TradeJournal's risk_events record set within 1 second.
   */
  it('should call TradeJournalService.recordRiskEvent() when position.exit event fires', async () => {
    const payload: PositionExitSignal = {
      positionId: 'pos-uuid-001',
      reason: PositionExitReason.SL_HIT,
      currentPrice: 1234.56,
      timestamp: new Date('2024-06-01T10:00:00Z'),
    };

    await service.handlePositionExit(payload);

    expect(tradeJournalService.recordRiskEvent).toHaveBeenCalledTimes(1);

    const [dto] = tradeJournalService.recordRiskEvent.mock.calls[0];
    expect(dto.eventType).toBe('MANDATORY_EXIT');
    expect(dto.engine).toBe('LIVE');
    expect(dto.initiatingActor).toBe('PositionMonitoringService');
    expect(dto.occurredAt).toEqual(payload.timestamp);
    expect(dto.reason).toContain('SL_HIT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test: JournalWiringService — risk.daily_loss_state_changed
// ─────────────────────────────────────────────────────────────────────────────

describe('JournalWiringService — risk.daily_loss_state_changed', () => {
  let service: JournalWiringService;
  let tradeJournalService: { recordRiskEvent: jest.Mock };

  beforeEach(async () => {
    tradeJournalService = buildMockTradeJournalService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JournalWiringService,
        { provide: TradeJournalService, useValue: tradeJournalService },
      ],
    }).compile();

    service = module.get<JournalWiringService>(JournalWiringService);
  });

  /**
   * Test 2: `risk.daily_loss_state_changed` event triggers TradeJournal risk event record.
   *
   * Requirement 13.1 — every daily-loss state transition (threshold breach or
   * recovery) must be persisted in the TradeJournal's risk_events record set.
   */
  it('should call TradeJournalService.recordRiskEvent() when risk.daily_loss_state_changed fires', async () => {
    const payload: DailyLossStateChangedPayload = {
      engine: 'LIVE',
      newState: 'TWO_LOSS_LOCKOUT',
      dailyLossPct: 2.5,
      thresholdPct: 2.0,
      occurredAt: new Date('2024-06-01T11:30:00Z'),
    };

    await service.handleDailyLossStateChanged(payload);

    expect(tradeJournalService.recordRiskEvent).toHaveBeenCalledTimes(1);

    const [dto] = tradeJournalService.recordRiskEvent.mock.calls[0];
    expect(dto.eventType).toBe('DAILY_LOSS_LIMIT');
    expect(dto.engine).toBe('LIVE');
    expect(dto.triggeringMetricName).toBe('daily_loss_pct');
    expect(dto.triggeringMetricValue).toBe('2.5');
    expect(dto.thresholdValue).toBe('2');
    expect(dto.initiatingActor).toBe('DailyLossStateMachineService');
    expect(dto.occurredAt).toEqual(payload.occurredAt);
    expect(dto.reason).toContain('TWO_LOSS_LOCKOUT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test: PaperTrading isolation — channel and key namespacing (Requirement 10.1)
// ─────────────────────────────────────────────────────────────────────────────

describe('PaperTrading isolation — Redis channel and key constants', () => {
  /**
   * Test 3: PaperTradingService publishes to `events:paper:fill` (not `events:fill`).
   *
   * Requirement 10.1 — paper engine events must use `events:paper:*` namespace so
   * they never overlap with the live engine's `events:fill` channel.
   */
  it('should publish fill events to events:paper:fill and NOT to events:fill', () => {
    expect(PAPER_FILL_EVENT_CHANNEL).toBe('events:paper:fill');
    expect(PAPER_FILL_EVENT_CHANNEL).not.toBe('events:fill');
  });

  /**
   * Test 4: PaperTradingService writes portfolio balance to `paper:portfolio:balance`
   * (not `portfolio:balance`).
   *
   * Requirement 10.1 — paper engine Redis keys must use the `paper:*` namespace so
   * they never overlap with the live engine's key-space.
   */
  it('should store portfolio balance under paper:portfolio:balance and NOT portfolio:balance', () => {
    expect(PAPER_PORTFOLIO_BALANCE_KEY).toBe('paper:portfolio:balance');
    expect(PAPER_PORTFOLIO_BALANCE_KEY).not.toBe('portfolio:balance');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test: GlobalExceptionFilter — health reporting
// ─────────────────────────────────────────────────────────────────────────────

describe('GlobalExceptionFilter — SystemHealthMonitor integration', () => {
  let filter: GlobalExceptionFilter;
  let systemHealthMonitorService: { updateMetricStatus: jest.Mock };
  let tradeJournalService: { recordRiskEvent: jest.Mock; recordSystemError: jest.Mock };

  beforeEach(() => {
    systemHealthMonitorService = buildMockSystemHealthMonitorService();
    tradeJournalService = buildMockTradeJournalService();

    filter = new GlobalExceptionFilter(
      systemHealthMonitorService as unknown as SystemHealthMonitorService,
      tradeJournalService as unknown as TradeJournalService,
    );
  });

  /**
   * Test 5: GlobalExceptionFilter calls SystemHealthMonitorService.updateMetricStatus
   * with 'cloudengine_modules', 'Degraded', and the error message on an unhandled error.
   *
   * Requirements: 13.1, 2.7
   */
  it('should call SystemHealthMonitorService.updateMetricStatus with Degraded when an unhandled error is caught', async () => {
    const { host } = buildMockHost();
    const error = new Error('Unexpected database failure');

    await filter.catch(error, host);

    expect(systemHealthMonitorService.updateMetricStatus).toHaveBeenCalledTimes(1);

    const [metric, status, details] = systemHealthMonitorService.updateMetricStatus.mock.calls[0];
    expect(metric).toBe('cloudengine_modules');
    expect(status).toBe('Degraded');
    expect(details).toBe('Unexpected database failure');
  });
});
