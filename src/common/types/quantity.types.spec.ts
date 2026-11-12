/**
 * quantity.types.spec.ts
 *
 * Tests for branded TypeScript types — Lots and QuantityUnits.
 * Verifies that the quantity conversion functions enforce the
 * lot-size invariant at runtime.
 *
 * Requirements: Section 3.3 — Branded types
 */

import { Lots, QuantityUnits, toLotUnits, fromLotUnits, asQuantityUnits } from './quantity.types';

describe('Branded quantity types', () => {
  // ── toLotUnits ────────────────────────────────────────────────────────────

  describe('toLotUnits(lots, lotSize)', () => {
    it('P0: 1 lot × 75 (NIFTY) = 75 units', () => {
      const units = toLotUnits(1 as Lots, 75);
      expect(units).toBe(75);
    });

    it('P0: 2 lots × 75 = 150 units', () => {
      const units = toLotUnits(2 as Lots, 75);
      expect(units).toBe(150);
    });

    it('P0: 3 lots × 25 (FINNIFTY) = 75 units', () => {
      const units = toLotUnits(3 as Lots, 25);
      expect(units).toBe(75);
    });

    it('P0: result × lotSize === 0 (invariant)', () => {
      const lots = [1, 2, 5, 10];
      const lotSizes = [25, 50, 75, 100];
      for (const l of lots) {
        for (const ls of lotSizes) {
          const units = toLotUnits(l as Lots, ls);
          expect(units % ls).toBe(0);
        }
      }
    });

    it('P0: rejects zero lots', () => {
      expect(() => toLotUnits(0 as Lots, 75)).toThrow('Invalid lots');
    });

    it('P0: rejects negative lots', () => {
      expect(() => toLotUnits(-1 as Lots, 75)).toThrow('Invalid lots');
    });

    it('P0: rejects zero lotSize', () => {
      expect(() => toLotUnits(1 as Lots, 0)).toThrow('Invalid lotSize');
    });

    it('P0: rejects fractional lots', () => {
      expect(() => toLotUnits(1.5 as Lots, 75)).toThrow('Invalid lots');
    });
  });

  // ── fromLotUnits ──────────────────────────────────────────────────────────

  describe('fromLotUnits(units, lotSize)', () => {
    it('converts 75 units with lotSize=75 to 1 lot', () => {
      const lots = fromLotUnits(75 as QuantityUnits, 75);
      expect(lots).toBe(1);
    });

    it('converts 150 units with lotSize=75 to 2 lots', () => {
      const lots = fromLotUnits(150 as QuantityUnits, 75);
      expect(lots).toBe(2);
    });

    it('P0: rejects units not divisible by lotSize', () => {
      expect(() => fromLotUnits(1 as QuantityUnits, 75)).toThrow('not divisible');
    });
  });

  // ── asQuantityUnits ───────────────────────────────────────────────────────

  describe('asQuantityUnits(units, lotSize)', () => {
    it('P0: accepts 75 units with lotSize=75', () => {
      const units = asQuantityUnits(75, 75);
      expect(units).toBe(75);
    });

    it('P0: rejects 1 unit with lotSize=75 (classic lots-as-units bug)', () => {
      expect(() => asQuantityUnits(1, 75)).toThrow('Invariant violation');
    });

    it('P0: rejects zero units', () => {
      expect(() => asQuantityUnits(0, 75)).toThrow('Invalid units');
    });

    it('P0: rejects negative units', () => {
      expect(() => asQuantityUnits(-75, 75)).toThrow('Invalid units');
    });

    it('accepts any positive integer when lotSize=0 (no enforcement)', () => {
      // lotSize=0 means "no enforcement" (INDEX instruments without lot size)
      const units = asQuantityUnits(42, 0);
      expect(units).toBe(42);
    });
  });

  // ── Round-trip invariant ──────────────────────────────────────────────────

  describe('Round-trip invariant: toLotUnits(fromLotUnits(units, ls), ls) === units', () => {
    it.each([
      [75, 75],
      [150, 75],
      [75, 25],
      [100, 50],
      [200, 100],
    ])('%i units with lotSize=%i round-trips correctly', (units, lotSize) => {
      const lots = fromLotUnits(units as QuantityUnits, lotSize);
      const roundTrip = toLotUnits(lots, lotSize);
      expect(roundTrip).toBe(units);
    });
  });
});
