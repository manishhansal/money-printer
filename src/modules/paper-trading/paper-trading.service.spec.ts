/**
 * paper-trading.service.spec.ts
 *
 * Unit tests for PaperTradingService.
 *
 * Test coverage (Requirement 10.1 isolation guarantees):
 *  1. Paper orders are written ONLY to `paper_orders` table — never to `orders`.
 *  2. Paper events are published ONLY to `events:paper:*` channels — never to live channels.
 *  3. Paper Redis keys use `paper:*` namespace exclusively.
 *  4. Zero shared state with LiveEngine tables or Redis keys.
 *  5. Market data unavailable → reject with correct reason (Requirement 10.4).
 *  6. Rejection probability simulation (Requirements 10.7, 10.8).
 *  7. Slippage application — BUY fills at ask + slippage, SELL at bid − slippage (10.2, 10.3, 10.5).
 *  8. Portfolio balance is updated after a closed trade (paper:portfolio:balance).
 *  9. Idempotency: duplicate key returns without re-processing.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.7, 10.8
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PaperOrder } from '../../database/entities/paper-orders.entity';
import { PaperExecution } from '../../database/entities/paper-executions.entity';
import { PaperPosition } from '../../database/entities/paper-positions.entity';
import { PaperTrade } from '../../database/entities/paper-trades.entity';
import { UserSettings } from '../../database/entities/user-settings.entity';

import { RedisService } from '../redis/redis.service';
import { TradingChargesService } from '../charges/trading-charges.service';

import { PaperTradingService, PAPER_STARTING_CAPITAL } from './paper-trading.service';

import {
  PAPER_PORTFOLIO_BALANCE_KEY,
  PAPER_FILL_EVENT_CHANNEL,
  PAPER_ORDER_EVENT_CHANNEL,
  PAPER_TRADE_EVENT_CHANNEL,
  PaperOrderRequest,
} from './paper-trading.types';

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────────

/** Counter used to generate unique UUIDs in tests without uuid dependency. */
let _uuidCounter = 0;
function nextUuid(): string {
  _uuidCounter += 1;
  return `test-uuid-${_uuidCounter.toString().padStart(4, '0')}`;
}

function buildMockPaperOrdersRepo() {
  return {
    create: jest.fn((dto) => ({ ...dto, id: nextUuid() })),
    save: jest.fn(async (entity) => ({ ...entity, id: entity.id ?? nextUuid() })),
    findOne: jest.fn(),
    find: jest.fn(),
  };
}

function buildMockPaperExecutionsRepo() {
  return {
    create: jest.fn((dto) => ({ ...dto, id: nextUuid() })),
    save: jest.fn(async (entity) => ({ ...entity, id: entity.id ?? nextUuid() })),
  };
}

function buildMockPaperPositionsRepo() {
  return {
    create: jest.fn((dto) => ({ ...dto, id: nextUuid() })),
    save: jest.fn(async (entity) => ({ ...entity, id: entity.id ?? nextUuid() })),
    findOne: jest.fn(),
    find: jest.fn(),
  };
}

function buildMockPaperTradesRepo() {
  return {
    create: jest.fn((dto) => ({ ...dto, id: nextUuid() })),
    save: jest.fn(async (entity) => ({ ...entity, id: entity.id ?? nextUuid() })),
  };
}

function buildMockUserSettingsRepo() {
  return {
    findOne: jest.fn(async () => null), // no settings row → falls back to PAPER_STARTING_CAPITAL
  };
}

/** Captured Redis calls for assertion. */
interface RedisCalls {
  gets: string[];
  sets: Array<{ key: string; value: string; ttl?: number }>;
  publishes: Array<{ channel: string; message: string }>;
}

function buildMockRedisService(): jest.Mocked<Partial<RedisService>> & { _calls: RedisCalls } {
  const calls: RedisCalls = { gets: [], sets: [], publishes: [] };

  return {
    _calls: calls,
    get: jest.fn(async (key: string) => {
      calls.gets.push(key);
      return null; // default: key not found
    }),
    set: jest.fn(async (key: string, value: string, ttl?: number) => {
      calls.sets.push({ key, value, ttl });
    }),
    publish: jest.fn(async (channel: string, message: string) => {
      calls.publishes.push({ channel, message });
      return 1;
    }),
    del: jest.fn(async () => 0),
    expire: jest.fn(async () => true),
    isHealthy: jest.fn(async () => true),
  } as unknown as jest.Mocked<Partial<RedisService>> & { _calls: RedisCalls };
}

/** Build a minimal valid MarketSnapshot JSON string for Redis. */
function buildMarketSnapshotJson(
  bidPrice: string | null = '100.00',
  askPrice: string | null = '100.50',
): string {
  return JSON.stringify({
    ltp: '100.25',
    bidPrice,
    askPrice,
    volume: '50000',
    oi: '123456',
    timestamp: Date.now(),
  });
}

