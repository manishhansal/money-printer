/**
 * signal-dispatcher.service.spec.ts
 *
 * Unit tests for SignalDispatcherService — the event-driven routing layer that
 * directs accepted signals to either the paper or live execution engine.
 *
 * Coverage (24 tests):
 *
 *  Routing:
 *   1.  Routes to paper when payload.engine === 'PAPER'
 *   2.  Routes to live when payload.engine === 'LIVE' and engine is ARMED
 *   3.  Does NOT route to live when engine === 'PAPER' even if ARMED
 *   4.  Does NOT route to paper when engine === 'LIVE'
 *
 *  Paper path guards:
 *   5.  Skips BUY when an open LONG paper position already exists for the instrument
 *   6.  Proceeds BUY when no existing LONG paper position exists
 *   7.  Rejects when instrument not found in DB
 *   8.  Rejects when instrument has invalid lotSize (0)
 *   9.  Converts positionSize × lotSize into quantityUnits correctly (1 lot × 75 = 75)
 *  10.  Converts positionSize × lotSize for a 2-lot position (2 × 25 = 50)
 *
 *  Live path guards:
 *  11.  Skips live dispatch when engine is NOT armed
 *  12.  Skips live dispatch when new entries are blocked
 *  13.  Rejects live dispatch when instrument not found in DB
 *  14.  Rejects live dispatch when instrument has invalid lotSize
 *  15.  Converts lots → units correctly on the live path (3 × 50 = 150)
 *  16.  Passes requiredMargin calculated from actual portfolio capital
 *
 *  Payload validation:
 *  17.  Silently ignores payload that fails the type-guard check
 *  18.  Processes valid payload with all required fields present
 *
 *  Idempotency key correctness (NEW_BUG_B / NEW_BUG_F regression):
 *  19.  PAPER path idempotency key is deterministic: 'signal-{signalId}' (no Date.now())
 *  20.  LIVE path idempotency key is deterministic: 'signal-{signalId}' (no uuidv4)
 *  21.  Two PAPER dispatches for the same signalId use the same idempotency key
 *  22.  Two LIVE dispatches for the same signalId use the same idempotency key
 *
 *  In-process submission lock (NEW_BUG_A regression):
 *  23.  Second concurrent LIVE dispatch for the same instrument+direction is skipped
 *  24.  Lock is released after the first dispatch completes (next signal can proceed)
 *
 * All tests use in-memory stubs — no real database, Redis or broker connection needed.
 *
 * Requirements: DEFECT-001, DEFECT-007, NEW_BUG_A, NEW_BUG_B, NEW_BUG_F
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Instruments } from '../../database/entities/instruments.entity';
import { UserSettings } from '../../database/entities/user-settings.entity';
import { PaperTradingService } from '../paper-trading/paper-trading.service';
import { ExecutionService } from '../execution/execution.service';
import { LiveTradingService } from '../live-trading/live-trading.service';
import { PortfolioService } from '../portfolio/portfolio.service';
import { DhanApiClient } from '../dhan/dhan-api.client';
import { RiskManagementService } from '../risk-management/risk-management.service';
import { SignalDispatcherService } from './signal-dispatcher.service';
import { SignalAcceptedEventPayload } from './signal-scanner.types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeInstrument(overrides: Partial<Instruments> = {}): Instruments {
  return {
    id: 'inst-uuid-1',
    tradingSymbol: 'NIFTY24DEC20000CE',
    securityId: '12345',
    lotSize: 75,
    freezeQuantity: 1800,
    exchange: 'NSE',
    segment: 'D',
    instrumentType: 'OPTIDX',
    underlyingSymbol: 'NIFTY',
    ...overrides,
  } as Instruments;
}

function makePayload(
  overrides: Partial<SignalAcceptedEventPayload> = {},
): SignalAcceptedEventPayload {
  return {
    signalId: 'sig-1',
    instrumentId: 'inst-uuid-1',
    strategyId: 'strat-1',
    engine: 'PAPER',
    direction: 'BUY',
    entryPrice: '100.00',
    stopLossPrice: '98.50',
    targetPrice: '103.00',
    compositeScore: 85,
    positionSize: 1,
    securityId: '12345',
    regime: null,
    ...overrides,
  };
}

interface MockDeps {
  service: SignalDispatcherService;
  paperTradingService: { submitPaperOrder: jest.Mock; getOpenPaperPositions: jest.Mock };
  executionService: { placeOrder: jest.Mock };
  liveTradingService: {
    isArmed: jest.Mock;
    isNewEntryBlocked: jest.Mock;
    getArmedState: jest.Mock;
  };
  portfolioService: { getDynamicCapital: jest.Mock; getOpenPositions: jest.Mock };
  riskManagementService: { computePositionSize: jest.Mock };
  dhanApiClient: { calculateMargin: jest.Mock };
  instrumentsRepo: { findOne: jest.Mock };
  userSettingsRepo: { findOne: jest.Mock };
}

async function buildService(
  overrides: { isArmed?: boolean; entriesBlocked?: boolean; suggestedLots?: number } = {},
): Promise<MockDeps> {
  const paperTradingService = {
    submitPaperOrder: jest.fn().mockResolvedValue({
      status: 'complete',
      orderId: 'paper-1',
      fillPrice: 100.5,
      simulatedLatencyMs: 150,
      rejectionReason: null,
    }),
    getOpenPaperPositions: jest.fn().mockResolvedValue([]),
  };

  const executionService = {
    placeOrder: jest
      .fn()
      .mockResolvedValue({ status: 'submitted', orderId: 'live-1', dhanOrderId: 'dhan-1' }),
  };

  const liveTradingService = {
    isArmed: jest.fn().mockReturnValue(overrides.isArmed ?? false),
    isNewEntryBlocked: jest.fn().mockReturnValue(overrides.entriesBlocked ?? false),
    // getArmedState is called in the warn-log message when isArmed() returns false.
    // Without this mock the warning string interpolation throws TypeError, which is
    // silently caught by onSignalAccepted's try-catch — masking the real guard path.
    // Fix for NEW_BUG_J: include getArmedState so tests exercise the correct code path.
    getArmedState: jest.fn().mockReturnValue(overrides.isArmed ? 'ARMED' : 'DISARMED'),
  };

  const portfolioService = {
    getDynamicCapital: jest.fn().mockReturnValue('200000.00'),
    getOpenPositions: jest.fn().mockReturnValue([]),
  };

  // RiskManagementService mock — computePositionSize returns the configured
  // suggestedLots (default 1) so lot-conversion tests can control the result.
  const riskManagementService = {
    computePositionSize: jest.fn().mockReturnValue(overrides.suggestedLots ?? 1),
  };

  const dhanApiClient = {
    calculateMargin: jest.fn().mockResolvedValue({ availableMargin: 50000, requiredMargin: 7500 }),
  };

  const instrumentsRepo = {
    findOne: jest.fn().mockResolvedValue(makeInstrument()),
  };

  const userSettingsRepo = {
    findOne: jest.fn().mockResolvedValue({ defaultRiskPercentage: '1.5000' }),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SignalDispatcherService,
      { provide: PaperTradingService, useValue: paperTradingService },
      { provide: ExecutionService, useValue: executionService },
      { provide: LiveTradingService, useValue: liveTradingService },
      { provide: PortfolioService, useValue: portfolioService },
      { provide: RiskManagementService, useValue: riskManagementService },
      { provide: DhanApiClient, useValue: dhanApiClient },
      { provide: getRepositoryToken(Instruments), useValue: instrumentsRepo },
      { provide: getRepositoryToken(UserSettings), useValue: userSettingsRepo },
    ],
  }).compile();

  return {
    service: module.get(SignalDispatcherService),
    paperTradingService,
    executionService,
    liveTradingService,
    portfolioService,
    riskManagementService,
    dhanApiClient,
    instrumentsRepo,
    userSettingsRepo,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1–4. Routing decisions
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalDispatcherService — routing', () => {
  it('routes to paper when payload.engine === "PAPER"', async () => {
    const { service, paperTradingService, executionService } = await buildService();
    const payload = makePayload({ engine: 'PAPER' });

    await service.onSignalAccepted(payload);

    expect(paperTradingService.submitPaperOrder).toHaveBeenCalledTimes(1);
    expect(executionService.placeOrder).not.toHaveBeenCalled();
  });

  it('routes to live when payload.engine === "LIVE" and engine is ARMED', async () => {
    const { service, executionService, paperTradingService } = await buildService({
      isArmed: true,
    });
    const payload = makePayload({ engine: 'LIVE' });

    await service.onSignalAccepted(payload);

    expect(executionService.placeOrder).toHaveBeenCalledTimes(1);
    expect(paperTradingService.submitPaperOrder).not.toHaveBeenCalled();
  });

  it('does NOT route to live when engine === "PAPER" even if ARMED', async () => {
    const { service, executionService } = await buildService({ isArmed: true });
    const payload = makePayload({ engine: 'PAPER' });

    await service.onSignalAccepted(payload);

    expect(executionService.placeOrder).not.toHaveBeenCalled();
  });

  it('does NOT route to paper when engine === "LIVE"', async () => {
    const { service, paperTradingService } = await buildService({ isArmed: true });
    const payload = makePayload({ engine: 'LIVE' });

    await service.onSignalAccepted(payload);

    expect(paperTradingService.submitPaperOrder).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5–10. Paper path guards
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalDispatcherService — paper path guards', () => {
  it('skips BUY when an open LONG paper position already exists for the instrument', async () => {
    const { service, paperTradingService } = await buildService();
    // Simulate an already-open LONG position on inst-uuid-1
    paperTradingService.getOpenPaperPositions.mockResolvedValue([
      { instrument_id: 'inst-uuid-1', direction: 'LONG' },
    ]);

    await service.onSignalAccepted(makePayload({ engine: 'PAPER', direction: 'BUY' }));

    expect(paperTradingService.submitPaperOrder).not.toHaveBeenCalled();
  });

  it('proceeds BUY when no existing LONG paper position exists for the instrument', async () => {
    const { service, paperTradingService } = await buildService();
    paperTradingService.getOpenPaperPositions.mockResolvedValue([]); // no open positions

    await service.onSignalAccepted(makePayload({ engine: 'PAPER', direction: 'BUY' }));

    expect(paperTradingService.submitPaperOrder).toHaveBeenCalledTimes(1);
  });

  it('rejects paper dispatch when instrument not found in DB', async () => {
    const { service, paperTradingService, instrumentsRepo } = await buildService();
    instrumentsRepo.findOne.mockResolvedValue(null); // instrument not found

    await service.onSignalAccepted(makePayload({ engine: 'PAPER' }));

    expect(paperTradingService.submitPaperOrder).not.toHaveBeenCalled();
  });

  it('rejects paper dispatch when instrument has lotSize=0', async () => {
    const { service, paperTradingService, instrumentsRepo } = await buildService();
    instrumentsRepo.findOne.mockResolvedValue(makeInstrument({ lotSize: 0 }));

    await service.onSignalAccepted(makePayload({ engine: 'PAPER' }));

    expect(paperTradingService.submitPaperOrder).not.toHaveBeenCalled();
  });

  it('converts 1 lot × 75 (NIFTY) = 75 units on the paper path', async () => {
    const { service, paperTradingService, instrumentsRepo } = await buildService();
    instrumentsRepo.findOne.mockResolvedValue(makeInstrument({ lotSize: 75 }));

    await service.onSignalAccepted(makePayload({ engine: 'PAPER', positionSize: 1 }));

    const callArg = paperTradingService.submitPaperOrder.mock.calls[0][0];
    expect(callArg.quantity).toBe(75);
    expect(callArg.lotSize).toBe(75);
    expect(callArg.selectedLots).toBe(1);
  });

  it('converts 2 lots × 25 (FINNIFTY) = 50 units on the paper path', async () => {
    // Risk engine mock returns 2 lots; dispatcher should convert to 2 × 25 = 50 units.
    const { service, paperTradingService, instrumentsRepo } = await buildService({
      suggestedLots: 2,
    });
    instrumentsRepo.findOne.mockResolvedValue(makeInstrument({ lotSize: 25 }));

    await service.onSignalAccepted(makePayload({ engine: 'PAPER', positionSize: 1 }));

    const callArg = paperTradingService.submitPaperOrder.mock.calls[0][0];
    expect(callArg.quantity).toBe(50); // 2 lots × 25 units/lot
    expect(callArg.lotSize).toBe(25);
    expect(callArg.selectedLots).toBe(2); // risk engine result, not positionSize
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11–16. Live path guards
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalDispatcherService — live path guards', () => {
  it('skips live dispatch when engine is NOT armed', async () => {
    const { service, executionService } = await buildService({ isArmed: false });

    await service.onSignalAccepted(makePayload({ engine: 'LIVE' }));

    expect(executionService.placeOrder).not.toHaveBeenCalled();
  });

  it('skips live dispatch when new entries are blocked', async () => {
    const { service, executionService } = await buildService({
      isArmed: true,
      entriesBlocked: true,
    });

    await service.onSignalAccepted(makePayload({ engine: 'LIVE' }));

    expect(executionService.placeOrder).not.toHaveBeenCalled();
  });

  it('rejects live dispatch when instrument not found in DB', async () => {
    const { service, executionService, instrumentsRepo } = await buildService({ isArmed: true });
    instrumentsRepo.findOne.mockResolvedValue(null);

    await service.onSignalAccepted(makePayload({ engine: 'LIVE' }));

    expect(executionService.placeOrder).not.toHaveBeenCalled();
  });

  it('rejects live dispatch when instrument has lotSize=0', async () => {
    const { service, executionService, instrumentsRepo } = await buildService({ isArmed: true });
    instrumentsRepo.findOne.mockResolvedValue(makeInstrument({ lotSize: 0 }));

    await service.onSignalAccepted(makePayload({ engine: 'LIVE' }));

    expect(executionService.placeOrder).not.toHaveBeenCalled();
  });

  it('converts 3 lots × 50 = 150 units on the live path', async () => {
    // Risk engine mock returns 3 lots; dispatcher should convert to 3 × 50 = 150 units.
    const { service, executionService, instrumentsRepo } = await buildService({
      isArmed: true,
      suggestedLots: 3,
    });
    instrumentsRepo.findOne.mockResolvedValue(makeInstrument({ lotSize: 50 }));

    await service.onSignalAccepted(makePayload({ engine: 'LIVE', positionSize: 1 }));

    const callArg = executionService.placeOrder.mock.calls[0][0];
    expect(callArg.quantity).toBe(150); // 3 lots × 50 units/lot
    expect(callArg.selectedLots).toBe(3); // risk engine result, not positionSize
  });

  it('passes requiredMargin derived from portfolio capital on the live path', async () => {
    const { service, executionService, instrumentsRepo, portfolioService } = await buildService({
      isArmed: true,
    });
    instrumentsRepo.findOne.mockResolvedValue(makeInstrument({ lotSize: 75 }));
    portfolioService.getDynamicCapital.mockReturnValue('500000.00');

    await service.onSignalAccepted(makePayload({ engine: 'LIVE', positionSize: 1 }));

    const callArg = executionService.placeOrder.mock.calls[0][0];
    // requiredMargin must be a number and must be > 0
    expect(typeof callArg.requiredMargin).toBe('number');
    expect(callArg.requiredMargin).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17–18. Payload validation
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalDispatcherService — payload validation', () => {
  it('silently ignores payload that fails the type-guard check (missing required fields)', async () => {
    const { service, paperTradingService, executionService } = await buildService();

    // Invalid payload — missing required fields
    await service.onSignalAccepted({ foo: 'bar' } as unknown);

    expect(paperTradingService.submitPaperOrder).not.toHaveBeenCalled();
    expect(executionService.placeOrder).not.toHaveBeenCalled();
  });

  it('processes valid PAPER payload with all required fields present', async () => {
    const { service, paperTradingService } = await buildService();
    const payload = makePayload({
      engine: 'PAPER',
      compositeScore: 90,
      positionSize: 1,
    });

    await service.onSignalAccepted(payload);

    expect(paperTradingService.submitPaperOrder).toHaveBeenCalledTimes(1);
    const callArg = paperTradingService.submitPaperOrder.mock.calls[0][0];
    expect(callArg.signalScore).toBe(90);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 19–22. Idempotency key correctness (NEW_BUG_B / NEW_BUG_F regression)
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalDispatcherService — idempotency key correctness', () => {
  it('PAPER path: idempotency key is signal-{signalId} (no Date.now() suffix — NEW_BUG_F regression)', async () => {
    const { service, paperTradingService } = await buildService();
    const payload = makePayload({ engine: 'PAPER', signalId: 'sig-deterministic-1' });

    await service.onSignalAccepted(payload);

    const callArg = paperTradingService.submitPaperOrder.mock.calls[0][0];
    // Key must be exactly 'signal-sig-deterministic-1' — no Date.now() appended
    expect(callArg.idempotencyKey).toBe('signal-sig-deterministic-1');
    // Verify it does NOT contain a hyphen followed by digits (would indicate Date.now())
    expect(callArg.idempotencyKey).toMatch(/^signal-sig-deterministic-1$/);
  });

  it('LIVE path: idempotency key is signal-{signalId} (no uuidv4 — NEW_BUG_B regression)', async () => {
    const { service, executionService } = await buildService({ isArmed: true });
    const payload = makePayload({ engine: 'LIVE', signalId: 'sig-deterministic-2' });

    await service.onSignalAccepted(payload);

    const callArg = executionService.placeOrder.mock.calls[0][0];
    // Key must be exactly 'signal-sig-deterministic-2' — not a UUID
    expect(callArg.idempotencyKey).toBe('signal-sig-deterministic-2');
    // UUID pattern would be 8-4-4-4-12 hex chars — verify the key is NOT a UUID
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(callArg.idempotencyKey).not.toMatch(uuidPattern);
  });

  it('Two PAPER dispatches for the same signalId produce the same idempotency key', async () => {
    const { service, paperTradingService } = await buildService();
    const payload = makePayload({ engine: 'PAPER', signalId: 'sig-same-id' });

    // First dispatch
    await service.onSignalAccepted(payload);
    const key1 = paperTradingService.submitPaperOrder.mock.calls[0][0].idempotencyKey as string;

    // Second dispatch (simulating duplicate event delivery or retry)
    await service.onSignalAccepted(payload);
    const key2 = paperTradingService.submitPaperOrder.mock.calls[1][0].idempotencyKey as string;

    // Both calls must use the same key — PaperTradingService's idempotency guard
    // will reject the second call when it finds the key already in Redis.
    expect(key1).toBe(key2);
    expect(key1).toBe('signal-sig-same-id');
  });

  it('Two LIVE dispatches for the same signalId produce the same idempotency key', async () => {
    const { service, executionService } = await buildService({ isArmed: true });
    const payload = makePayload({ engine: 'LIVE', signalId: 'sig-same-live-id' });

    await service.onSignalAccepted(payload);
    const key1 = executionService.placeOrder.mock.calls[0][0].idempotencyKey as string;

    await service.onSignalAccepted(payload);
    const key2 = executionService.placeOrder.mock.calls[1][0].idempotencyKey as string;

    expect(key1).toBe(key2);
    expect(key1).toBe('signal-sig-same-live-id');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 23–24. In-process submission lock (NEW_BUG_A regression)
// ─────────────────────────────────────────────────────────────────────────────

describe('SignalDispatcherService — in-process submission lock', () => {
  it('skips LIVE dispatch when activeSubmissions lock is already held for the same instrument+direction', async () => {
    // Directly manipulate the in-process lock to simulate a concurrent dispatch
    // already in-flight. This tests the lock check without race-condition timing
    // complexity from async mock resolution.
    const { service, executionService } = await buildService({ isArmed: true });

    // Simulate a concurrent dispatch holding the lock for inst-uuid-1 BUY
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    svc.activeSubmissions.add('inst-uuid-1:BUY');

    const payload = makePayload({ engine: 'LIVE', instrumentId: 'inst-uuid-1', direction: 'BUY' });
    await service.onSignalAccepted(payload);

    // Lock was held — placeOrder must NOT have been called
    expect(executionService.placeOrder).not.toHaveBeenCalled();
  });

  it('lock is released after the first dispatch completes — a subsequent signal can proceed', async () => {
    const { service, executionService } = await buildService({ isArmed: true });
    const payload = makePayload({
      engine: 'LIVE',
      signalId: 'sig-first',
      instrumentId: 'inst-lock-release-test',
    });

    // First dispatch completes normally — lock is acquired and released
    await service.onSignalAccepted(payload);
    expect(executionService.placeOrder).toHaveBeenCalledTimes(1);

    // After the first dispatch the lock must be released
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    expect(svc.activeSubmissions.has('inst-lock-release-test:BUY')).toBe(false);

    // Second dispatch for the same instrument succeeds (lock is free)
    await service.onSignalAccepted(
      makePayload({
        engine: 'LIVE',
        signalId: 'sig-second',
        instrumentId: 'inst-lock-release-test',
      }),
    );
    expect(executionService.placeOrder).toHaveBeenCalledTimes(2);
  });
});
