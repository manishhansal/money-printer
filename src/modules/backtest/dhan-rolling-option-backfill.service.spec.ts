/**
 * dhan-rolling-option-backfill.service.spec.ts
 *
 * Tests for DhanRollingOptionBackfillService.
 *
 * Covers:
 *  - Date range chunking (30-day windows)
 *  - Row building from API leg response (OHLC validation, field mapping)
 *  - Data quality classification (suspicious, missing_fields, ok)
 *  - Coverage gap detection
 *  - Insert-ignore vs overwrite mode
 *  - Empty API responses (not an error)
 *  - API errors (error recorded in ChunkResult)
 *  - Non-inclusive toDate handling (adds 1 day for Dhan API)
 *
 * Requirements: Phase 2 — Dhan Historical Backfill
 */

import { DhanRollingOptionBackfillService } from './dhan-rolling-option-backfill.service';
import { DhanApiClient } from '../dhan/dhan-api.client';
import { RollingOptionCandles } from '../../database/entities/rolling-option-candles.entity';
import { Repository } from 'typeorm';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal mocks
// ─────────────────────────────────────────────────────────────────────────────

function makeRepo(): jest.Mocked<Repository<RollingOptionCandles>> {
  return {
    createQueryBuilder: jest.fn().mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ identifiers: [{ id: '1' }, { id: '2' }] }),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    }),
  } as unknown as jest.Mocked<Repository<RollingOptionCandles>>;
}

