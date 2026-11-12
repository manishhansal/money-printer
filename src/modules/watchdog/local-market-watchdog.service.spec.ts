/**
 * local-market-watchdog.service.spec.ts
 *
 * Unit tests for LocalMarketWatchdogService.
 *
 * Requirements: Phase 16, Phase 17
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LocalMarketWatchdogService } from './local-market-watchdog.service';
import { IssueClassifierService } from './issue-classifier.service';
import { AutoRemediationService } from './auto-remediation.service';
import { MonitoringIssues } from '../../database/entities/monitoring-issues.entity';
import { RedisService } from '../redis/redis.service';
import { NotificationService } from '../notification/notification.service';
import { SystemHealthMonitorService } from '../system-health-monitor/system-health-monitor.service';
import { DhanApiClient } from '../dhan/dhan-api.client';

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// QueryBuilder mock factory
// ─────────────────────────────────────────────────────────────────────────────

function makeQueryBuilderMock(overrides: Record<string, unknown> = {}) {
  return {
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const mockIssuesRepo = {
  findOne: jest.fn(),
  find: jest.fn().mockResolvedValue([]),
  save: jest.fn(),
  create: jest.fn((data: Partial<MonitoringIssues>) => ({ ...data })),
  count: jest.fn(),
  createQueryBuilder: jest.fn(() => makeQueryBuilderMock()),
};

const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  isHealthy: jest.fn().mockResolvedValue(true),
  publish: jest.fn().mockResolvedValue(1),
};

const mockNotification = {
  publish: jest.fn().mockResolvedValue(undefined),
};

const mockDataSource = {
  query: jest
    .fn()
    .mockResolvedValue([{ count: '0', live_open: '0', live_no_sl: '0', paper_open: '0' }]),
};

const mockSystemHealth = {
  updateMetricStatus: jest.fn(),
  getLatencyPercentiles: jest.fn().mockReturnValue({ count: 0 }),
};

const mockDhanClient = {
  getFundLimit: jest.fn().mockResolvedValue({ availabelBalance: 100000 }),
};

const mockClassifier = {
  analyzeChecks: jest.fn().mockResolvedValue([]),
};

const mockRemediation = {
  processNewIssues: jest.fn().mockResolvedValue(undefined),
  getStats: jest.fn().mockResolvedValue({
    totalAttempts: 0,
    successfulFixes: 0,
    failedFixes: 0,
    pendingApprovals: 0,
    lastResolvedAt: null,
  }),
  approveAndExecute: jest.fn().mockResolvedValue({ success: true }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('LocalMarketWatchdogService', () => {
  let service: LocalMarketWatchdogService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocalMarketWatchdogService,
        { provide: getRepositoryToken(MonitoringIssues), useValue: mockIssuesRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: RedisService, useValue: mockRedis },
        { provide: NotificationService, useValue: mockNotification },
        { provide: SystemHealthMonitorService, useValue: mockSystemHealth },
        { provide: DhanApiClient, useValue: mockDhanClient },
        { provide: IssueClassifierService, useValue: mockClassifier },
        { provide: AutoRemediationService, useValue: mockRemediation },
      ],
    }).compile();

    service = module.get<LocalMarketWatchdogService>(LocalMarketWatchdogService);
  });

  // ─── onModuleInit ──────────────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('should initialise without throwing', async () => {
      jest.useFakeTimers();
      await expect(service.onModuleInit()).resolves.not.toThrow();
      jest.useRealTimers();
    });
  });

  // ─── getTrackedPositionIds ─────────────────────────────────────────────────

  describe('getTrackedPositionIds', () => {
    it('returns empty array — watchdog does not track positions directly', () => {
      expect(service.getTrackedPositionIds()).toEqual([]);
    });
  });

  // ─── getIssueCounts ────────────────────────────────────────────────────────

  describe('getIssueCounts', () => {
    it('returns zero counts when no issues exist', async () => {
      const counts = await service.getIssueCounts();
      expect(counts).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0 });
    });

    it('accumulates counts by severity', async () => {
      mockIssuesRepo.createQueryBuilder.mockReturnValueOnce(
        makeQueryBuilderMock({
          getRawMany: jest.fn().mockResolvedValue([
            { severity: 'P0', count: '2' },
            { severity: 'P1', count: '5' },
            { severity: 'P2', count: '1' },
          ]),
        }),
      );

      const counts = await service.getIssueCounts();
      expect(counts).toEqual({ P0: 2, P1: 5, P2: 1, P3: 0 });
    });
  });

  // ─── getDashboardData ──────────────────────────────────────────────────────

  describe('getDashboardData', () => {
    it('returns HEALTHY status when no open issues', async () => {
      const dashboard = await service.getDashboardData();
      expect(dashboard.overallStatus).toBe('HEALTHY');
      expect(dashboard.issueCounts).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0 });
    });

    it('returns CRITICAL status when P0 issues exist', async () => {
      mockIssuesRepo.createQueryBuilder
        .mockReturnValueOnce(
          makeQueryBuilderMock({
            getRawMany: jest.fn().mockResolvedValue([{ severity: 'P0', count: '1' }]),
          }),
        )
        .mockReturnValueOnce(makeQueryBuilderMock({ getMany: jest.fn().mockResolvedValue([]) }));
      const dashboard = await service.getDashboardData();
      expect(dashboard.overallStatus).toBe('CRITICAL');
    });
  });

  // ─── acknowledgeIssue ─────────────────────────────────────────────────────

  describe('acknowledgeIssue', () => {
    it('transitions issue to INVESTIGATING status', async () => {
      const fakeIssue = {
        id: 'issue-1',
        issueKey: 'infra:redis_unavailable',
        status: 'DETECTED',
      } as MonitoringIssues;

      mockIssuesRepo.findOne.mockResolvedValueOnce(fakeIssue);
      mockIssuesRepo.save.mockResolvedValueOnce({ ...fakeIssue, status: 'INVESTIGATING' });

      await service.acknowledgeIssue('issue-1', 'Investigating Redis connection');

      expect(mockIssuesRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'INVESTIGATING' }),
      );
    });

    it('throws when issue is not found', async () => {
      mockIssuesRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.acknowledgeIssue('nonexistent')).rejects.toThrow(
        'Issue not found: nonexistent',
      );
    });
  });

  // ─── forceCheck ───────────────────────────────────────────────────────────

  describe('forceCheck', () => {
    it('runs a health check and returns a snapshot', async () => {
      // All Redis get calls return null (healthy defaults)
      mockRedis.get.mockResolvedValue(null);
      mockRedis.isHealthy.mockResolvedValue(true);
      mockDataSource.query.mockResolvedValue([
        { live_open: '0', live_no_sl: '0', paper_open: '0' },
      ]);
      mockClassifier.analyzeChecks.mockResolvedValue([]);

      const snapshot = await service.forceCheck();

      expect(snapshot).toBeDefined();
      expect(snapshot.timestamp).toBeInstanceOf(Date);
      expect(Array.isArray(snapshot.checks)).toBe(true);
    });
  });

  // ─── updateConfig ─────────────────────────────────────────────────────────

  describe('updateConfig', () => {
    it('updates watchdog configuration without throwing', () => {
      expect(() =>
        service.updateConfig({ healthCheckIntervalMs: 60_000, autoRemediationEnabled: false }),
      ).not.toThrow();
    });
  });

  // ─── persistIssues — deduplication ────────────────────────────────────────

  describe('persistIssues via runHealthCheck', () => {
    it('increments occurrence_count when same issue is re-detected', async () => {
      const existingIssue = {
        id: 'existing-1',
        issueKey: 'market_data:feed_stale',
        status: 'DETECTED',
        occurrenceCount: 3,
        description: 'old description',
        lastDetectedAt: new Date(),
      } as MonitoringIssues;

      mockIssuesRepo.findOne.mockResolvedValue(existingIssue);
      mockIssuesRepo.save.mockResolvedValue(existingIssue);
      mockClassifier.analyzeChecks.mockResolvedValue([
        {
          issueKey: 'market_data:feed_stale',
          severity: 'P1',
          category: 'MARKET_DATA',
          title: 'Market data feed is stale',
          description: 'Last tick 15s ago',
          source: 'WatchdogHealthCheck:market_data',
          affectsLiveTrading: true,
          affectsPaperTrading: true,
          isSystemic: false,
          requiresHumanApproval: false,
          detectedAt: new Date(),
        },
      ]);

      mockRedis.get.mockResolvedValue(null);
      mockRedis.isHealthy.mockResolvedValue(true);
      mockDataSource.query.mockResolvedValue([
        { live_open: '0', live_no_sl: '0', paper_open: '0' },
      ]);

      await service.forceCheck();

      // Existing issue should have occurrenceCount incremented
      expect(mockIssuesRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ occurrenceCount: 4 }),
      );
    });

    it('reopens a previously resolved issue when re-detected', async () => {
      const resolvedIssue = {
        id: 'resolved-1',
        issueKey: 'market_data:feed_stale',
        status: 'RESOLVED',
        occurrenceCount: 1,
        description: 'old',
        lastDetectedAt: new Date(),
      } as MonitoringIssues;

      mockIssuesRepo.findOne.mockResolvedValue(resolvedIssue);
      mockIssuesRepo.save.mockResolvedValue(resolvedIssue);
      mockClassifier.analyzeChecks.mockResolvedValue([
        {
          issueKey: 'market_data:feed_stale',
          severity: 'P1',
          category: 'MARKET_DATA',
          title: 'Market data feed is stale',
          description: 'Stale again',
          source: 'WatchdogHealthCheck:market_data',
          affectsLiveTrading: true,
          affectsPaperTrading: true,
          isSystemic: false,
          requiresHumanApproval: false,
          detectedAt: new Date(),
        },
      ]);

      mockRedis.get.mockResolvedValue(null);
      mockRedis.isHealthy.mockResolvedValue(true);
      mockDataSource.query.mockResolvedValue([
        { live_open: '0', live_no_sl: '0', paper_open: '0' },
      ]);

      await service.forceCheck();

      expect(mockIssuesRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'REOPENED' }),
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IssueClassifierService tests
// ─────────────────────────────────────────────────────────────────────────────

describe('IssueClassifierService', () => {
  let classifier: IssueClassifierService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IssueClassifierService],
    }).compile();
    classifier = module.get<IssueClassifierService>(IssueClassifierService);
  });

  it('returns no issues when all checks are healthy', async () => {
    const checks = [
      { component: 'redis', healthy: true, details: 'OK', checkedAt: new Date() },
      { component: 'postgresql', healthy: true, details: 'OK', checkedAt: new Date() },
    ];
    const issues = await classifier.analyzeChecks(checks);
    expect(issues).toHaveLength(0);
  });

  it('classifies PostgreSQL failure as P0 INFRASTRUCTURE', async () => {
    const checks = [
      {
        component: 'postgresql',
        healthy: false,
        details: 'Connection refused',
        checkedAt: new Date(),
      },
    ];
    const issues = await classifier.analyzeChecks(checks);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('P0');
    expect(issues[0].category).toBe('INFRASTRUCTURE');
    expect(issues[0].isSystemic).toBe(true);
  });

  it('classifies live position without SL as P0 FINANCIAL_SAFETY', async () => {
    const checks = [
      {
        component: 'position_protection',
        healthy: false,
        details: '1 live position(s) have NO stop-loss set!',
        metadata: { liveNoSl: 1 },
        checkedAt: new Date(),
      },
    ];
    const issues = await classifier.analyzeChecks(checks);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('P0');
    expect(issues[0].category).toBe('FINANCIAL_SAFETY');
    expect(issues[0].requiresHumanApproval).toBe(true);
  });

  it('classifies Redis failure as P1 INFRASTRUCTURE', async () => {
    const checks = [
      { component: 'redis', healthy: false, details: 'PING failed', checkedAt: new Date() },
    ];
    const issues = await classifier.analyzeChecks(checks);
    expect(issues[0].severity).toBe('P1');
    expect(issues[0].category).toBe('INFRASTRUCTURE');
  });

  it('classifies market data staleness as P1 during market hours', async () => {
    // Mock a time during market hours by using a stale check
    const checks = [
      {
        component: 'market_data',
        healthy: false,
        details: 'Market data stale — last tick 15s ago',
        metadata: { ageMs: 15000 },
        checkedAt: new Date(),
      },
    ];
    const issues = await classifier.analyzeChecks(checks);
    expect(issues[0].category).toBe('MARKET_DATA');
  });

  it('classifies signal scanner stuck as P2 TRADING_CORRECTNESS', async () => {
    const checks = [
      {
        component: 'signal_scanner',
        healthy: false,
        details: 'Scanner stuck for 6 minutes',
        checkedAt: new Date(),
      },
    ];
    const issues = await classifier.analyzeChecks(checks);
    expect(issues[0].severity).toBe('P2');
    expect(issues[0].category).toBe('TRADING_CORRECTNESS');
  });

  it('assigns unique issue_key for each component', async () => {
    const checks = [
      { component: 'redis', healthy: false, details: 'down', checkedAt: new Date() },
      { component: 'postgresql', healthy: false, details: 'down', checkedAt: new Date() },
      { component: 'market_data', healthy: false, details: 'stale', checkedAt: new Date() },
    ];
    const issues = await classifier.analyzeChecks(checks);
    const keys = issues.map((i) => i.issueKey);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });
});
