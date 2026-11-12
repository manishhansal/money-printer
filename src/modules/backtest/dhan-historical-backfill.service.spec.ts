/**
 * dhan-historical-backfill.service.spec.ts
 *
 * Unit tests for DhanHistoricalBackfillService — DEFECT-005 fix.
 *
 * Coverage (16 tests):
 *
 *  Instrument filtering:
 *   1.  Returns empty result when no instruments match the filter
 *   2.  Respects underlyingSymbol filter
 *   3.  Respects instrumentType filter
 *   4.  Uses explicit instrumentIds when provided
 *   5.  Respects limit parameter
 *
 *  Candle fetching and storage:
 *   6.  Counts as succeeded when Dhan returns non-empty candle arrays
 *   7.  Counts as failed when Dhan returns empty candle arrays
 *   8.  Counts as failed when Dhan API throws an error
 *   9.  Converts Dhan Unix epoch seconds to JS Date correctly
 *  10.  Uses orIgnore (insert-only) when overwrite=false
 *  11.  Uses orUpdate when overwrite=true
 *
 *  Date chunking (intraday):
 *  12.  1m granularity chunks a 14-day range into two 7-day windows
 *  13.  1d granularity issues a single request (no chunking)
 *
 *  Result aggregation:
 *  14.  Correctly aggregates inserted counts across multiple instruments
 *  15.  Caps failedInstruments detail list at 50 entries
 *  16.  Returns correct durationMs > 0
 *
 * Requirements: DEFECT-005 — Dhan historical data backfill
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DhanHistoricalBackfillService, BackfillRequest } from './dhan-historical-backfill.service';
import { DhanApiClient } from '../dhan/dhan-api.client';
import { HistoricalCandles } from '../../database/entities/historical-candles.entity';
import { Instruments, InstrumentType } from '../../database/entities/instruments.entity';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeInstrument(overrides: Partial<Instruments> = {}): Instruments {
  return {
    id: `inst-${Math.random().toString(36).slice(2)}`,
    tradingSymbol: 'NIFTY24DEC20000CE',
    securityId: '12345',
    lotSize: 75,
    exchange: 'NSE',
    segment: 'D',
    instrumentType: 'OPTIDX',
    underlyingSymbol: 'NIFTY',
    isActive: true,
    isTradable: true,
    liquidityScore: 100,
    ...overrides,
  } as Instruments;
}

/** Minimal valid Dhan candle response with N data points. */
function makeDhanResponse(n: number, startEpochSec = 1_700_000_000) {
  return {
    open: Array(n).fill(100),
    high: Array(n).fill(102),
    low: Array(n).fill(98),
    close: Array(n).fill(101),
    volume: Array(n).fill(50_000),
    timestamp: Array.from({ length: n }, (_, i) => startEpochSec + i * 60),
    open_interest: Array(n).fill(0),
  };
}

interface MockDeps {
  service: DhanHistoricalBackfillService;
  dhanApiClient: { getHistoricalCandles: jest.Mock };
  candlesRepo: {
    createQueryBuilder: jest.Mock;
    _qb: {
      insert: jest.Mock;
      into: jest.Mock;
      values: jest.Mock;
      orIgnore: jest.Mock;
      orUpdate: jest.Mock;
      execute: jest.Mock;
    };
  };
  instrumentsRepo: {
    createQueryBuilder: jest.Mock;
    findByIds: jest.Mock;
    _qb: { where: jest.Mock; andWhere: jest.Mock; orderBy: jest.Mock; getMany: jest.Mock };
  };
}

async function buildService(instruments: Instruments[] = []): Promise<MockDeps> {
  const qbResult = { execute: jest.fn().mockResolvedValue({ identifiers: [] }) };
  const qbChain = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    orUpdate: jest.fn().mockReturnThis(),
    execute: qbResult.execute,
  };
  const candlesRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(qbChain),
    _qb: qbChain,
  };

  const instrQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(instruments),
  };
  const instrumentsRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(instrQb),
    findByIds: jest.fn().mockResolvedValue(instruments),
    _qb: instrQb,
  };

  const dhanApiClient = {
    getHistoricalCandles: jest.fn().mockResolvedValue(makeDhanResponse(0)), // empty by default
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      DhanHistoricalBackfillService,
      { provide: DhanApiClient, useValue: dhanApiClient },
      { provide: getRepositoryToken(HistoricalCandles), useValue: candlesRepo },
      { provide: getRepositoryToken(Instruments), useValue: instrumentsRepo },
    ],
  }).compile();

  return {
    service: module.get(DhanHistoricalBackfillService),
    dhanApiClient,
    candlesRepo,
    instrumentsRepo,
  };
}

const BASE_REQUEST: BackfillRequest = {
  fromDate: '2024-01-01',
  toDate: '2024-01-31',
  granularity: '1d',
};