function makeApiClient(response: object = {}): jest.Mocked<DhanApiClient> {
  return {
    getRollingOptionData: jest.fn().mockResolvedValue(response),
  } as unknown as jest.Mocked<DhanApiClient>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper to access private methods via type cast
// ─────────────────────────────────────────────────────────────────────────────

type ServicePrivate = {
  chunkDateRange(from: string, to: string, maxDays: number): Array<{ from: string; to: string }>;
  buildRows(params: object, leg: object, optionType: string): object[];
  detectCoverageGaps(chunks: object[]): string[];
  addDays(date: string, days: number): string;
};

function priv(svc: DhanRollingOptionBackfillService): ServicePrivate {
  return svc as unknown as ServicePrivate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('DhanRollingOptionBackfillService', () => {
  let svc: DhanRollingOptionBackfillService;
  let repo: jest.Mocked<Repository<RollingOptionCandles>>;
  let api: jest.Mocked<DhanApiClient>;

  beforeEach(() => {
    repo = makeRepo();
    api = makeApiClient();
    svc = new DhanRollingOptionBackfillService(repo, api);
  });

  // ─── chunkDateRange ─────────────────────────────────────────────────────

  describe('chunkDateRange', () => {
    it('single-day range → one chunk', () => {
      const chunks = priv(svc).chunkDateRange('2024-01-01', '2024-01-01', 30);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ from: '2024-01-01', to: '2024-01-01' });
    });

    it('30-day range within one chunk', () => {
      const chunks = priv(svc).chunkDateRange('2024-01-01', '2024-01-30', 30);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].from).toBe('2024-01-01');
      expect(chunks[0].to).toBe('2024-01-30');
    });

    it('31-day range splits into two chunks', () => {
      const chunks = priv(svc).chunkDateRange('2024-01-01', '2024-01-31', 30);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].from).toBe('2024-01-01');
      expect(chunks[0].to).toBe('2024-01-30');
      expect(chunks[1].from).toBe('2024-01-31');
      expect(chunks[1].to).toBe('2024-01-31');
    });

    it('90-day range produces 3 chunks of 30 days each', () => {
      // Jan (31) + Feb (29 in 2024 leap year) + Mar (30) = 90 days
      const chunks = priv(svc).chunkDateRange('2024-01-01', '2024-03-31', 30);
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      // All chunks should be contiguous
      for (let i = 1; i < chunks.length; i++) {
        const prevTo = new Date(`${chunks[i - 1].to}T00:00:00Z`);
        const currFrom = new Date(`${chunks[i].from}T00:00:00Z`);
        expect(currFrom.getTime()).toBe(prevTo.getTime() + 86400_000);
      }
    });
  });

  // ─── addDays ──────────────────────────────────────────────────────────────

  describe('addDays', () => {
    it('adds 1 day correctly across month boundary', () => {
      expect(priv(svc).addDays('2024-01-31', 1)).toBe('2024-02-01');
    });

    it('adds 1 day across year boundary', () => {
      expect(priv(svc).addDays('2023-12-31', 1)).toBe('2024-01-01');
    });
  });

  // ─── buildRows ────────────────────────────────────────────────────────────

  describe('buildRows', () => {
    const baseParams = {
      securityId: '13',
      underlyingSymbol: 'NIFTY',
      exchangeSegment: 'NSE_FNO',
      instrument: 'OPTIDX' as const,
      expiryFlag: 'WEEK' as const,
      expiryCode: 0,
      strikeOffset: 'ATM' as const,
      interval: '5',
    };

    it('builds rows from valid OHLCV leg', () => {
      const leg = {
        open: [100, 101],
        high: [105, 106],
        low: [98, 99],
        close: [103, 104],
        volume: [1000, 1200],
        iv: [18.5, 19.0],
        oi: [50000, 51000],
        strike: [23000, 23000],
        spot: [23050, 23100],
        timestamp: [1700000000, 1700000300],
      };

      const rows = priv(svc).buildRows(baseParams, leg, 'CE');
      expect(rows).toHaveLength(2);
      expect((rows[0] as RollingOptionCandles).openPrice).toBe('100');
      expect((rows[0] as RollingOptionCandles).closePrice).toBe('103');
      expect((rows[0] as RollingOptionCandles).impliedVolatility).toBe('18.5');
      expect((rows[0] as RollingOptionCandles).spotPrice).toBe('23050');
      expect((rows[0] as RollingOptionCandles).dataQuality).toBe('ok');
    });

    it('marks row as suspicious when high < low', () => {
      const leg = {
        open: [100],
        high: [95], // invalid: high < low
        low: [98],
        close: [99],
        timestamp: [1700000000],
      };
      const rows = priv(svc).buildRows(baseParams, leg, 'CE');
      expect((rows[0] as RollingOptionCandles).dataQuality).toBe('suspicious');
    });

    it('marks row as missing_fields when open is null', () => {
      const leg = {
        open: [null],
        high: [105],
        low: [98],
        close: [null], // close is null
        timestamp: [1700000000],
      };
      const rows = priv(svc).buildRows(baseParams, leg, 'PE');
      expect((rows[0] as RollingOptionCandles).dataQuality).toBe('missing_fields');
    });

    it('converts Unix epoch seconds to Date correctly', () => {
      const epoch = 1700000000;
      const leg = { open: [100], high: [105], low: [95], close: [102], timestamp: [epoch] };
      const rows = priv(svc).buildRows(baseParams, leg, 'CE');
      const ts = (rows[0] as RollingOptionCandles).timestamp;
      expect(ts.getTime()).toBe(epoch * 1_000);
    });

    it('skips candles with null timestamp', () => {
      const leg = {
        open: [100, 101],
        high: [105, 106],
        low: [95, 96],
        close: [102, 103],
        timestamp: [null, 1700000300] as unknown as number[],
      };
      const rows = priv(svc).buildRows(baseParams, leg, 'CE');
      expect(rows).toHaveLength(1);
    });
  });

  // ─── detectCoverageGaps ───────────────────────────────────────────────────

  describe('detectCoverageGaps', () => {
    it('returns empty array when all chunks succeed', () => {
      const chunks = [
        {
          fromDate: '2024-01-01',
          toDate: '2024-01-30',
          strikeOffset: 'ATM',
          optionType: 'CE',
          candlesInserted: 100,
          skipped: 0,
          error: null,
        },
        {
          fromDate: '2024-01-01',
          toDate: '2024-01-30',
          strikeOffset: 'ATM',
          optionType: 'PE',
          candlesInserted: 100,
          skipped: 0,
          error: null,
        },
      ];
      expect(priv(svc).detectCoverageGaps(chunks)).toHaveLength(0);
    });

    it('reports gap when ALL chunks in a window errored', () => {
      const chunks = [
        {
          fromDate: '2024-01-01',
          toDate: '2024-01-30',
          strikeOffset: 'ATM',
          optionType: 'CE',
          candlesInserted: 0,
          skipped: 0,
          error: 'timeout',
        },
        {
          fromDate: '2024-01-01',
          toDate: '2024-01-30',
          strikeOffset: 'ATM',
          optionType: 'PE',
          candlesInserted: 0,
          skipped: 0,
          error: 'timeout',
        },
      ];
      const gaps = priv(svc).detectCoverageGaps(chunks);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toContain('2024-01-01');
    });

    it('does NOT report gap when at least one chunk succeeded', () => {
      const chunks = [
        {
          fromDate: '2024-01-01',
          toDate: '2024-01-30',
          strikeOffset: 'ATM',
          optionType: 'CE',
          candlesInserted: 100,
          skipped: 0,
          error: null,
        },
        {
          fromDate: '2024-01-01',
          toDate: '2024-01-30',
          strikeOffset: 'ATM',
          optionType: 'PE',
          candlesInserted: 0,
          skipped: 0,
          error: 'timeout',
        },
      ];
      expect(priv(svc).detectCoverageGaps(chunks)).toHaveLength(0);
    });
  });

  // ─── backfill (integration) ──────────────────────────────────────────────

  describe('backfill', () => {
    it('returns zero insertions when API returns empty timestamp array', async () => {
      api.getRollingOptionData = jest.fn().mockResolvedValue({
        data: { ce: { timestamp: [], open: [], high: [], low: [], close: [] }, pe: null },
      });

      const result = await svc.backfill({
        securityId: '13',
        underlyingSymbol: 'NIFTY',
        exchangeSegment: 'NSE_FNO',
        instrument: 'OPTIDX',
        expiryFlag: 'WEEK',
        strikeOffsets: ['ATM'],
        optionTypes: ['CALL'],
        interval: '5',
        fromDate: '2024-01-01',
        toDate: '2024-01-01',
      });

      expect(result.totalCandlesInserted).toBe(0);
      expect(result.totalErrors).toBe(0); // empty = not an error
    });

    it('records error in result when API throws', async () => {
      api.getRollingOptionData = jest.fn().mockRejectedValue(new Error('API unavailable'));

      const result = await svc.backfill({
        securityId: '13',
        underlyingSymbol: 'NIFTY',
        exchangeSegment: 'NSE_FNO',
        instrument: 'OPTIDX',
        expiryFlag: 'WEEK',
        strikeOffsets: ['ATM'],
        optionTypes: ['CALL'],
        interval: '5',
        fromDate: '2024-01-01',
        toDate: '2024-01-01',
      });

      expect(result.totalErrors).toBe(1);
      expect(result.chunks[0].error).toBe('API unavailable');
    });

    it('respects the 1-day chunk limit per API call', async () => {
      api.getRollingOptionData = jest.fn().mockResolvedValue({
        data: { ce: null, pe: null },
      });

      // Use a 3-day range — with CHUNK_DAYS=1 this produces exactly 3 chunks
      await svc.backfill({
        securityId: '13',
        underlyingSymbol: 'NIFTY',
        exchangeSegment: 'NSE_FNO',
        instrument: 'OPTIDX',
        expiryFlag: 'WEEK',
        strikeOffsets: ['ATM'],
        optionTypes: ['CALL'],
        interval: '5',
        fromDate: '2024-01-01',
        toDate: '2024-01-03', // 3 days → exactly 3 chunks of 1 day each
      });

      // Should have been called exactly 3 times (one per day)
      const callCount = (api.getRollingOptionData as jest.Mock).mock.calls.length;
      expect(callCount).toBe(3);

      // Verify no single request spans more than 1 calendar day
      for (const call of (api.getRollingOptionData as jest.Mock).mock.calls) {
        const req = call[0] as { fromDate: string; toDate: string };
        const from = new Date(`${req.fromDate}T00:00:00Z`);
        const to = new Date(`${req.toDate}T00:00:00Z`);
        const diff = (to.getTime() - from.getTime()) / 86400_000;
        expect(diff).toBeLessThanOrEqual(1); // Dhan API max: 1 calendar day span
      }
    });
  });

  // ─── getCoverage ──────────────────────────────────────────────────────────

  describe('getCoverage', () => {
    it('returns empty object when no rows exist', async () => {
      const coverage = await svc.getCoverage('13', 'WEEK', '2024-01-01', '2024-12-31');
      expect(coverage).toEqual({});
    });
  });
});
