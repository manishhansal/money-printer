/**
 * Property-based tests for TradeJournalService.calculateNetPnl
 *
 * Verifies that the integer-arithmetic implementation satisfies universal
 * financial properties across arbitrary decimal inputs, covering:
 *
 *   Property 1 — net_pnl = gross_pnl − sum(all_charges)
 *                for arbitrary financial values (positive gross P&L)
 *   Property 2 — the calculation handles negative gross_pnl
 *                (losing trades) correctly
 *   Property 3 — the calculation handles zero charges correctly
 *                (net_pnl = gross_pnl)
 *
 * A reference implementation of decimalToInt10k / int10kToDecimal2dp is
 * embedded in this file so that verification is independent of the service
 * implementation — avoiding circular logic in the assertions.
 *
 * **Validates: Requirements 13.2**
 */

import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { TradeJournalService } from './trade-journal.service';
import { CompletedTradeDto } from './dto/completed-trade.dto';

import { Signals } from '../../database/entities/signals.entity';
import { Order } from '../../database/entities/orders.entity';
import { Execution } from '../../database/entities/executions.entity';
import { Position } from '../../database/entities/positions.entity';
import { Trade } from '../../database/entities/trades.entity';
import { RiskEvents } from '../../database/entities/risk-events.entity';
import { SystemHealthEvents } from '../../database/entities/system-health-events.entity';
import { AuditLogs } from '../../database/entities/audit-logs.entity';

// ─── Reference implementations ───────────────────────────────────────────────
//
// These are intentionally re-implemented here, independent of the service
// code, so that property assertions do not rely on the code under test.

/**
 * Parse a decimal string to an integer count of 10,000ths (BigInt).
 * Handles negatives; truncates beyond 4 decimal places.
 */
function refDecimalToInt10k(value: string): bigint {
  const trimmed = value.trim();
  const isNeg = trimmed.startsWith('-');
  const abs = isNeg ? trimmed.slice(1) : trimmed;

  const dot = abs.indexOf('.');
  const intStr = dot === -1 ? abs : abs.slice(0, dot);
  const fracStr = dot === -1 ? '' : abs.slice(dot + 1);

  const frac4 = fracStr.padEnd(4, '0').slice(0, 4);
  const result = BigInt(intStr || '0') * 10_000n + BigInt(frac4);
  return isNeg ? -result : result;
}

/**
 * Convert an integer count of 10,000ths to a decimal string rounded half-up
 * to 2 decimal places.
 */
function refInt10kToDecimal2dp(value: bigint): string {
  const isNeg = value < 0n;
  const abs = isNeg ? -value : value;

  const lastTwo = abs % 100n;
  const rounded100 = lastTwo >= 50n ? abs / 100n + 1n : abs / 100n;

  const whole = rounded100 / 100n;
  const frac = rounded100 % 100n;
  const result = `${whole}.${frac.toString().padStart(2, '0')}`;
  return isNeg && result !== '0.00' ? `-${result}` : result;
}

/**
 * Compute the reference net P&L for a given set of decimal-string inputs
 * using only the reference helpers above.
 */
function refNetPnl(grossPnl: string, charges: string[]): string {
  const grossInt = refDecimalToInt10k(grossPnl);
  const totalChargesInt = charges.reduce((sum, c) => sum + refDecimalToInt10k(c), 0n);
  return refInt10kToDecimal2dp(grossInt - totalChargesInt);
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * Generates a non-negative charge string with exactly 4 decimal places.
 * Range: '0.0000' to '100000.0000' (inclusive).
 */
const chargeArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 100_000_0000 }) // 0 to 100000.0000 in 10k units
  .map((v) => {
    const whole = Math.floor(v / 10_000);
    const frac = v % 10_000;
    return `${whole}.${frac.toString().padStart(4, '0')}`;
  });

/**
 * Generates a gross_pnl string with exactly 2 decimal places.
 * Range: '-100000.00' to '100000.00' (covers typical intraday P&L).
 */
const grossPnlArb: fc.Arbitrary<string> = fc
  .integer({ min: -100_000_00, max: 100_000_00 }) // ±100000.00 in cents
  .map((v) => {
    const abs = Math.abs(v);
    const whole = Math.floor(abs / 100);
    const frac = abs % 100;
    const str = `${whole}.${frac.toString().padStart(2, '0')}`;
    return v < 0 ? `-${str}` : str;
  });

/**
 * Generates a strictly-negative gross_pnl string (losing trades).
 * Range: '-100000.00' to '-0.01'.
 */
const negativeGrossPnlArb: fc.Arbitrary<string> = fc
  .integer({ min: -100_000_00, max: -1 }) // -100000.00 to -0.01 in cents
  .map((v) => {
    const abs = Math.abs(v);
    const whole = Math.floor(abs / 100);
    const frac = abs % 100;
    return `-${whole}.${frac.toString().padStart(2, '0')}`;
  });

// ─── DTO builder ─────────────────────────────────────────────────────────────

function buildDto(overrides: Partial<CompletedTradeDto> = {}): CompletedTradeDto {
  const base: CompletedTradeDto = {
    positionId: 'pos-uuid',
    instrumentId: 'inst-uuid',
    strategyId: 'strat-uuid',
    engine: 'LIVE',
    direction: 'LONG',
    quantity: 50,
    lotSize: 50,
    entryPrice: '100.00',
    exitPrice: '110.00',
    entryTime: new Date('2024-01-15T09:30:00Z'),
    exitTime: new Date('2024-01-15T11:00:00Z'),
    mfe: '500.00',
    mae: '-50.00',
    grossPnl: '500.00',
    brokerage: '20.0000',
    stt: '2.5000',
    exchangeCharges: '1.2500',
    gst: '3.7500',
    sebiCharges: '0.1000',
    stampDuty: '0.5000',
    netPnl: '472.10',
    exitReason: 'TARGET_HIT',
    executionSlippage: '0.2500',
  };
  return { ...base, ...overrides };
}

