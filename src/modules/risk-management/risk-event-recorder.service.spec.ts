/**
 * RiskEventRecorderService unit tests.
 *
 * Coverage:
 *   recordZeroPerUnitRisk
 *     - Persists a RiskEvent with the correct field values
 *     - Is fire-and-forget: does NOT throw when the DB save fails
 *
 *   recordInvalidLotSize
 *     - Persists a RiskEvent with the correct field values (triggering_metric_value = lotSize)
 *     - Is fire-and-forget: does NOT throw when the DB save fails
 *
 * Requirements: 9.9, 9.11
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RiskEventRecorderService } from './risk-event-recorder.service';
import { RiskEvents } from '../../database/entities/risk-events.entity';

// ─────────────────────────────────────────────────────────────────────────────
// Repository mock factory
// ─────────────────────────────────────────────────────────────────────────────

type MockRepo = Pick<Repository<RiskEvents>, 'create' | 'save'>;

function buildMockRepo(): jest.Mocked<MockRepo> {
  return {
    create: jest.fn(),
    save: jest.fn(),
  };
}

async function buildService(repoMock: MockRepo): Promise<RiskEventRecorderService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RiskEventRecorderService,
      {
        provide: getRepositoryToken(RiskEvents),
        useValue: repoMock,
      },
    ],
  }).compile();

  return module.get<RiskEventRecorderService>(RiskEventRecorderService);
}

// ─────────────────────────────────────────────────────────────────────────────
// recordZeroPerUnitRisk
// ─────────────────────────────────────────────────────────────────────────────

describe('RiskEventRecorderService — recordZeroPerUnitRisk', () => {
  let service: RiskEventRecorderService;
  let repo: jest.Mocked<MockRepo>;

  beforeEach(async () => {
    repo = buildMockRepo();
    // `create` returns the entity object; `save` resolves it.
    repo.create.mockImplementation((data) => data as RiskEvents);
    repo.save.mockResolvedValue({} as RiskEvents);
    service = await buildService(repo);
  });

  it('calls riskEventsRepo.create with correct ZERO_PER_UNIT_RISK fields (Req 9.9)', async () => {
    await service.recordZeroPerUnitRisk('LIVE', '100.00', '100.00');

    expect(repo.create).toHaveBeenCalledTimes(1);
    const created = repo.create.mock.calls[0][0] as Partial<RiskEvents>;

    expect(created.engine).toBe('LIVE');
    expect(created.event_type).toBe('ZERO_PER_UNIT_RISK');
    expect(created.reason).toBe('zero per-unit risk');
    expect(created.triggering_metric_name).toBe('entry_stop_difference');
    expect(created.triggering_metric_value).toBe('0');
    expect(created.initiating_actor).toBe('RiskManagementService');
    expect(created.threshold_value).toBeNull();
    expect(created.affected_instrument_id).toBeNull();
    expect(created.affected_strategy_id).toBeNull();
    expect(created.occurred_at).toBeInstanceOf(Date);
  });

  it('calls riskEventsRepo.save with the entity returned by create', async () => {
    const fakeEntity = { id: 'fake-uuid' } as unknown as RiskEvents;
    repo.create.mockReturnValue(fakeEntity);

    await service.recordZeroPerUnitRisk('PAPER', '50.25', '50.25');

    expect(repo.save).toHaveBeenCalledWith(fakeEntity);
  });

  it('records with engine=PAPER correctly', async () => {
    await service.recordZeroPerUnitRisk('PAPER', '200.00', '200.00');

    const created = repo.create.mock.calls[0][0] as Partial<RiskEvents>;
    expect(created.engine).toBe('PAPER');
  });

  it('is fire-and-forget: does NOT throw when the DB save fails', async () => {
    repo.save.mockRejectedValue(new Error('DB connection lost'));

    // Must resolve without throwing — the error is swallowed internally.
    await expect(
      service.recordZeroPerUnitRisk('LIVE', '100.00', '100.00'),
    ).resolves.toBeUndefined();
  });

  it('is fire-and-forget: does NOT throw when create throws', async () => {
    repo.create.mockImplementation(() => {
      throw new Error('create failure');
    });

    await expect(
      service.recordZeroPerUnitRisk('LIVE', '100.00', '100.00'),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recordInvalidLotSize
// ─────────────────────────────────────────────────────────────────────────────

describe('RiskEventRecorderService — recordInvalidLotSize', () => {
  let service: RiskEventRecorderService;
  let repo: jest.Mocked<MockRepo>;

  beforeEach(async () => {
    repo = buildMockRepo();
    repo.create.mockImplementation((data) => data as RiskEvents);
    repo.save.mockResolvedValue({} as RiskEvents);
    service = await buildService(repo);
  });

  it('calls riskEventsRepo.create with correct INVALID_LOT_SIZE fields (Req 9.11)', async () => {
    await service.recordInvalidLotSize('LIVE', 0);

    expect(repo.create).toHaveBeenCalledTimes(1);
    const created = repo.create.mock.calls[0][0] as Partial<RiskEvents>;

    expect(created.engine).toBe('LIVE');
    expect(created.event_type).toBe('INVALID_LOT_SIZE');
    expect(created.reason).toBe('invalid lot_size configuration');
    expect(created.triggering_metric_name).toBe('lot_size');
    expect(created.triggering_metric_value).toBe('0');
    expect(created.initiating_actor).toBe('RiskManagementService');
    expect(created.threshold_value).toBeNull();
    expect(created.affected_instrument_id).toBeNull();
    expect(created.affected_strategy_id).toBeNull();
    expect(created.occurred_at).toBeInstanceOf(Date);
  });

  it('sets triggering_metric_value to the string representation of lotSize', async () => {
    await service.recordInvalidLotSize('LIVE', -25);

    const created = repo.create.mock.calls[0][0] as Partial<RiskEvents>;
    expect(created.triggering_metric_value).toBe('-25');
  });

  it('calls riskEventsRepo.save with the entity returned by create', async () => {
    const fakeEntity = { id: 'fake-uuid' } as unknown as RiskEvents;
    repo.create.mockReturnValue(fakeEntity);

    await service.recordInvalidLotSize('PAPER', 0);

    expect(repo.save).toHaveBeenCalledWith(fakeEntity);
  });

  it('records with engine=PAPER correctly', async () => {
    await service.recordInvalidLotSize('PAPER', -1);

    const created = repo.create.mock.calls[0][0] as Partial<RiskEvents>;
    expect(created.engine).toBe('PAPER');
  });

  it('is fire-and-forget: does NOT throw when the DB save fails', async () => {
    repo.save.mockRejectedValue(new Error('DB timeout'));

    await expect(service.recordInvalidLotSize('LIVE', 0)).resolves.toBeUndefined();
  });

  it('is fire-and-forget: does NOT throw when create throws', async () => {
    repo.create.mockImplementation(() => {
      throw new Error('create failure');
    });

    await expect(service.recordInvalidLotSize('LIVE', -1)).resolves.toBeUndefined();
  });
});
