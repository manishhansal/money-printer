/**
 * quantity.types.ts
 *
 * Branded TypeScript types that make the Lots / QuantityUnits distinction
 * explicit at compile time, preventing the class of bugs where lot counts are
 * accidentally passed where unit counts are expected.
 *
 * Usage:
 *   const lots: Lots = 2 as Lots;
 *   const units: QuantityUnits = toLotUnits(lots, 75); // 150
 *
 * Requirements: Section 3.3 — Separate lot and quantity types
 */

/** A count of derivative contract lots (1 lot = lotSize units). */
export type Lots = number & { readonly __brand: 'Lots' };

/** A count of actual contract units (always equals selectedLots × lotSize). */
export type QuantityUnits = number & { readonly __brand: 'QuantityUnits' };

/**
 * Convert a lot count + lotSize to QuantityUnits.
 *
 * @throws when lots or lotSize are non-positive or non-integer.
 *
 * @example
 *   toLotUnits(2 as Lots, 75) // → 150 as QuantityUnits
 */
export function toLotUnits(lots: Lots, lotSize: number): QuantityUnits {
  if (!Number.isInteger(lots) || lots <= 0) {
    throw new Error(`Invalid lots: ${lots} — must be a positive integer`);
  }
  if (!Number.isInteger(lotSize) || lotSize <= 0) {
    throw new Error(`Invalid lotSize: ${lotSize} — must be a positive integer`);
  }
  const units = lots * lotSize;
  if (units % lotSize !== 0) {
    throw new Error(`Invariant violation: ${units} % ${lotSize} !== 0`);
  }
  return units as QuantityUnits;
}

/**
 * Convert QuantityUnits back to Lots (requires exact divisibility).
 *
 * @throws when units is not divisible by lotSize.
 */
export function fromLotUnits(units: QuantityUnits, lotSize: number): Lots {
  if (units % lotSize !== 0) {
    throw new Error(
      `QuantityUnits ${units} is not divisible by lotSize ${lotSize} — not a whole lot count`,
    );
  }
  return (units / lotSize) as Lots;
}

/**
 * Assert that a plain number satisfies the QuantityUnits invariant.
 * Returns it as the branded type. Throws if it fails the % check.
 *
 * Use this at order construction sites where the caller guarantees the
 * multiplication has already been done.
 */
export function asQuantityUnits(units: number, lotSize: number): QuantityUnits {
  if (!Number.isInteger(units) || units <= 0) {
    throw new Error(`Invalid units: ${units} — must be a positive integer`);
  }
  if (lotSize > 0 && units % lotSize !== 0) {
    throw new Error(`Invariant violation: ${units} % ${lotSize} !== 0`);
  }
  return units as QuantityUnits;
}