// ─── Mock repository factory ──────────────────────────────────────────────────

function mockRepo() {
  return {
    create: jest.fn().mockImplementation((dto: object) => ({ ...dto })),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('TradeJournalService.calculateNetPnl (property-based)', () => {
  let service: TradeJournalService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TradeJournalService,
        { provide: getRepositoryToken(Signals), useValue: mockRepo() },
        { provide: getRepositoryToken(Order), useValue: mockRepo() },
        { provide: getRepositoryToken(Execution), useValue: mockRepo() },
        { provide: getRepositoryToken(Position), useValue: mockRepo() },
        { provide: getRepositoryToken(Trade), useValue: mockRepo() },
        { provide: getRepositoryToken(RiskEvents), useValue: mockRepo() },
        { provide: getRepositoryToken(SystemHealthEvents), useValue: mockRepo() },
        { provide: getRepositoryToken(AuditLogs), useValue: mockRepo() },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<TradeJournalService>(TradeJournalService);
  });

  // ─── Unit sanity check ────────────────────────────────────────────────────
  // Verifies the known fixture values from the existing service spec.

  it('computes net_pnl correctly for the known trade fixture', () => {
    // grossPnl=412.50, charges=52.10 → netPnl=360.40
    const dto = buildDto({
      grossPnl: '412.50',
      brokerage: '40.0000',
      stt: '2.5000',
      exchangeCharges: '1.5000',
      gst: '7.5000',
      sebiCharges: '0.1000',
      stampDuty: '0.5000',
    });
    expect(service.calculateNetPnl(dto)).toBe('360.40');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Property 1: net_pnl = gross_pnl − sum(charges) for arbitrary financial values
  // **Validates: Requirements 13.2**
  // ─────────────────────────────────────────────────────────────────────────────

  it('Property 1: net_pnl equals gross_pnl minus sum of all charges for arbitrary values', () => {
    fc.assert(
      fc.property(
        grossPnlArb,
        chargeArb, // brokerage
        chargeArb, // stt
        chargeArb, // exchangeCharges
        chargeArb, // gst
        chargeArb, // sebiCharges
        chargeArb, // stampDuty
        (grossPnl, brokerage, stt, exchangeCharges, gst, sebiCharges, stampDuty) => {
          const dto = buildDto({
            grossPnl,
            brokerage,
            stt,
            exchangeCharges,
            gst,
            sebiCharges,
            stampDuty,
          });

          const result = service.calculateNetPnl(dto);

          // Compute expected using the independent reference implementation
          const expected = refNetPnl(grossPnl, [
            brokerage,
            stt,
            exchangeCharges,
            gst,
            sebiCharges,
            stampDuty,
          ]);

          return result === expected;
        },
      ),
      { numRuns: 1000 },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Property 2: handles negative gross_pnl (losing trades) correctly
  // **Validates: Requirements 13.2**
  // ─────────────────────────────────────────────────────────────────────────────

  it('Property 2: handles negative gross_pnl (losing trades) correctly', () => {
    fc.assert(
      fc.property(
        negativeGrossPnlArb,
        chargeArb, // brokerage
        chargeArb, // stt
        chargeArb, // exchangeCharges
        chargeArb, // gst
        chargeArb, // sebiCharges
        chargeArb, // stampDuty
        (grossPnl, brokerage, stt, exchangeCharges, gst, sebiCharges, stampDuty) => {
          const dto = buildDto({
            grossPnl,
            brokerage,
            stt,
            exchangeCharges,
            gst,
            sebiCharges,
            stampDuty,
          });

          const result = service.calculateNetPnl(dto);

          // Verify exact match against the reference computation
          const expected = refNetPnl(grossPnl, [
            brokerage,
            stt,
            exchangeCharges,
            gst,
            sebiCharges,
            stampDuty,
          ]);

          if (result !== expected) return false;

          // Net P&L for a losing trade (negative gross) minus positive charges
          // must be ≤ gross_pnl.  Parse via reference to compare numerically.
          const netInt = refDecimalToInt10k(result);
          const grossInt = refDecimalToInt10k(grossPnl);
          return netInt <= grossInt;
        },
      ),
      { numRuns: 1000 },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Property 3: handles zero charges correctly (net_pnl = gross_pnl)
  // **Validates: Requirements 13.2**
  // ─────────────────────────────────────────────────────────────────────────────

  it('Property 3: net_pnl equals gross_pnl when all charges are zero', () => {
    fc.assert(
      fc.property(grossPnlArb, (grossPnl) => {
        const dto = buildDto({
          grossPnl,
          brokerage: '0.0000',
          stt: '0.0000',
          exchangeCharges: '0.0000',
          gst: '0.0000',
          sebiCharges: '0.0000',
          stampDuty: '0.0000',
        });

        const result = service.calculateNetPnl(dto);

        // With zero charges the result must equal the gross_pnl value.
        // grossPnl is already 2dp so no rounding is needed — strict equality.
        return result === grossPnl;
      }),
      { numRuns: 1000 },
    );
  });
});
