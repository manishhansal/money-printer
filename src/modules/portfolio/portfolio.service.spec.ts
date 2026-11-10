/**
 * PortfolioService unit tests.
 *
 * Covers:
 *   1. getDynamicCapital — returns starting_capital when no ledger entries exist.
 *   2. getDynamicCapital — accumulates net_pnl correctly after multiple trades.
 *   3. recordTradeAndUpdateCapital — transaction failure emits
 *      `capital.ledger.failure` event and preserves the last committed balance.
 *   4. refreshFromDatabase — loads from CapitalLedgers if entries exist.
 *   5. Open-position management (addPosition, removePosition, getOpenPositions).
 *
 * All DB interactions are mocked so tests run without a live database.
 *
 * Requirements: 9.1, 18.2, 18.3, 18.4
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  PortfolioService,
  CAPITAL_LEDGER_FAILURE_EVENT,
  CompletedTradeData,
} from './portfolio.service';

import { CapitalLedgers } from '../../database/entities/capital-ledgers.entity';
import { Position } from '../../database/entities/positions.entity';
import { UserSettings } from '../../database/entities/user-settings.entity';
import { SystemHealthEvents } from '../../database/entities/system-health-events.entity';

// ─── Mock factories ────────────────────────────────────────────────────────────

/** Mock TypeORM repository with the subset of methods used by PortfolioService. */
function mockRepo() {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((data: any) => data),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

/**
 * Mock DataSource whose `transaction` callback receives a mock EntityManager.
 * Succeeds by default; individual tests override with mockRejectedValueOnce.
 */
function mockDataSourceFactory() {
  return {
    transaction: jest.fn().mockImplementation(async (cb: (m: any) => Promise<void>) => {
      const mockManager = {
        insert: jest.fn().mockResolvedValue({ raw: [], generatedMaps: [], identifiers: [] }),
      };
      return cb(mockManager);
    }),
  };
}

// ─── Test fixtures ─────────────────────────────────────────────────────────────

/** Partial UserSettings record that models a configured trader. */
const defaultSettings: Partial<UserSettings> = {
  liveStartingCapital: '500000.00',
  paperStartingCapital: '100000.00',
};

/** Completed trade fixture — profitable trade worth 360.40 INR net. */
const profitableTrade: CompletedTradeData = {
  tradeId: 'trade-uuid-profitable',
  netPnl: '360.40',
};

/** Completed trade fixture — losing trade costing 120.50 INR net. */
const losingTrade: CompletedTradeData = {
  tradeId: 'trade-uuid-losing',
  netPnl: '-120.50',
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds a TestingModule with fresh mocks and calls onModuleInit.
 * Returned service is ready for use; mocks are returned for assertion overrides.
 */
async function buildModule() {
  const capitalLedgersRepo = mockRepo();
  const positionsRepo = mockRepo();
  const userSettingsRepo = mockRepo();
  const systemHealthEventsRepo = mockRepo();
  const dataSource = mockDataSourceFactory();
  const eventEmitter = { emit: jest.fn() };

  // Default: no existing ledger entries; UserSettings has standard capitals.
  capitalLedgersRepo.findOne.mockResolvedValue(null);
  userSettingsRepo.findOne.mockResolvedValue(defaultSettings);

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PortfolioService,
      { provide: getRepositoryToken(CapitalLedgers), useValue: capitalLedgersRepo },
      { provide: getRepositoryToken(Position), useValue: positionsRepo },
      { provide: getRepositoryToken(UserSettings), useValue: userSettingsRepo },
      { provide: getRepositoryToken(SystemHealthEvents), useValue: systemHealthEventsRepo },
      // @InjectDataSource() resolves to the DataSource class token for the default connection.
      { provide: DataSource, useValue: dataSource },
      { provide: EventEmitter2, useValue: eventEmitter },
    ],
  }).compile();

  const service = module.get<PortfolioService>(PortfolioService);
  await service.onModuleInit();

  return {
    service,
    capitalLedgersRepo,
    positionsRepo,
    userSettingsRepo,
    systemHealthEventsRepo,
    dataSource,
    eventEmitter,
  };
}

