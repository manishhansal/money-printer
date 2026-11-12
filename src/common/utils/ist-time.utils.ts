/**
 * ist-time.utils.ts
 *
 * IST (India Standard Time, UTC+5:30) time utilities.
 *
 * All "day boundary" calculations in MoneyPrinter must use IST, not UTC, so
 * that queries like "today's trades" align with the Indian trading calendar
 * (09:15 IST open → 15:30 IST close).
 *
 * Using UTC midnight as a day boundary is incorrect — it falls at 05:30 IST,
 * mid-way through the morning session.
 *
 * Requirements: All controllers and services that query "today" data.
 */

/** IST offset from UTC: 5 hours 30 minutes in milliseconds. */
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1_000;

/**
 * Returns a `Date` representing 00:00:00 IST on the **current IST calendar
 * date**, expressed as a UTC timestamp.
 *
 * Example: called at 10:00 IST on 2026-11-12
 *   → returns Date("2026-11-11T18:30:00.000Z")  (IST midnight in UTC)
 *
 * Example: called at 02:00 IST on 2026-11-12 (UTC 20:30 on 2026-11-11)
 *   → still returns Date("2026-11-11T18:30:00.000Z") (same IST day)
 */
export function getISTStartOfDay(): Date {
  const now = new Date();
  // Shift to IST to find the current IST calendar date components.
  const nowIST = new Date(now.getTime() + IST_OFFSET_MS);
  const y = nowIST.getUTCFullYear();
  const mo = nowIST.getUTCMonth();
  const d = nowIST.getUTCDate();
  // Reconstruct IST midnight (00:00 IST) as UTC:
  //   IST midnight = UTC midnight – 5h30m
  return new Date(Date.UTC(y, mo, d, 0, 0, 0, 0) - IST_OFFSET_MS);
}

/**
 * Returns a human-readable IST time string from any Date.
 *
 * @param date  Defaults to now.
 * @returns     e.g. "15:32:07 IST"
 */
export function toISTString(date: Date = new Date()): string {
  return date.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

/**
 * Returns the current IST date as a YYYY-MM-DD string.
 */
export function getTodayIST(): string {
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  return nowIST.toISOString().slice(0, 10);
}