/** Build a minimal PaperOrderRequest for testing. */
function buildPaperOrderRequest(overrides: Partial<PaperOrderRequest> = {}): PaperOrderRequest {
  return {
    idempotencyKey: nextUuid(),
    instrumentId: 'instr-test-001',
    transactionType: 'BUY',
    orderType: 'MARKET',
    quantity: 50,
    // Zero latency so tests don't wait
    latencyConfig: { distribution: 'uniform', meanMs: 0 },
    rejectionProbability: 0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('PaperTradingService', () => {
  let service: PaperTradingService;
  let mockPaperOrdersRepo: ReturnType<typeof buildMockPaperOrdersRepo>;
  let mockPaperExecutionsRepo: ReturnType<typeof buildMockPaperExecutionsRepo>;
  let mockPaperPositionsRepo: ReturnType<typeof buildMockPaperPositionsRepo>;
  let mockPaperTradesRepo: ReturnType<typeof buildMockPaperTradesRepo>;
  let mockUserSettingsRepo: ReturnType<typeof buildMockUserSettingsRepo>;
  let mockRedis: ReturnType<typeof buildMockRedisService>;

  beforeEach(async () => {
    _uuidCounter = 0;
    jest.clearAllMocks();

    mockPaperOrdersRepo = buildMockPaperOrdersRepo();
    mockPaperExecutionsRepo = buildMockPaperExecutionsRepo();
    mockPaperPositionsRepo = buildMockPaperPositionsRepo();
    mockPaperTradesRepo = buildMockPaperTradesRepo();
    mockUserSettingsRepo = buildMockUserSettingsRepo();
    mockRedis = buildMockRedisService();

    // Default: no existing open position
    mockPaperPositionsRepo.findOne.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradingService,
        // TradingChargesService is a pure calculation service with no injected
        // dependencies — use the real class so cost assertions match production.
        TradingChargesService,
        { provide: getRepositoryToken(PaperOrder), useValue: mockPaperOrdersRepo },
        { provide: getRepositoryToken(PaperExecution), useValue: mockPaperExecutionsRepo },
        { provide: getRepositoryToken(PaperPosition), useValue: mockPaperPositionsRepo },
        { provide: getRepositoryToken(PaperTrade), useValue: mockPaperTradesRepo },
        { provide: getRepositoryToken(UserSettings), useValue: mockUserSettingsRepo },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<PaperTradingService>(PaperTradingService);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Isolation: paper orders written to paper_orders table only
  // ─────────────────────────────────────────────────────────────────────────

  describe('Database isolation — paper_orders table (Requirement 10.1)', () => {
    it('calls paperOrdersRepo.save() (not orders repo) when processing a paper order', async () => {
      // Arrange: market data available
      (mockRedis.get as jest.Mock)
        .mockImplementationOnce(async () => null) // idempotency miss
        .mockImplementationOnce(async () => buildMarketSnapshotJson()); // snapshot present

      const request = buildPaperOrderRequest();

      // Act
      await service.submitPaperOrder(request);

      // Assert: paper_orders table was written
      expect(mockPaperOrdersRepo.save).toHaveBeenCalled();
      expect(mockPaperOrdersRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          engine: 'PAPER',
          instrument_id: request.instrumentId,
          transaction_type: 'BUY',
          quantity: 50,
        }),
      );
    });

    it('records a PaperExecution after a successful fill', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(buildPaperOrderRequest());

      expect(mockPaperExecutionsRepo.save).toHaveBeenCalledTimes(1);
      expect(mockPaperExecutionsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          engine: 'PAPER',
          fill_quantity: 50,
        }),
      );
    });

    it('creates a PaperPosition record after a successful BUY fill', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(buildPaperOrderRequest());

      expect(mockPaperPositionsRepo.save).toHaveBeenCalledTimes(1);
      expect(mockPaperPositionsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          engine: 'PAPER',
          direction: 'LONG',
          is_open: true,
        }),
      );
    });

    it('creates a PaperTrade when a LONG position is fully closed', async () => {
      // Set up an open LONG position to be closed by the SELL order
      const openPosition: Partial<PaperPosition> = {
        id: 'pos-open-001',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 50,
        average_entry_price: '100.00',
        is_open: true,
        opened_at: new Date('2024-01-01T09:00:00Z'),
        mfe: '0',
        mae: '0',
        signal_id: null,
      };
      mockPaperPositionsRepo.findOne.mockResolvedValue(openPosition);

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: 50 }),
      );

      // paper_trades must be written
      expect(mockPaperTradesRepo.save).toHaveBeenCalledTimes(1);
      expect(mockPaperTradesRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          engine: 'PAPER',
          direction: 'LONG',
          quantity: 50,
        }),
      );
    });

    it('does NOT call paperTradesRepo when the order is rejected', async () => {
      // Market data unavailable → rejected
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(null); // no snapshot

      await service.submitPaperOrder(buildPaperOrderRequest());

      expect(mockPaperTradesRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Isolation: events published to events:paper:* channels only
  // ─────────────────────────────────────────────────────────────────────────

  describe('Redis channel isolation — events:paper:* namespace (Requirement 10.1)', () => {
    it('publishes fill event to "events:paper:fill" on successful order', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(buildPaperOrderRequest());

      const fillPublishes = mockRedis._calls.publishes.filter(
        (p) => p.channel === PAPER_FILL_EVENT_CHANNEL,
      );
      expect(fillPublishes).toHaveLength(1);
      expect(fillPublishes[0].channel).toBe('events:paper:fill');
    });

    it('publishes order event to "events:paper:order" on submission', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(buildPaperOrderRequest());

      const orderPublishes = mockRedis._calls.publishes.filter(
        (p) => p.channel === PAPER_ORDER_EVENT_CHANNEL,
      );
      expect(orderPublishes.length).toBeGreaterThanOrEqual(1);
      expect(orderPublishes[0].channel).toBe('events:paper:order');
    });

    it('publishes trade event to "events:paper:trade" when a position is closed', async () => {
      const openPosition: Partial<PaperPosition> = {
        id: 'pos-trade-001',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 50,
        average_entry_price: '100.00',
        is_open: true,
        opened_at: new Date('2024-01-01T09:00:00Z'),
        mfe: '0',
        mae: '0',
        signal_id: null,
      };
      mockPaperPositionsRepo.findOne.mockResolvedValue(openPosition);

      // mock save to return updated position (closed)
      mockPaperPositionsRepo.save.mockResolvedValueOnce({
        ...openPosition,
        quantity: 0,
        is_open: false,
        closed_at: new Date(),
      });
      mockPaperTradesRepo.save.mockResolvedValueOnce({
        id: 'trade-001',
        engine: 'PAPER',
        position_id: 'pos-trade-001',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 50,
        entry_price: '100.00',
        exit_price: '100.00',
        entry_time: new Date(),
        exit_time: new Date(),
        gross_pnl: '0.00',
        brokerage: '40.0000',
        stt: '0.0000',
        exchange_charges: '0.0000',
        gst: '0.0000',
        sebi_charges: '0.0000',
        stamp_duty: '0.0000',
        net_pnl: '-40.00',
        exit_reason: 'MANUAL',
        execution_slippage: '0.0000',
        mfe: '0',
        mae: '0',
        signal_score: null,
        dhan_entry_order_id: null,
        dhan_exit_order_id: null,
        qcr: null,
        exit_classification: null,
        execution_quality: null,
        lot_size: 1,
        strategy_id: null,
        signal_id: null,
      });

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: 50 }),
      );

      const tradePublishes = mockRedis._calls.publishes.filter(
        (p) => p.channel === PAPER_TRADE_EVENT_CHANNEL,
      );
      expect(tradePublishes).toHaveLength(1);
      expect(tradePublishes[0].channel).toBe('events:paper:trade');
    });

    it('NEVER publishes to live engine channels (events:fill, events:order, events:trade)', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(buildPaperOrderRequest());

      const liveChannelPublishes = mockRedis._calls.publishes.filter(
        (p) =>
          p.channel === 'events:fill' ||
          p.channel === 'events:order' ||
          p.channel === 'events:trade',
      );
      expect(liveChannelPublishes).toHaveLength(0);
    });

    it('publishes rejected order event to "events:paper:order" (not live channels)', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(null); // no market snapshot → reject

      await service.submitPaperOrder(buildPaperOrderRequest());

      // All publishes must be to events:paper:* only
      const nonPaperPublishes = mockRedis._calls.publishes.filter(
        (p) => !p.channel.startsWith('events:paper:'),
      );
      expect(nonPaperPublishes).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Isolation: Redis keys use paper:* namespace exclusively
  // ─────────────────────────────────────────────────────────────────────────

  describe('Redis key isolation — paper:* namespace (Requirement 10.1)', () => {
    it('stores idempotency key under "paper:orders:idempotency:{key}"', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      const request = buildPaperOrderRequest({ idempotencyKey: 'test-idempotency-key' });
      await service.submitPaperOrder(request);

      const idempotencySets = mockRedis._calls.sets.filter((s) =>
        s.key.startsWith('paper:orders:idempotency:'),
      );
      expect(idempotencySets.length).toBeGreaterThanOrEqual(1);
      expect(idempotencySets[0].key).toBe('paper:orders:idempotency:test-idempotency-key');
    });

    it('stores order snapshot under "paper:orders:{orderId}" key', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(buildPaperOrderRequest());

      const orderSnapshotSets = mockRedis._calls.sets.filter(
        (s) => s.key.startsWith('paper:orders:') && !s.key.includes('idempotency'),
      );
      expect(orderSnapshotSets.length).toBeGreaterThanOrEqual(1);
      expect(orderSnapshotSets[0].key).toMatch(/^paper:orders:[a-z0-9-]+$/);
    });

    it('stores position snapshot under "paper:positions:{positionId}" key', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(buildPaperOrderRequest());

      const positionSets = mockRedis._calls.sets.filter((s) =>
        s.key.startsWith('paper:positions:'),
      );
      expect(positionSets.length).toBeGreaterThanOrEqual(1);
    });

    it('stores portfolio balance under "paper:portfolio:balance" key', async () => {
      // Set up a completed trade to trigger a balance update
      const openPosition: Partial<PaperPosition> = {
        id: 'pos-bal-001',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 50,
        average_entry_price: '100.00',
        is_open: true,
        opened_at: new Date(),
        mfe: '0',
        mae: '0',
        signal_id: null,
      };
      mockPaperPositionsRepo.findOne.mockResolvedValue(openPosition);
      mockPaperPositionsRepo.save.mockResolvedValueOnce({
        ...openPosition,
        quantity: 0,
        is_open: false,
        closed_at: new Date(),
      });
      mockPaperTradesRepo.save.mockResolvedValueOnce({
        id: 'trade-bal-001',
        net_pnl: '500.00',
        gross_pnl: '540.00',
        engine: 'PAPER',
        position_id: 'pos-bal-001',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 50,
        entry_price: '100.00',
        exit_price: '110.80',
        entry_time: new Date(),
        exit_time: new Date(),
        exit_reason: 'MANUAL',
        execution_slippage: '0.0000',
        mfe: '0',
        mae: '0',
        signal_score: null,
        brokerage: '40.0000',
        stt: '0.0000',
        exchange_charges: '0.0000',
        gst: '0.0000',
        sebi_charges: '0.0000',
        stamp_duty: '0.0000',
        lot_size: 1,
        strategy_id: null,
        signal_id: null,
        qcr: null,
        exit_classification: null,
        execution_quality: null,
        dhan_entry_order_id: null,
        dhan_exit_order_id: null,
      });

      // Portfolio balance returns starting capital on first read
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()) // snapshot
        .mockResolvedValueOnce(null); // portfolio balance not set → returns default

      await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: 50 }),
      );

      const balanceSets = mockRedis._calls.sets.filter(
        (s) => s.key === PAPER_PORTFOLIO_BALANCE_KEY,
      );
      expect(balanceSets.length).toBeGreaterThanOrEqual(1);
      expect(balanceSets[0].key).toBe('paper:portfolio:balance');
    });

    it('NEVER writes to live engine Redis keys (trading:armed_state, orders:*, positions:*)', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(buildPaperOrderRequest());

      // Check no live engine keys were written
      const liveKeySets = mockRedis._calls.sets.filter(
        (s) =>
          s.key === 'trading:armed_state' ||
          (s.key.startsWith('orders:') && !s.key.startsWith('paper:')) ||
          (s.key.startsWith('positions:') && !s.key.startsWith('paper:')),
      );
      expect(liveKeySets).toHaveLength(0);
    });

    it('reads market snapshot from mkt:snapshot:{instrumentId} (not from paper: namespace)', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(buildPaperOrderRequest({ instrumentId: 'instr-special-999' }));

      // Verify that get() was called with the shared mkt:snapshot: key
      // (not a paper:-prefixed key). Uses Jest's call tracking.
      const getCalls = (mockRedis.get as jest.Mock).mock.calls.map(
        (args: unknown[]) => args[0] as string,
      );
      expect(getCalls).toContain('mkt:snapshot:instr-special-999');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Market data unavailable → reject (Requirement 10.4)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Market data unavailability (Requirement 10.4)', () => {
    it('rejects the order with reason "market data unavailable" when snapshot is absent', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(null); // no snapshot

      const result = await service.submitPaperOrder(buildPaperOrderRequest());

      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('market data unavailable');
    });

    it('does NOT create a PaperExecution when market data is unavailable', async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      await service.submitPaperOrder(buildPaperOrderRequest());

      expect(mockPaperExecutionsRepo.save).not.toHaveBeenCalled();
    });

    it('does NOT update portfolio balance when market data is unavailable', async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      await service.submitPaperOrder(buildPaperOrderRequest());

      const balanceSets = mockRedis._calls.sets.filter(
        (s) => s.key === PAPER_PORTFOLIO_BALANCE_KEY,
      );
      expect(balanceSets).toHaveLength(0);
    });

    it('rejects the order when ask price is null for a BUY order', async () => {
      // bidPrice present but askPrice is null — BUY needs ask
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson('100.00', null));

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'BUY' }),
      );

      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('market data unavailable');
    });

    it('rejects the order when bid price is null for a SELL order', async () => {
      // Need an open LONG position so the options-buying guard passes,
      // then the missing bid price triggers "market data unavailable".
      mockPaperPositionsRepo.findOne.mockResolvedValueOnce({
        id: 'pos-null-bid-001',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 50,
        average_entry_price: '100.00',
        is_open: true,
      });

      // askPrice present but bidPrice is null — SELL needs bid
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson(null, '100.50'));

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL' }),
      );

      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('market data unavailable');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Rejection probability simulation (Requirements 10.7, 10.8)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Rejection probability simulation (Requirements 10.7, 10.8)', () => {
    it('rejects with reason "simulated rejection" when probability = 1.0', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ rejectionProbability: 1.0 }),
      );

      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('simulated rejection');
    });

    it('does NOT create a PaperExecution on simulated rejection (Requirement 10.8)', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson());

      await service.submitPaperOrder(buildPaperOrderRequest({ rejectionProbability: 1.0 }));

      expect(mockPaperExecutionsRepo.save).not.toHaveBeenCalled();
    });

    it('does NOT update portfolio balance on simulated rejection (Requirement 10.8)', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson());

      await service.submitPaperOrder(buildPaperOrderRequest({ rejectionProbability: 1.0 }));

      const balanceSets = mockRedis._calls.sets.filter(
        (s) => s.key === PAPER_PORTFOLIO_BALANCE_KEY,
      );
      expect(balanceSets).toHaveLength(0);
    });

    it('fills the order when rejection probability is 0.0 (default)', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ rejectionProbability: 0.0 }),
      );

      expect(result.status).toBe('complete');
      expect(result.executionId).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Slippage application (Requirements 10.2, 10.3, 10.5)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Fill price and slippage (Requirements 10.2, 10.3, 10.5)', () => {
    it('fills BUY at ask price (100.50) with zero slippage by default', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson('100.00', '100.50'));

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'BUY' }),
      );

      expect(result.fillPrice).toBe('100.50');
    });

    it('fills SELL at bid price (100.00) with zero slippage by default', async () => {
      // Need an existing open LONG position to close
      mockPaperPositionsRepo.findOne.mockResolvedValue({
        id: 'pos-sell-001',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 50,
        average_entry_price: '95.00',
        is_open: true,
        opened_at: new Date(),
        mfe: '0',
        mae: '0',
        signal_id: null,
      });

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson('100.00', '100.50'));

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL' }),
      );

      expect(result.fillPrice).toBe('100.00');
    });

    it('applies fixed-rupee slippage of ₹2.00 to a BUY fill', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson('100.00', '100.50'));

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          transactionType: 'BUY',
          slippageConfig: { model: 'fixed_rupee', fixedRupee: 2.0 },
        }),
      );

      // fill = ask (100.50) + slip (2.00) = 102.50
      expect(result.fillPrice).toBe('102.50');
      expect(result.slippageApplied).toBe('2.0000');
    });

    it('applies fixed-rupee slippage of ₹1.50 adversely to a SELL fill', async () => {
      mockPaperPositionsRepo.findOne.mockResolvedValue({
        id: 'pos-slip-001',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 50,
        average_entry_price: '95.00',
        is_open: true,
        opened_at: new Date(),
        mfe: '0',
        mae: '0',
        signal_id: null,
      });

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson('100.00', '100.50'));

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          transactionType: 'SELL',
          slippageConfig: { model: 'fixed_rupee', fixedRupee: 1.5 },
        }),
      );

      // fill = bid (100.00) − slip (1.50) = 98.50
      expect(result.fillPrice).toBe('98.50');
      expect(result.slippageApplied).toBe('1.5000');
    });

    it('applies percentage slippage of 1% to a BUY fill', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson('100.00', '200.00'));

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          transactionType: 'BUY',
          slippageConfig: { model: 'percentage', percentage: 0.01 },
        }),
      );

      // fill = ask (200.00) × (1 + 1%) = 202.00
      expect(result.fillPrice).toBe('202.00');
      expect(parseFloat(result.slippageApplied ?? '0')).toBeCloseTo(2.0, 4);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Idempotency
  // ─────────────────────────────────────────────────────────────────────────

  describe('Idempotency', () => {
    it('returns rejected with "duplicate idempotency key" when key already processed', async () => {
      // Redis returns an existing orderId for the idempotency key
      (mockRedis.get as jest.Mock).mockResolvedValueOnce('existing-order-id-123');

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ idempotencyKey: 'dup-key' }),
      );

      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('duplicate idempotency key');
      expect(result.orderId).toBe('existing-order-id-123');
    });

    it('does NOT create a new PaperOrder on duplicate idempotency key', async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce('existing-order-id');

      await service.submitPaperOrder(buildPaperOrderRequest({ idempotencyKey: 'dup-key-2' }));

      expect(mockPaperOrdersRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. Portfolio balance management
  // ─────────────────────────────────────────────────────────────────────────

  describe('Portfolio balance (paper:portfolio:balance)', () => {
    it('returns PAPER_STARTING_CAPITAL when balance is not yet set', async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce(null); // not set

      const balance = await service.getPortfolioBalance();

      expect(balance).toBe(PAPER_STARTING_CAPITAL);
    });

    it('returns stored balance when it has been set', async () => {
      (mockRedis.get as jest.Mock).mockResolvedValueOnce('750000.00');

      const balance = await service.getPortfolioBalance();

      expect(balance).toBe('750000.00');
    });

    it('initializePortfolioBalance() writes to paper:portfolio:balance key', async () => {
      await service.initializePortfolioBalance('500000.00');

      expect(mockRedis.set).toHaveBeenCalledWith(PAPER_PORTFOLIO_BALANCE_KEY, '500000.00');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. getOpenPaperPositions — queries paper_positions table only
  // ─────────────────────────────────────────────────────────────────────────

  describe('getOpenPaperPositions()', () => {
    it('queries the paper_positions repository with is_open: true', async () => {
      mockPaperPositionsRepo.find.mockResolvedValue([]);

      await service.getOpenPaperPositions();

      expect(mockPaperPositionsRepo.find).toHaveBeenCalledWith({
        where: { is_open: true },
      });
    });

    it('returns open paper positions from the paper_positions table', async () => {
      const fakePosition = { id: 'pos-open', is_open: true, engine: 'PAPER' };
      mockPaperPositionsRepo.find.mockResolvedValue([fakePosition]);

      const positions = await service.getOpenPaperPositions();

      expect(positions).toHaveLength(1);
      expect(positions[0].engine).toBe('PAPER');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 10. No shared state with LiveEngine
  // ─────────────────────────────────────────────────────────────────────────

  describe('Zero shared state with LiveEngine (Requirement 10.1)', () => {
    it('all Redis set keys on a successful fill start with "paper:"', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson());

      await service.submitPaperOrder(buildPaperOrderRequest());

      const nonPaperSets = mockRedis._calls.sets.filter((s) => !s.key.startsWith('paper:'));
      expect(nonPaperSets).toHaveLength(0);
    });

    it('all Redis publish channels on a successful fill start with "events:paper:"', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson());

      await service.submitPaperOrder(buildPaperOrderRequest());

      const nonPaperPublishes = mockRedis._calls.publishes.filter(
        (p) => !p.channel.startsWith('events:paper:'),
      );
      expect(nonPaperPublishes).toHaveLength(0);
    });

    it('fill event payload contains instrumentId, fillPrice, and positionId', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson('100.00', '100.50'));

      await service.submitPaperOrder(buildPaperOrderRequest({ instrumentId: 'instr-verify-001' }));

      const fillPublish = mockRedis._calls.publishes.find(
        (p) => p.channel === PAPER_FILL_EVENT_CHANNEL,
      );
      expect(fillPublish).toBeDefined();

      const payload = JSON.parse(fillPublish!.message) as {
        instrumentId: string;
        fillPrice: string;
        positionId: string;
        transactionType: string;
      };

      expect(payload.instrumentId).toBe('instr-verify-001');
      expect(payload.fillPrice).toBe('100.50');
      expect(payload.transactionType).toBe('BUY');
      expect(payload.positionId).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 11. Fill price source — BUY must use ask, SELL must use bid
  //     (Requirements 10.2, 10.3)
  //
  // These tests use three *distinctly different* price values so a wrong
  // implementation (using LTP or the wrong side of the spread) cannot
  // accidentally pass.
  // ─────────────────────────────────────────────────────────────────────────

  describe('Fill price source — BUY at best ask, SELL at best bid (Requirements 10.2, 10.3)', () => {
    it('BUY order fills at best ask price, NOT at bid price or LTP', async () => {
      // Three clearly different values:
      //   ltp   = 99.00  — last traded price (must NOT be used)
      //   bid   = 100.00 — best bid          (must NOT be used for a BUY)
      //   ask   = 102.00 — best ask          (MUST be used for a BUY)
      const distinctSnapshot = JSON.stringify({
        ltp: '99.00',
        bidPrice: '100.00',
        askPrice: '102.00',
        volume: '50000',
        oi: '123456',
        timestamp: Date.now(),
      });

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(distinctSnapshot); // market snapshot

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          transactionType: 'BUY',
          slippageConfig: { model: 'fixed_rupee', fixedRupee: 0 }, // zero slippage for clarity
        }),
      );

      expect(result.status).toBe('complete');
      // Fill price must equal askPrice (102.00)
      expect(result.fillPrice).toBe('102.00');
      // Explicitly verify it did NOT use bidPrice or ltp
      expect(result.fillPrice).not.toBe('100.00'); // not bid
      expect(result.fillPrice).not.toBe('99.00'); // not ltp
    });

    it('SELL order fills at best bid price, NOT at ask price or LTP', async () => {
      // Three clearly different values:
      //   ltp   = 101.00 — last traded price  (must NOT be used)
      //   bid   =  98.00 — best bid           (MUST be used for a SELL)
      //   ask   = 103.00 — best ask           (must NOT be used for a SELL)
      const distinctSnapshot = JSON.stringify({
        ltp: '101.00',
        bidPrice: '98.00',
        askPrice: '103.00',
        volume: '50000',
        oi: '123456',
        timestamp: Date.now(),
      });

      // Set up an open LONG position to close via the SELL
      mockPaperPositionsRepo.findOne.mockResolvedValue({
        id: 'pos-sell-price-src-001',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 50,
        average_entry_price: '95.00',
        is_open: true,
        opened_at: new Date(),
        mfe: '0',
        mae: '0',
        signal_id: null,
      });

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(distinctSnapshot); // market snapshot

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          transactionType: 'SELL',
          slippageConfig: { model: 'fixed_rupee', fixedRupee: 0 }, // zero slippage for clarity
        }),
      );

      expect(result.status).toBe('complete');
      // Fill price must equal bidPrice (98.00)
      expect(result.fillPrice).toBe('98.00');
      // Explicitly verify it did NOT use askPrice or ltp
      expect(result.fillPrice).not.toBe('103.00'); // not ask
      expect(result.fillPrice).not.toBe('101.00'); // not ltp
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 12. Portfolio state preservation on market data rejection
  //     (Requirement 10.4)
  //
  // When only *one side* of the spread is null (bid or ask), the snapshot
  // itself is non-null so the first null-snapshot check passes.  The service
  // must still reject and preserve ALL portfolio state: no PaperExecution
  // created, no portfolio balance written, no open position modified.
  // ─────────────────────────────────────────────────────────────────────────

  describe('Portfolio state preservation on market data rejection (Requirement 10.4)', () => {
    /** Helper: build a snapshot JSON where only the ask is null (bid and LTP present). */
    function snapshotNullAsk(): string {
      return JSON.stringify({
        ltp: '100.25',
        bidPrice: '100.00',
        askPrice: null, // ask unavailable — BUY must reject
        volume: '50000',
        oi: '123456',
        timestamp: Date.now(),
      });
    }

    /** Helper: build a snapshot JSON where only the bid is null (ask and LTP present). */
    function snapshotNullBid(): string {
      return JSON.stringify({
        ltp: '100.25',
        bidPrice: null, // bid unavailable — SELL must reject
        askPrice: '100.50',
        volume: '50000',
        oi: '123456',
        timestamp: Date.now(),
      });
    }

    it('BUY order with askPrice=null → rejected with "market data unavailable" even when bidPrice and LTP are present', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(snapshotNullAsk());

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'BUY' }),
      );

      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('market data unavailable');
    });

    it('SELL order with bidPrice=null → rejected with "market data unavailable" even when askPrice and LTP are present', async () => {
      // Need an open LONG position so the options-buying guard passes,
      // then the missing bid price triggers "market data unavailable".
      mockPaperPositionsRepo.findOne.mockResolvedValueOnce({
        id: 'pos-null-bid-002',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 50,
        average_entry_price: '100.00',
        is_open: true,
      });

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(snapshotNullBid());

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL' }),
      );

      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('market data unavailable');
    });

    it('After BUY rejection (askPrice=null): portfolio balance Redis key is NOT written', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(snapshotNullAsk());

      await service.submitPaperOrder(buildPaperOrderRequest({ transactionType: 'BUY' }));

      const balanceSets = mockRedis._calls.sets.filter(
        (s) => s.key === PAPER_PORTFOLIO_BALANCE_KEY,
      );
      expect(balanceSets).toHaveLength(0);
    });

    it('After SELL rejection (bidPrice=null): no PaperExecution record is created', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(snapshotNullBid());

      await service.submitPaperOrder(buildPaperOrderRequest({ transactionType: 'SELL' }));

      expect(mockPaperExecutionsRepo.create).not.toHaveBeenCalled();
      expect(mockPaperExecutionsRepo.save).not.toHaveBeenCalled();
    });

    it('After SELL rejection (bidPrice=null): existing open LONG position is not modified', async () => {
      // An open LONG position exists for the instrument
      const existingPosition = {
        id: 'pos-preserve-long-001',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 100,
        average_entry_price: '90.00',
        is_open: true,
        opened_at: new Date('2024-01-01T09:00:00Z'),
        mfe: '0',
        mae: '0',
        signal_id: null,
      };
      mockPaperPositionsRepo.findOne.mockResolvedValue(existingPosition);

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(snapshotNullBid());

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: 100 }),
      );

      // Order rejected — position must be untouched
      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('market data unavailable');

      // updatePosition() must never have been reached, so no position save
      expect(mockPaperPositionsRepo.save).not.toHaveBeenCalled();
    });

    it('After BUY rejection (askPrice=null): no PaperExecution record is created', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(snapshotNullAsk());

      await service.submitPaperOrder(buildPaperOrderRequest({ transactionType: 'BUY' }));

      expect(mockPaperExecutionsRepo.create).not.toHaveBeenCalled();
      expect(mockPaperExecutionsRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 13. Configurable simulation parameters — Task 19.3
  //     Requirements: 10.5, 10.7, 10.8, 10.9
  //
  // Verifies:
  //   a. All three slippage models produce correct adversarial fill prices
  //      for both BUY (ask + slippage) and SELL (bid − slippage).
  //   b. Slippage input ranges are clamped at both bounds.
  //   c. Simulated rejections preserve ALL portfolio state (no costs, no P&L,
  //      no position modification).
  //   d. Default latency is uniform with mean 200 ms — not zero-latency.
  //   e. All three latency distributions compile and produce non-negative ms.
  //   f. meanMs is clamped to [10, 5000] before use.
  // ─────────────────────────────────────────────────────────────────────────

  // ── 13a. Slippage models — full matrix ─────────────────────────────────────
  //         (Requirement 10.5)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Slippage models — full matrix (Requirement 10.5)', () => {
    // ── percentage model ────────────────────────────────────────────────────

    it('percentage slippage (1%) applied adversely to a SELL: fill = bid − (bid × 0.01)', async () => {
      // Need an existing LONG position to close via SELL
      mockPaperPositionsRepo.findOne.mockResolvedValue({
        id: 'pos-pct-sell-001',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 50,
        average_entry_price: '90.00',
        is_open: true,
        opened_at: new Date(),
        mfe: '0',
        mae: '0',
        signal_id: null,
      });

      // bid=200.00, ask=202.00 — SELL uses bid
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson('200.00', '202.00')); // snapshot

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          transactionType: 'SELL',
          slippageConfig: { model: 'percentage', percentage: 0.01 },
        }),
      );

      // fill = bid (200.00) − (200.00 × 0.01 = 2.00) = 198.00
      expect(result.status).toBe('complete');
      expect(result.fillPrice).toBe('198.00');
      expect(parseFloat(result.slippageApplied ?? '0')).toBeCloseTo(2.0, 4);
    });

    // ── market_impact model ─────────────────────────────────────────────────

    it('market_impact slippage applied adversely to a BUY fill: fill = ask + (factor × √qty × ask)', async () => {
      // ask=100.00, qty=100, factor=0.001
      // slippage = 0.001 × √100 × 100.00 = 0.001 × 10 × 100 = 1.00
      // fill    = 100.00 + 1.00 = 101.00
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson('99.00', '100.00')); // snapshot

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          transactionType: 'BUY',
          quantity: 100,
          slippageConfig: { model: 'market_impact', marketImpactFactor: 0.001 },
        }),
      );

      expect(result.status).toBe('complete');
      expect(result.fillPrice).toBe('101.00');
      expect(parseFloat(result.slippageApplied ?? '0')).toBeCloseTo(1.0, 4);
    });

    it('market_impact slippage applied adversely to a SELL fill: fill = bid − (factor × √qty × bid)', async () => {
      // bid=100.00, qty=100, factor=0.001
      // slippage = 0.001 × √100 × 100.00 = 1.00
      // fill    = 100.00 − 1.00 = 99.00
      mockPaperPositionsRepo.findOne.mockResolvedValue({
        id: 'pos-impact-sell-001',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 100,
        average_entry_price: '90.00',
        is_open: true,
        opened_at: new Date(),
        mfe: '0',
        mae: '0',
        signal_id: null,
      });

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson('100.00', '101.00')); // snapshot

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          transactionType: 'SELL',
          quantity: 100,
          slippageConfig: { model: 'market_impact', marketImpactFactor: 0.001 },
        }),
      );

      expect(result.status).toBe('complete');
      expect(result.fillPrice).toBe('99.00');
      expect(parseFloat(result.slippageApplied ?? '0')).toBeCloseTo(1.0, 4);
    });

    // ── Clamping — upper bounds ─────────────────────────────────────────────

    it('fixedRupee value above 50 is clamped to 50 (max BUY slippage = ₹50)', async () => {
      // Passes fixedRupee: 100 — must be clamped to 50
      // ask=100.00 + clamped slip 50 = 150.00
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson('99.50', '100.00'));

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          transactionType: 'BUY',
          slippageConfig: { model: 'fixed_rupee', fixedRupee: 100 },
        }),
      );

      expect(result.status).toBe('complete');
      expect(result.fillPrice).toBe('150.00');
      expect(result.slippageApplied).toBe('50.0000');
    });

    it('percentage above 2.00% is clamped to 2.00% (max BUY slippage = 2%)', async () => {
      // Passes percentage: 0.10 (10%) — must be clamped to 0.02 (2%)
      // ask=100.00 + (100.00 × 0.02) = 102.00
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson('99.50', '100.00'));

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          transactionType: 'BUY',
          slippageConfig: { model: 'percentage', percentage: 0.1 },
        }),
      );

      expect(result.status).toBe('complete');
      expect(result.fillPrice).toBe('102.00');
      expect(parseFloat(result.slippageApplied ?? '0')).toBeCloseTo(2.0, 4);
    });

    // ── Clamping — lower bounds ─────────────────────────────────────────────

    it('fixedRupee value below 0 is clamped to 0 (no negative slippage)', async () => {
      // Passes fixedRupee: -5 — must be clamped to 0, fill = ask (no slippage)
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson('100.00', '100.50'));

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          transactionType: 'BUY',
          slippageConfig: { model: 'fixed_rupee', fixedRupee: -5 },
        }),
      );

      expect(result.status).toBe('complete');
      expect(result.fillPrice).toBe('100.50');
      expect(result.slippageApplied).toBe('0.0000');
    });

    it('percentage value below 0 is clamped to 0 (no negative slippage)', async () => {
      // Passes percentage: -0.01 — must be clamped to 0, fill = ask (no slippage)
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson('100.00', '100.50'));

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          transactionType: 'BUY',
          slippageConfig: { model: 'percentage', percentage: -0.01 },
        }),
      );

      expect(result.status).toBe('complete');
      expect(result.fillPrice).toBe('100.50');
      expect(parseFloat(result.slippageApplied ?? '0')).toBeCloseTo(0, 4);
    });
  });

  // ── 13b. Rejection probability — costs, P&L, and position isolation ────────
  //         (Requirements 10.7, 10.8)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Rejection probability — costs, P&L, and position isolation (Requirements 10.7, 10.8)', () => {
    it('simulated rejection deducts no costs — no PaperTrade record is created', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(buildPaperOrderRequest({ rejectionProbability: 1.0 }));

      // No trade → no cost calculation
      expect(mockPaperTradesRepo.create).not.toHaveBeenCalled();
      expect(mockPaperTradesRepo.save).not.toHaveBeenCalled();
    });

    it('simulated rejection records no P&L change — portfolio balance Redis key is NOT written', async () => {
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(buildPaperOrderRequest({ rejectionProbability: 1.0 }));

      const balanceSets = mockRedis._calls.sets.filter(
        (s) => s.key === PAPER_PORTFOLIO_BALANCE_KEY,
      );
      expect(balanceSets).toHaveLength(0);
    });

    it('simulated rejection does not modify existing open positions — position save is NOT called', async () => {
      // An open LONG position exists for the instrument
      mockPaperPositionsRepo.findOne.mockResolvedValue({
        id: 'pos-rej-preserve-001',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 100,
        average_entry_price: '90.00',
        is_open: true,
        opened_at: new Date(),
        mfe: '0',
        mae: '0',
        signal_id: null,
      });

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          transactionType: 'SELL',
          quantity: 100,
          rejectionProbability: 1.0,
        }),
      );

      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('simulated rejection');

      // updatePosition() must never be reached — position repo untouched
      expect(mockPaperPositionsRepo.save).not.toHaveBeenCalled();
    });
  });

  // ── 13c. Execution latency distribution ────────────────────────────────────
  //         (Requirement 10.9)
  //
  // All latency tests spy on the private `sleep` method so the test suite
  // doesn't incur real wall-clock waits.  Math.random is pinned to 0.5 where
  // deterministic assertions are needed.
  // ─────────────────────────────────────────────────────────────────────────

  describe('Execution latency distribution (Requirement 10.9)', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('default latency config is uniform distribution with mean 200 ms — not zero-latency instantaneous fills', async () => {
      // Spy on sleep to avoid the real 200 ms wait; still captures the value.
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      // Pin Math.random to 0.5 → uniform mean=200: floor(0.5 × 2 × 200) = 200
      const mathRandomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      // Submit WITHOUT latencyConfig — service must use DEFAULT_LATENCY_CONFIG
      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ latencyConfig: undefined }),
      );

      expect(result.status).toBe('complete');
      // With default meanMs=200 and Math.random=0.5: floor(0.5 × 400) = 200 (non-zero)
      expect(result.simulatedLatencyMs).toBe(200);
      expect(result.simulatedLatencyMs).toBeGreaterThan(0);

      sleepSpy.mockRestore();
      mathRandomSpy.mockRestore();
    });

    it('uniform distribution produces non-negative simulatedLatencyMs', async () => {
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson());

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ latencyConfig: { distribution: 'uniform', meanMs: 50 } }),
      );

      expect(result.status).toBe('complete');
      expect(result.simulatedLatencyMs).toBeGreaterThanOrEqual(0);

      sleepSpy.mockRestore();
    });

    it('normal distribution produces non-negative simulatedLatencyMs', async () => {
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson());

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ latencyConfig: { distribution: 'normal', meanMs: 50 } }),
      );

      expect(result.status).toBe('complete');
      expect(result.simulatedLatencyMs).toBeGreaterThanOrEqual(0);

      sleepSpy.mockRestore();
    });

    it('log_normal distribution produces non-negative simulatedLatencyMs', async () => {
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson());

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({ latencyConfig: { distribution: 'log_normal', meanMs: 50 } }),
      );

      expect(result.status).toBe('complete');
      expect(result.simulatedLatencyMs).toBeGreaterThanOrEqual(0);

      sleepSpy.mockRestore();
    });

    it('meanMs below 10 is clamped to 10 — uniform latency reflects clamped mean', async () => {
      // Passes meanMs: 1 (below floor of 10).
      // With clamped mean=10 and Math.random=0.5: floor(0.5 × 2 × 10) = 10.
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      const mathRandomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson());

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          latencyConfig: { distribution: 'uniform', meanMs: 1 },
        }),
      );

      expect(result.simulatedLatencyMs).toBe(10);

      sleepSpy.mockRestore();
      mathRandomSpy.mockRestore();
    });

    it('meanMs above 5000 is clamped to 5000 — uniform latency reflects clamped mean', async () => {
      // Passes meanMs: 9999 (above ceiling of 5000).
      // With clamped mean=5000 and Math.random=0.5: floor(0.5 × 2 × 5000) = 5000.
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      const mathRandomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildMarketSnapshotJson());

      const result = await service.submitPaperOrder(
        buildPaperOrderRequest({
          latencyConfig: { distribution: 'uniform', meanMs: 9999 },
        }),
      );

      expect(result.simulatedLatencyMs).toBe(5000);

      sleepSpy.mockRestore();
      mathRandomSpy.mockRestore();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 14. Trading cost formulas — NSE F&O (Requirement 10.6)
  //
  // The PaperEngine must apply the identical cost model as the LiveEngine:
  //   Brokerage:        ₹20 flat per executed order side  (₹40 round-trip)
  //   STT:              0.1%   of sell-side turnover  (Budget 2024, eff. Oct 2024)
  //   Exchange charges: 0.053% of total (buy + sell) turnover
  //   GST:              18%    of (brokerage + exchange charges)
  //   SEBI charges:     ₹10/crore of total turnover (0.000001 × turnover)
  //   Stamp duty:       0.003% of buy-side turnover only
  //
  // Reference trade used across all cost tests:
  //   50 lots  ×  ₹100.00 entry  →  ₹102.00 exit
  //   buyTurnover   = 50 × 100  = ₹  5,000
  //   sellTurnover  = 50 × 102  = ₹  5,100
  //   totalTurnover =             ₹ 10,100
  //
  //   brokerage        = ₹ 40.0000  (₹20 × 2)
  //   stt              = ₹  5.1000  (0.1%   × 5100)
  //   exchange_charges = ₹  5.3530  (0.053% × 10100)
  //   gst              = ₹  8.1635  (18%    × (40 + 5.353))
  //   sebi_charges     = ₹  0.0101  (10/crore × 10100)
  //   stamp_duty       = ₹  0.1500  (0.003% × 5000)
  //   ─────────────────────────────
  //   total costs      = ₹ 58.7766
  //   gross P&L        = ₹100.00  ((102−100) × 50)
  //   net   P&L        = ₹ 41.22  (100 − 58.7766, rounded to 2 dp)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Trading cost formulas — NSE F&O (Requirement 10.6)', () => {
    // ── Reference trade constants ──────────────────────────────────────────
    const ENTRY_PRICE = 100;
    const EXIT_PRICE = 102;
    const QTY = 50;

    const BUY_TURNOVER = ENTRY_PRICE * QTY; // 5 000
    const SELL_TURNOVER = EXIT_PRICE * QTY; // 5 100
    const TOTAL_TURNOVER = BUY_TURNOVER + SELL_TURNOVER; // 10 100

    const EXP_BROKERAGE = 40; // ₹40 flat
    const EXP_STT = SELL_TURNOVER * 0.001; // 5.10 (Budget 2024: 0.1% on sell premium)
    const EXP_EXCHANGE_CHARGES = TOTAL_TURNOVER * 0.00053; // 5.353
    const EXP_GST = (EXP_BROKERAGE + EXP_EXCHANGE_CHARGES) * 0.18; // 8.1635…
    const EXP_SEBI = TOTAL_TURNOVER * 0.000001; // 0.0101
    const EXP_STAMP_DUTY = BUY_TURNOVER * 0.00003; // 0.15

    /**
     * Sets up the two repo/Redis mocks required for a full trade close:
     *  - an open LONG position with the given entryPrice
     *  - a market snapshot where bidPrice = exitPrice (SELL uses bid)
     */
    function setupTradeCloseMocks(entryPrice: number, exitPrice: number, qty: number): void {
      const openPosition: Partial<PaperPosition> = {
        id: 'pos-cost-ref-001',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: qty,
        average_entry_price: entryPrice.toFixed(2),
        is_open: true,
        opened_at: new Date('2024-01-01T09:00:00Z'),
        mfe: '0',
        mae: '0',
        signal_id: null,
      };
      mockPaperPositionsRepo.findOne.mockResolvedValue(openPosition);

      const snapshotJson = JSON.stringify({
        ltp: exitPrice.toFixed(2),
        bidPrice: exitPrice.toFixed(2), // SELL fills at bid
        askPrice: (exitPrice + 0.5).toFixed(2),
        volume: '50000',
        oi: '123456',
        timestamp: Date.now(),
      });

      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(snapshotJson); // market snapshot
    }

    // ── 1. Individual cost component formulas ─────────────────────────────

    it('brokerage stored in PaperTrade equals ₹40 flat (₹20 per order side)', async () => {
      setupTradeCloseMocks(ENTRY_PRICE, EXIT_PRICE, QTY);

      await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: QTY }),
      );

      const args = mockPaperTradesRepo.create.mock.calls[0][0] as Record<string, string>;
      expect(parseFloat(args.brokerage)).toBeCloseTo(EXP_BROKERAGE, 4);
    });

    it('STT stored in PaperTrade equals 0.1% of sell-side turnover only (Budget 2024, eff. Oct 2024)', async () => {
      setupTradeCloseMocks(ENTRY_PRICE, EXIT_PRICE, QTY);

      await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: QTY }),
      );

      const args = mockPaperTradesRepo.create.mock.calls[0][0] as Record<string, string>;
      expect(parseFloat(args.stt)).toBeCloseTo(EXP_STT, 4);
    });

    it('exchange_charges stored in PaperTrade equals 0.053% of total (buy + sell) turnover', async () => {
      setupTradeCloseMocks(ENTRY_PRICE, EXIT_PRICE, QTY);

      await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: QTY }),
      );

      const args = mockPaperTradesRepo.create.mock.calls[0][0] as Record<string, string>;
      expect(parseFloat(args.exchange_charges)).toBeCloseTo(EXP_EXCHANGE_CHARGES, 4);
    });

    it('GST stored in PaperTrade equals 18% of (brokerage + exchange_charges)', async () => {
      setupTradeCloseMocks(ENTRY_PRICE, EXIT_PRICE, QTY);

      await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: QTY }),
      );

      const args = mockPaperTradesRepo.create.mock.calls[0][0] as Record<string, string>;
      expect(parseFloat(args.gst)).toBeCloseTo(EXP_GST, 4);
    });

    it('SEBI charges stored in PaperTrade equal ₹10 per crore of total turnover', async () => {
      setupTradeCloseMocks(ENTRY_PRICE, EXIT_PRICE, QTY);

      await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: QTY }),
      );

      const args = mockPaperTradesRepo.create.mock.calls[0][0] as Record<string, string>;
      expect(parseFloat(args.sebi_charges)).toBeCloseTo(EXP_SEBI, 6);
    });

    it('stamp_duty stored in PaperTrade equals 0.003% of buy-side (entry) turnover only', async () => {
      setupTradeCloseMocks(ENTRY_PRICE, EXIT_PRICE, QTY);

      await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: QTY }),
      );

      const args = mockPaperTradesRepo.create.mock.calls[0][0] as Record<string, string>;
      expect(parseFloat(args.stamp_duty)).toBeCloseTo(EXP_STAMP_DUTY, 4);
    });

    // ── 2. Exact breakdown: all 6 components for the reference trade ───────

    it('exact cost breakdown matches expected values for 50 lots @ ₹100 entry, ₹102 exit', async () => {
      setupTradeCloseMocks(ENTRY_PRICE, EXIT_PRICE, QTY);

      await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: QTY }),
      );

      const args = mockPaperTradesRepo.create.mock.calls[0][0] as Record<string, string>;

      expect(parseFloat(args.brokerage)).toBeCloseTo(40.0, 4); // ₹40.0000
      expect(parseFloat(args.stt)).toBeCloseTo(5.1, 4); // ₹5.1000  (0.1% × 5100, Budget 2024)
      expect(parseFloat(args.exchange_charges)).toBeCloseTo(5.353, 4); // ₹5.3530
      expect(parseFloat(args.gst)).toBeCloseTo(8.1635, 4); // ₹8.1635
      expect(parseFloat(args.sebi_charges)).toBeCloseTo(0.0101, 4); // ₹0.0101
      expect(parseFloat(args.stamp_duty)).toBeCloseTo(0.15, 4); // ₹0.1500
    });

    // ── 3. Accounting identity: net_pnl = gross_pnl − Σ(all 6 costs) ──────

    it('net_pnl in PaperTrade equals gross_pnl minus the sum of all six cost components', async () => {
      setupTradeCloseMocks(ENTRY_PRICE, EXIT_PRICE, QTY);

      await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: QTY }),
      );

      const args = mockPaperTradesRepo.create.mock.calls[0][0] as Record<string, string>;

      const grossPnl = parseFloat(args.gross_pnl);
      const netPnl = parseFloat(args.net_pnl);

      const sumOfCosts =
        parseFloat(args.brokerage) +
        parseFloat(args.stt) +
        parseFloat(args.exchange_charges) +
        parseFloat(args.gst) +
        parseFloat(args.sebi_charges) +
        parseFloat(args.stamp_duty);

      // Allow ±₹0.01 tolerance for the two-decimal-place rounding applied by toFixed(2)
      expect(netPnl).toBeCloseTo(grossPnl - sumOfCosts, 2);
    });

    // ── 4. Winning trade: net P&L is strictly less than gross P&L ─────────

    it('winning trade: net_pnl is always strictly less than gross_pnl (costs always reduce P&L)', async () => {
      setupTradeCloseMocks(ENTRY_PRICE, EXIT_PRICE, QTY);

      await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: QTY }),
      );

      const args = mockPaperTradesRepo.create.mock.calls[0][0] as Record<string, string>;
      const grossPnl = parseFloat(args.gross_pnl);
      const netPnl = parseFloat(args.net_pnl);

      expect(grossPnl).toBeGreaterThan(0); // it is a winning trade
      expect(netPnl).toBeLessThan(grossPnl); // costs always reduce P&L
    });

    // ── 5. Break-even trade: gross P&L = 0 → net P&L must be negative ─────

    it('break-even trade (entry price = exit price) has negative net_pnl due to trading costs', async () => {
      // Open LONG at ₹100; exit (SELL) at the same ₹100 → gross P&L = 0
      const breakEvenPosition: Partial<PaperPosition> = {
        id: 'pos-be-ref-001',
        engine: 'PAPER',
        instrument_id: 'instr-test-001',
        direction: 'LONG',
        quantity: 50,
        average_entry_price: '100.00',
        is_open: true,
        opened_at: new Date('2024-01-01T09:00:00Z'),
        mfe: '0',
        mae: '0',
        signal_id: null,
      };
      mockPaperPositionsRepo.findOne.mockResolvedValue(breakEvenPosition);

      // SELL fills at bid = ₹100.00, same as entry
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(
          JSON.stringify({
            ltp: '100.00',
            bidPrice: '100.00',
            askPrice: '100.50',
            volume: '50000',
            oi: '123456',
            timestamp: Date.now(),
          }),
        );

      await service.submitPaperOrder(
        buildPaperOrderRequest({ transactionType: 'SELL', quantity: 50 }),
      );

      const args = mockPaperTradesRepo.create.mock.calls[0][0] as Record<string, string>;
      const grossPnl = parseFloat(args.gross_pnl);
      const netPnl = parseFloat(args.net_pnl);

      expect(grossPnl).toBeCloseTo(0, 2); // gross P&L is zero at break-even
      expect(netPnl).toBeLessThan(0); // net P&L is negative due to costs
    });

    // ── 6. Costs are deducted at trade-close (round-trip complete) ─────────

    it('costs are deducted only at trade close, not during partial fills or open positions', async () => {
      // A BUY that opens a NEW position (no open position yet) → no PaperTrade,
      // therefore no cost fields should appear in paperTradesRepo.create
      (mockRedis.get as jest.Mock)
        .mockResolvedValueOnce(null) // idempotency miss
        .mockResolvedValueOnce(buildMarketSnapshotJson()); // snapshot

      await service.submitPaperOrder(buildPaperOrderRequest({ transactionType: 'BUY' }));

      // No trade created yet (position is still open)
      expect(mockPaperTradesRepo.create).not.toHaveBeenCalled();
      expect(mockPaperTradesRepo.save).not.toHaveBeenCalled();
    });
  });
});
