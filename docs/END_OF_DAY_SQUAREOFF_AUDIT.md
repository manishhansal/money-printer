# End-of-Day Square-Off Audit

**Date:** 2026-11-11

---

## Square-Off Schedule (IST, Post-Remediation)

| Time (IST) | Cron | Action | Status |
|-----------|------|--------|--------|
| 09:00 | — | OPENING_VOLATILITY phase begins | ✅ |
| 09:15 | — | Broker P&L exit rule configured | ✅ |
| 14:30 | — | AFTERNOON_LATE phase — entries still allowed | ✅ FIXED |
| 15:00 | — | CLOSING phase — entries blocked | ✅ FIXED (was 14:30) |
| 15:10 | `10 15 * * 1-5` | `finalEntryCutoff()` — belt-and-suspenders | ✅ ADDED |
| 15:15 | `15 15 * * 1-5` | `mandatorySquareOff()` — reconcile + exit | ✅ IMPROVED |
| 15:20 | `20 15 * * 1-5` | `escalateSquareOff()` — CRITICAL alert if positions remain | ✅ ADDED |
| 15:25 | `25 15 * * 1-5` | `verifyFlatPositions()` — flat-position deadline | ✅ ADDED |
| 15:28 | `28 15 * * 1-5` | `criticalPositionAlert()` — MAX alert if still open | ✅ ADDED |
| 15:30 | `30 15 * * 1-5` | EOD reconciliation begins | ✅ |

## Mandatory Square-Off Improvements (15:15)

**Before:** Used only DB `position.quantity` for exit sizing. No broker reconciliation.

**After:** 
1. `dhanApiClient.getPositions()` called first to get actual Dhan net quantities.
2. If Dhan reports `netQty=0` for an instrument → position already flat, skip it.
3. If Dhan netQty differs from DB quantity → logs a WARNING, uses Dhan quantity.
4. Exit order sent with reconciled quantity.
5. 5-minute confirmation check: queries `getOrderbook()` for FILLED status.

## Escalation Policy

| Step | Time | Alert Level | Action |
|------|------|-------------|--------|
| Initial | 15:15 | LOG | Submit exit orders |
| Confirm | 15:20 | CRITICAL | Alert if any positions still open |
| Deadline | 15:25 | CRITICAL | Flat-position deadline alert |
| Final | 15:28 | MAX | Critical pre-close alert (2 mins to close) |

## Known Gaps

1. **No SEBI/NSE holiday calendar integration.** Square-off crons fire on all Mon-Fri regardless of market holidays. If NSE is closed, the crons fire but find no open positions (safe, but noisy logs).

2. **No special expiry handling.** Index option expiries happen on specific days with different close times. Currently uses standard 15:30 as the fixed close.

3. **Exit uses MARKET orders.** Preferred for liquidity but subject to slippage. No limit-with-escalation implemented.

4. **Freeze quantity not checked.** Large positions may require order slicing. Currently a single MARKET order is submitted regardless of size.