// ─────────────────────────────────────────────────────────────────────────────
// 1–5. Instrument filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('DhanHistoricalBackfillService — instrument filtering', () => {
  it('returns empty result immediately when no instruments match the filter', async () => {
    const { service } = await buildService([]); // no instruments

    const result = await service.backfill(BASE_REQUEST);

    expect(result.instrumentsAttempted).toBe(0);
    expect(result.instrumentsSucceeded).toBe(0);
    expect(result.totalCandlesInserted).toBe(0);
  });

  it('applies underlyingSymbol filter via createQueryBuilder', async () => {
    const instr = makeInstrument({ underlying: 'NIFTY' });
    const { service, instrumentsRepo } = await buildService([instr]);

    await service.backfill({ ...BASE_REQUEST, underlyingSymbol: 'NIFTY' });

    expect(instrumentsRepo._qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('underlying'),
      expect.objectContaining({ sym: 'NIFTY' }),
    );
  });

  it('applies instrumentType filter via createQueryBuilder', async () => {
    const instr = makeInstrument({ instrumentType: 'INDEX_FUTURE' as InstrumentType });
    const { service, instrumentsRepo } = await buildService([instr]);

    await service.backfill({ ...BASE_REQUEST, instrumentType: 'INDEX_FUTURE' });

    expect(instrumentsRepo._qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('instrument_type'),
      expect.objectContaining({ type: 'INDEX_FUTURE' }),
    );
  });

  it('uses findByIds when instrumentIds are explicitly provided', async () => {
    const instr = makeInstrument();
    const { service, instrumentsRepo } = await buildService([instr]);

    await service.backfill({ ...BASE_REQUEST, instrumentIds: [instr.id] });

    expect(instrumentsRepo.findByIds).toHaveBeenCalledWith([instr.id]);
    // createQueryBuilder should NOT be called when instrumentIds are provided
    expect(instrumentsRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('respects limit parameter — slices instrument list to N entries', async () => {
    const instruments = Array.from({ length: 10 }, () => makeInstrument());
    const { service, dhanApiClient } = await buildService(instruments);
    dhanApiClient.getHistoricalCandles.mockResolvedValue(makeDhanResponse(5));

    const result = await service.backfill({ ...BASE_REQUEST, limit: 3 });

    expect(result.instrumentsAttempted).toBe(3);
    expect(dhanApiClient.getHistoricalCandles).toHaveBeenCalledTimes(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6–11. Candle fetching and storage
// ─────────────────────────────────────────────────────────────────────────────

describe('DhanHistoricalBackfillService — candle fetching and storage', () => {
  it('counts instrument as succeeded when Dhan returns non-empty candle arrays', async () => {
    const instr = makeInstrument();
    const { service, dhanApiClient, candlesRepo } = await buildService([instr]);
    dhanApiClient.getHistoricalCandles.mockResolvedValue(makeDhanResponse(10));
    candlesRepo._qb.execute.mockResolvedValue({ identifiers: Array(10).fill({ id: 'x' }) });

    const result = await service.backfill(BASE_REQUEST);

    expect(result.instrumentsSucceeded).toBe(1);
    expect(result.instrumentsFailed).toBe(0);
    expect(result.totalCandlesInserted).toBe(10);
  });

  it('counts instrument as failed when Dhan returns empty candle arrays', async () => {
    const instr = makeInstrument();
    const { service, dhanApiClient } = await buildService([instr]);
    dhanApiClient.getHistoricalCandles.mockResolvedValue(makeDhanResponse(0)); // empty

    const result = await service.backfill(BASE_REQUEST);

    expect(result.instrumentsFailed).toBe(1);
    expect(result.instrumentsSucceeded).toBe(0);
    expect(result.failedInstruments).toHaveLength(1);
    expect(result.failedInstruments[0].tradingSymbol).toBe(instr.tradingSymbol);
  });

  it('counts instrument as failed when Dhan API throws an error', async () => {
    const instr = makeInstrument();
    const { service, dhanApiClient } = await buildService([instr]);
    dhanApiClient.getHistoricalCandles.mockRejectedValue(new Error('API rate limit'));

    const result = await service.backfill(BASE_REQUEST);

    expect(result.instrumentsFailed).toBe(1);
    // The service swallows API errors and reports a generic "No data returned"
    // message so the batch does not abort. The API error is logged at DEBUG level.
    expect(result.failedInstruments[0].reason).toMatch(/No data returned/);
  });

  it('converts Dhan Unix epoch seconds to JS Date correctly', async () => {
    const instr = makeInstrument();
    const { service, dhanApiClient, candlesRepo } = await buildService([instr]);
    // Epoch 1_700_000_000 seconds = 2023-11-14T22:13:20.000Z
    const epochSec = 1_700_000_000;
    dhanApiClient.getHistoricalCandles.mockResolvedValue({
      open: [100],
      high: [102],
      low: [98],
      close: [101],
      volume: [5000],
      timestamp: [epochSec],
      open_interest: [0],
    });
    candlesRepo._qb.execute.mockResolvedValue({ identifiers: [{ id: 'x' }] });

    await service.backfill(BASE_REQUEST);

    const insertedValues = candlesRepo._qb.values.mock.calls[0][0] as Array<{ timestamp: Date }>;
    const ts = insertedValues[0].timestamp;
    expect(ts).toBeInstanceOf(Date);
    // epochSec × 1000 = JS milliseconds
    expect(ts.getTime()).toBe(epochSec * 1_000);
  });

  it('uses orIgnore (insert-only, no conflict update) when overwrite=false', async () => {
    const instr = makeInstrument();
    const { service, dhanApiClient, candlesRepo } = await buildService([instr]);
    dhanApiClient.getHistoricalCandles.mockResolvedValue(makeDhanResponse(5));

    await service.backfill({ ...BASE_REQUEST, overwrite: false });

    expect(candlesRepo._qb.orIgnore).toHaveBeenCalled();
    expect(candlesRepo._qb.orUpdate).not.toHaveBeenCalled();
  });

  it('uses orUpdate (upsert) when overwrite=true', async () => {
    const instr = makeInstrument();
    const { service, dhanApiClient, candlesRepo } = await buildService([instr]);
    dhanApiClient.getHistoricalCandles.mockResolvedValue(makeDhanResponse(5));
    candlesRepo._qb.execute.mockResolvedValue({});

    await service.backfill({ ...BASE_REQUEST, overwrite: true });

    expect(candlesRepo._qb.orUpdate).toHaveBeenCalled();
    expect(candlesRepo._qb.orIgnore).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12–13. Date chunking
// ─────────────────────────────────────────────────────────────────────────────

describe('DhanHistoricalBackfillService — date chunking', () => {
  it('1m granularity splits a 14-day range into two 7-day API calls', async () => {
    const instr = makeInstrument();
    const { service, dhanApiClient } = await buildService([instr]);
    dhanApiClient.getHistoricalCandles.mockResolvedValue(makeDhanResponse(0));

    // 14-day range → should be chunked into two 7-day windows
    await service.backfill({
      fromDate: '2024-01-01',
      toDate: '2024-01-14',
      granularity: '1m',
    });

    // Expect 2 API calls for the same instrument (2 chunks)
    expect(dhanApiClient.getHistoricalCandles).toHaveBeenCalledTimes(2);
  });

  it('1d granularity issues a single API call for a 90-day range (no chunking)', async () => {
    const instr = makeInstrument();
    const { service, dhanApiClient } = await buildService([instr]);
    dhanApiClient.getHistoricalCandles.mockResolvedValue(makeDhanResponse(0));

    await service.backfill({
      fromDate: '2024-01-01',
      toDate: '2024-03-31',
      granularity: '1d',
    });

    // Daily granularity — no chunking; single call per instrument
    expect(dhanApiClient.getHistoricalCandles).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14–16. Result aggregation
// ─────────────────────────────────────────────────────────────────────────────

describe('DhanHistoricalBackfillService — result aggregation', () => {
  it('aggregates inserted counts correctly across multiple instruments', async () => {
    const instruments = [makeInstrument(), makeInstrument(), makeInstrument()];
    const { service, dhanApiClient, candlesRepo } = await buildService(instruments);
    dhanApiClient.getHistoricalCandles.mockResolvedValue(makeDhanResponse(5));
    candlesRepo._qb.execute.mockResolvedValue({ identifiers: Array(5).fill({ id: 'x' }) });

    const result = await service.backfill(BASE_REQUEST);

    expect(result.instrumentsAttempted).toBe(3);
    expect(result.instrumentsSucceeded).toBe(3);
    expect(result.totalCandlesInserted).toBe(15); // 3 × 5
  });

  it('caps failedInstruments detail list at 50 entries for large failure counts', async () => {
    // 60 instruments that all fail (empty response)
    const instruments = Array.from({ length: 60 }, () => makeInstrument());
    const { service, dhanApiClient } = await buildService(instruments);
    dhanApiClient.getHistoricalCandles.mockResolvedValue(makeDhanResponse(0));

    // Spy on the private sleep() method to bypass inter-batch delays (500ms × 12 batches
    // = 6 s would cause a Jest timeout in this unit test).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    const result = await service.backfill(BASE_REQUEST);

    expect(result.instrumentsFailed).toBe(60);
    // Detail list must be capped at 50
    expect(result.failedInstruments.length).toBeLessThanOrEqual(50);
  });

  it('returns durationMs ≥ 0 (synchronous mocks may complete in <1ms)', async () => {
    const instr = makeInstrument();
    const { service } = await buildService([instr]);

    const result = await service.backfill(BASE_REQUEST);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe('number');
  });
});