// ─── Test suite ────────────────────────────────────────────────────────────────

describe('PortfolioService', () => {
  // ─── 1. getDynamicCapital — initial state from UserSettings ───────────────

  describe('getDynamicCapital — initial state (no ledger entries)', () => {
    it('returns paperStartingCapital for PAPER when no CapitalLedgers rows exist', async () => {
      const { service } = await buildModule();
      // Requirement 9.1: Dynamic_Capital = starting_capital when SUM(net_pnl) = 0.
      expect(service.getDynamicCapital('PAPER')).toBe('100000.00');
    });

    it('returns liveStartingCapital for LIVE when no CapitalLedgers rows exist', async () => {
      const { service } = await buildModule();
      expect(service.getDynamicCapital('LIVE')).toBe('500000.00');
    });

    it('defaults to 0.00 when UserSettings has no rows and no ledger entries exist', async () => {
      const capitalLedgersRepo = mockRepo();
      const positionsRepo = mockRepo();
      const userSettingsRepo = mockRepo();
      const systemHealthEventsRepo = mockRepo();
      const dataSource = mockDataSourceFactory();

      // No settings and no ledger entries
      capitalLedgersRepo.findOne.mockResolvedValue(null);
      userSettingsRepo.findOne.mockResolvedValue(null);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PortfolioService,
          { provide: getRepositoryToken(CapitalLedgers), useValue: capitalLedgersRepo },
          { provide: getRepositoryToken(Position), useValue: positionsRepo },
          { provide: getRepositoryToken(UserSettings), useValue: userSettingsRepo },
          { provide: getRepositoryToken(SystemHealthEvents), useValue: systemHealthEventsRepo },
          { provide: DataSource, useValue: dataSource },
          { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        ],
      }).compile();

      const service = module.get<PortfolioService>(PortfolioService);
      await service.onModuleInit();

      expect(service.getDynamicCapital('PAPER')).toBe('0.00');
      expect(service.getDynamicCapital('LIVE')).toBe('0.00');
    });

    it('loads capital from latest CapitalLedgers balance_after when entries exist', async () => {
      const { service, capitalLedgersRepo } = await buildModule();

      // Simulate a later refreshFromDatabase call where a ledger entry now exists.
      capitalLedgersRepo.findOne.mockResolvedValue({
        balance_after: '105360.40',
        engine: 'PAPER',
        occurred_at: new Date(),
      });

      await service.refreshFromDatabase('PAPER');

      // Requirement 18.2: authoritative balance comes from the latest ledger entry.
      expect(service.getDynamicCapital('PAPER')).toBe('105360.40');
    });
  });

  // ─── 2. getDynamicCapital — P&L accumulation ──────────────────────────────

  describe('getDynamicCapital — net_pnl accumulation', () => {
    it('adds a single profitable trade to starting capital', async () => {
      const { service } = await buildModule();

      await service.recordTradeAndUpdateCapital(profitableTrade, 'PAPER');

      // 100000.00 + 360.40 = 100360.40
      expect(service.getDynamicCapital('PAPER')).toBe('100360.40');
    });

    it('subtracts a losing trade from starting capital', async () => {
      const { service } = await buildModule();

      await service.recordTradeAndUpdateCapital(losingTrade, 'PAPER');

      // 100000.00 - 120.50 = 99879.50
      expect(service.getDynamicCapital('PAPER')).toBe('99879.50');
    });

    it('accumulates multiple trades with correct 2 dp precision', async () => {
      const { service } = await buildModule();

      // trade1: +360.40  → 100360.40
      await service.recordTradeAndUpdateCapital(profitableTrade, 'PAPER');
      // trade2: -120.50  → 100239.90
      await service.recordTradeAndUpdateCapital(losingTrade, 'PAPER');
      // trade3: +87.25   → 100327.15
      await service.recordTradeAndUpdateCapital(
        { tradeId: 'trade-uuid-3', netPnl: '87.25' },
        'PAPER',
      );

      // 100000.00 + 360.40 − 120.50 + 87.25 = 100327.15
      expect(service.getDynamicCapital('PAPER')).toBe('100327.15');
    });

    it('maintains separate capital buckets for LIVE and PAPER engines', async () => {
      const { service } = await buildModule();
      const liveBefore = service.getDynamicCapital('LIVE');

      await service.recordTradeAndUpdateCapital(profitableTrade, 'PAPER');

      // LIVE capital must be untouched by a PAPER trade.
      expect(service.getDynamicCapital('LIVE')).toBe(liveBefore);
      expect(service.getDynamicCapital('PAPER')).toBe('100360.40');
    });

    it('handles fractional pnl values that require rounding to 2 dp', async () => {
      const { service } = await buildModule();

      // 100000.00 + 0.005 → rounds up to 100000.01
      await service.recordTradeAndUpdateCapital(
        { tradeId: 'trade-round', netPnl: '0.005' },
        'PAPER',
      );
      // 0.005 in 10,000ths = 50n → rounds up the 2nd dp
      expect(service.getDynamicCapital('PAPER')).toBe('100000.01');
    });

    it('correctly records the CapitalLedgers INSERT with balance_before and balance_after', async () => {
      const { service, dataSource } = await buildModule();

      // Capture what was passed to manager.insert
      let capturedInsertArgs: any = null;
      dataSource.transaction.mockImplementationOnce(async (cb: any) => {
        const mockManager = {
          insert: jest.fn().mockImplementation((_entity: any, data: any) => {
            capturedInsertArgs = data;
            return Promise.resolve({ raw: [], generatedMaps: [], identifiers: [] });
          }),
        };
        return cb(mockManager);
      });

      await service.recordTradeAndUpdateCapital(profitableTrade, 'PAPER');

      expect(capturedInsertArgs).toMatchObject({
        engine: 'PAPER',
        event_type: 'TRADE_PNL',
        trade_id: 'trade-uuid-profitable',
        amount: '360.40',
        balance_before: '100000.00',
        balance_after: '100360.40',
        description: null,
      });
      expect(capturedInsertArgs.occurred_at).toBeInstanceOf(Date);
    });
  });

  // ─── 3. Transaction failure — preserve balance & emit event ───────────────

  describe('recordTradeAndUpdateCapital — transaction failure', () => {
    it('emits capital.ledger.failure event when the DB transaction throws', async () => {
      const { service, dataSource, eventEmitter } = await buildModule();

      dataSource.transaction.mockRejectedValueOnce(new Error('DB connection lost'));

      await expect(service.recordTradeAndUpdateCapital(profitableTrade, 'PAPER')).rejects.toThrow(
        'DB connection lost',
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        CAPITAL_LEDGER_FAILURE_EVENT,
        expect.objectContaining({
          engine: 'PAPER',
          tradeId: 'trade-uuid-profitable',
          error: 'DB connection lost',
          timestamp: expect.any(Date),
        }),
      );
    });

    it('preserves the last committed balance when the DB transaction fails', async () => {
      const { service, dataSource } = await buildModule();

      // Starting balance: 100000.00
      const capitalBefore = service.getDynamicCapital('PAPER');
      expect(capitalBefore).toBe('100000.00');

      // Transaction fails → capital must NOT be updated (Req 18.4).
      dataSource.transaction.mockRejectedValueOnce(new Error('Deadlock detected'));

      await expect(service.recordTradeAndUpdateCapital(profitableTrade, 'PAPER')).rejects.toThrow();

      expect(service.getDynamicCapital('PAPER')).toBe(capitalBefore);
    });

    it('preserves the last committed (not initial) balance after a partial success', async () => {
      const { service, dataSource } = await buildModule();

      // First trade succeeds — capital is now 100360.40.
      await service.recordTradeAndUpdateCapital(profitableTrade, 'PAPER');
      const capitalAfterFirstTrade = service.getDynamicCapital('PAPER');
      expect(capitalAfterFirstTrade).toBe('100360.40');

      // Second trade fails — capital must stay at 100360.40, NOT roll back to 100000.00.
      dataSource.transaction.mockRejectedValueOnce(new Error('Timeout'));

      await expect(service.recordTradeAndUpdateCapital(losingTrade, 'PAPER')).rejects.toThrow();

      expect(service.getDynamicCapital('PAPER')).toBe('100360.40');
    });

    it('does NOT emit capital.ledger.failure when the transaction succeeds', async () => {
      const { service, eventEmitter } = await buildModule();

      await service.recordTradeAndUpdateCapital(profitableTrade, 'PAPER');

      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        CAPITAL_LEDGER_FAILURE_EVENT,
        expect.anything(),
      );
    });

    it('re-throws the original error after emitting the failure event', async () => {
      const { service, dataSource } = await buildModule();

      dataSource.transaction.mockRejectedValueOnce(new Error('FATAL: max_connections exceeded'));

      await expect(service.recordTradeAndUpdateCapital(profitableTrade, 'LIVE')).rejects.toThrow(
        'FATAL: max_connections exceeded',
      );
    });

    it('includes the correct engine in the failure event payload', async () => {
      const { service, dataSource, eventEmitter } = await buildModule();

      dataSource.transaction.mockRejectedValueOnce(new Error('disk full'));

      await expect(
        service.recordTradeAndUpdateCapital({ tradeId: 'live-trade', netPnl: '250.00' }, 'LIVE'),
      ).rejects.toThrow();

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        CAPITAL_LEDGER_FAILURE_EVENT,
        expect.objectContaining({ engine: 'LIVE' }),
      );
    });

    // ── SystemHealthEvents recording (Req 18.4) ──────────────────────────────

    it('records a SystemHealthEvents entry on transaction failure (Req 18.4)', async () => {
      const { service, dataSource, systemHealthEventsRepo } = await buildModule();

      dataSource.transaction.mockRejectedValueOnce(new Error('DB connection lost'));

      await expect(service.recordTradeAndUpdateCapital(profitableTrade, 'PAPER')).rejects.toThrow(
        'DB connection lost',
      );

      // create() must have been called with the expected fields
      expect(systemHealthEventsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'CAPITAL_LEDGER_FAIL',
          module_name: 'PortfolioService',
          severity: 'CRITICAL',
          message: expect.stringContaining('trade-uuid-profitable'),
        }),
      );
      // save() must have been called to persist the health event
      expect(systemHealthEventsRepo.save).toHaveBeenCalledTimes(1);
    });

    it('SystemHealthEvents message includes the error message (Req 18.4)', async () => {
      const { service, dataSource, systemHealthEventsRepo } = await buildModule();

      dataSource.transaction.mockRejectedValueOnce(new Error('Deadlock detected'));

      await expect(service.recordTradeAndUpdateCapital(profitableTrade, 'PAPER')).rejects.toThrow();

      const createdArg = systemHealthEventsRepo.create.mock.calls[0][0];
      expect(createdArg.message).toContain('Deadlock detected');
    });

    it('still re-throws the original error even when SystemHealthEvents save succeeds', async () => {
      const { service, dataSource } = await buildModule();

      dataSource.transaction.mockRejectedValueOnce(new Error('FATAL: disk full'));

      await expect(service.recordTradeAndUpdateCapital(profitableTrade, 'PAPER')).rejects.toThrow(
        'FATAL: disk full',
      );
    });

    it('still re-throws the original error when SystemHealthEvents save also fails', async () => {
      const { service, dataSource, systemHealthEventsRepo } = await buildModule();

      dataSource.transaction.mockRejectedValueOnce(new Error('Primary DB down'));
      systemHealthEventsRepo.save.mockRejectedValueOnce(new Error('Replica also down'));

      // Must still throw the original DB error, not the health-event error
      await expect(service.recordTradeAndUpdateCapital(profitableTrade, 'PAPER')).rejects.toThrow(
        'Primary DB down',
      );
    });

    it('does NOT record a SystemHealthEvents entry on a successful transaction', async () => {
      const { service, systemHealthEventsRepo } = await buildModule();

      await service.recordTradeAndUpdateCapital(profitableTrade, 'PAPER');

      expect(systemHealthEventsRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─── 4. Open positions management ─────────────────────────────────────────

  describe('open positions', () => {
    it('returns empty array for each engine on first startup (no DB rows)', async () => {
      const { service } = await buildModule();
      expect(service.getOpenPositions('LIVE')).toEqual([]);
      expect(service.getOpenPositions('PAPER')).toEqual([]);
    });

    it('addPosition adds a position to the correct engine bucket', () => {
      return buildModule().then(({ service }) => {
        const pos = { id: 'pos-1', engine: 'PAPER', is_open: true } as Position;
        service.addPosition(pos);

        expect(service.getOpenPositions('PAPER')).toContainEqual(pos);
        expect(service.getOpenPositions('LIVE')).toHaveLength(0);
      });
    });

    it('addPosition supports multiple positions for the same engine', () => {
      return buildModule().then(({ service }) => {
        const pos1 = { id: 'pos-1', engine: 'LIVE', is_open: true } as Position;
        const pos2 = { id: 'pos-2', engine: 'LIVE', is_open: true } as Position;
        service.addPosition(pos1);
        service.addPosition(pos2);

        const livePositions = service.getOpenPositions('LIVE');
        expect(livePositions).toHaveLength(2);
        expect(livePositions).toContainEqual(pos1);
        expect(livePositions).toContainEqual(pos2);
      });
    });

    it('removePosition removes the specified position by ID', () => {
      return buildModule().then(({ service }) => {
        const pos1 = { id: 'pos-1', engine: 'PAPER', is_open: true } as Position;
        const pos2 = { id: 'pos-2', engine: 'PAPER', is_open: true } as Position;
        service.addPosition(pos1);
        service.addPosition(pos2);

        service.removePosition('pos-1');

        const remaining = service.getOpenPositions('PAPER');
        expect(remaining).not.toContainEqual(pos1);
        expect(remaining).toContainEqual(pos2);
        expect(remaining).toHaveLength(1);
      });
    });

    it('removePosition is a no-op for an unknown positionId', () => {
      return buildModule().then(({ service }) => {
        const pos = { id: 'pos-known', engine: 'LIVE', is_open: true } as Position;
        service.addPosition(pos);

        service.removePosition('pos-unknown');

        expect(service.getOpenPositions('LIVE')).toHaveLength(1);
      });
    });

    it('removePosition searches across both engine buckets', () => {
      return buildModule().then(({ service }) => {
        const livePos = { id: 'live-pos', engine: 'LIVE', is_open: true } as Position;
        const paperPos = { id: 'paper-pos', engine: 'PAPER', is_open: true } as Position;
        service.addPosition(livePos);
        service.addPosition(paperPos);

        // Remove the paper position without specifying the engine
        service.removePosition('paper-pos');

        expect(service.getOpenPositions('PAPER')).toHaveLength(0);
        expect(service.getOpenPositions('LIVE')).toHaveLength(1);
      });
    });

    it('refreshFromDatabase reloads open positions from the DB', async () => {
      const { service, positionsRepo } = await buildModule();

      const dbPos = { id: 'db-pos', engine: 'LIVE', is_open: true } as Position;
      positionsRepo.find.mockResolvedValueOnce([dbPos]);

      await service.refreshFromDatabase('LIVE');

      expect(service.getOpenPositions('LIVE')).toContainEqual(dbPos);
    });
  });
});
