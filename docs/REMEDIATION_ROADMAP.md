# Remediation Roadmap — MoneyPrinter

**Date:** 2026-11-11  
**Last updated:** Phase 1 complete

---

## Phase 0 — Forensic Audit ✅ COMPLETE

Deliverables:
- [x] FORENSIC_CODEBASE_AUDIT.md
- [x] ROOT_CAUSE_ANALYSIS.md
- [x] LOT_SIZE_AND_QUANTITY_AUDIT.md
- [x] REMEDIATION_ROADMAP.md

---

## Phase 1 — Lot-Size and Execution Ordering ✅ COMPLETE

**All P0-CRIT defects remediated. Test count: 1,451 (1,442 original + 9 new).**

### Completed fixes

| ID | File | Change | Tests |
|----|------|--------|-------|
| P0-CRIT-001 | `signal-dispatcher.service.ts` | Both paths: `positionSize × lotSize` before dispatch | 9 new P0 tests |
| P0-CRIT-001 | `execution.service.ts` | Quantity validation: `units % lotSize === 0` | Updated 41 → 50 tests |
| P0-CRIT-001 | `execution.types.ts` | Clarified quantity = UNITS; added `selectedLots` | — |
| P0-CRIT-001 | `paper-trading.types.ts` | Added `lotSize`, `selectedLots` to `PaperOrderRequest` | — |
| P0-CRIT-001 | `paper-trading.service.ts` | Replaced both `lot_size: 1` hardcodings; added lot-size validation | 75 tests pass |
| P0-CRIT-002 | `execution.service.ts` | DB first (pending) → Redis → Broker → DB update (submitted) | Updated tests |
| P0-CRIT-003 | `seed_instruments.py` | Reject missing lot_size; print warning and skip | — |
| P0-CRIT-003 | `seed_index_options.py` | Reject missing lot_size; print warning and skip | — |
| P0-CRIT-004 | `seed_instruments.py` | Full UPSERT updating lot_size/tick_size on conflict | — |
| P0-CRIT-004 | `seed_index_options.py` | Full UPSERT updating lot_size/tick_size on conflict | — |
| P1-HIGH-002 | `extension/src/popup/popup.ts` | Removed hardcoded localhost:3002; dynamic `getApiBaseUrl()` | 14 tests pass |

---

## Phase 2 — Dhan API Integration Audit (NEXT)

Planned:
- [ ] Create `DHAN_API_ENDPOINT_MATRIX.md`
- [ ] Audit all existing Dhan HTTP + WebSocket integrations against v2 docs
- [ ] Implement `GET /orders/external/{correlation-id}` for crash recovery
- [ ] Implement `POST /margincalculator` for accurate pre-trade margin checks
- [ ] Review order update WebSocket and postback integration
- [ ] Implement missing APIs: order-by-correlation-ID, historical candles for research
- [ ] Rate-limit manager for option-chain polling (3-second unique-request limit)

---

## Phase 3 — Order Execution Hardening

Planned:
- [ ] Add freeze-quantity check before broker submission
- [ ] Implement partial fill tracking for square-off exit quantities
- [ ] Add reconciliation: on startup, query Dhan for all pending DB orders and update status
- [ ] Fix `dynamicCapital` hardcoded in dispatcher (use actual capital from DB/Redis)
- [ ] Fix `currentTotalExposure` hardcoded at 0 in dispatcher (query actual positions)

---

## Phase 4 — Square-Off Reliability

Planned:
- [ ] Add AFTERNOON_LATE phase (14:30–15:00) allowing entries
- [ ] Move CLOSING phase to 15:00 IST to match directive
- [ ] Add 15:00 IST entry-restriction cron (warning, no new strategies)
- [ ] Add 15:10 IST final-entry-cutoff cron (block all new entries)
- [ ] Enhance 15:15 mandatory square-off: reconcile with Dhan positions before submission
- [ ] Add 15:20 IST escalation check
- [ ] Add 15:25 IST flat-position verification
- [ ] Add 15:28 IST critical alert for any remaining open positions
- [ ] Paper square-off using realistic bid/ask execution (not LTP)

---

## Phase 5 — Risk Management Validation

Planned:
- [ ] Wire actual capital balance from capital_ledgers into dispatcher
- [ ] Wire actual position exposure into risk gate inputs
- [ ] Validate daily loss state machine against actual trade P&L
- [ ] Add two-losing-trade lockout regression tests
- [ ] Validate correlated exposure gates with real position data

---

## Phase 6 — Sniper and Scalping Intelligence

Planned:
- [ ] Implement SniperEntryEngine with multi-condition scoring
- [ ] VWAP reclaim/rejection detector
- [ ] Relative volume scorer
- [ ] Momentum acceleration detector
- [ ] Options chain flow integration for entry confirmation

---

## Phase 7 — Target and Runner Engine

Planned:
- [ ] TargetAndRunnerManager: Target 1 evaluation
- [ ] Runner mode: continuation condition checklist
- [ ] Partial exit with whole-lot awareness
- [ ] Intelligent trailing stop (ATR, Chandelier, swing structure)
- [ ] Dhan Super Order integration for SL

---

## Phase 8 — React Quantitative Dashboard

Planned:
- [ ] Migrate extension dashboard from imperative DOM → React components
- [ ] Implement all 13 navigation panels
- [ ] Real-time WebSocket state management
- [ ] Separate paper/live data panels
- [ ] Position display: lots AND units
- [ ] Square-off countdown timer

---

## Phase 9 — Quantitative Validation

Planned:
- [ ] Expired options data for backtesting
- [ ] Walk-forward testing harness
- [ ] Monte Carlo simulation
- [ ] Strategy ablation analysis

---

## Phase 10 — Production Hardening

Planned:
- [ ] Security review: access token storage, static IP, SEBI retail-algo compliance
- [ ] Performance: p50/p95/p99 latency measurement
- [ ] Circuit breakers and retry policies
- [ ] Graceful shutdown and process recovery

---

## Open Issues Tracker

| ID | Severity | Description | Phase |
|----|----------|-------------|-------|
| P2-MED-001 | Medium | `dynamicCapital` hardcoded as `'100000.00'` in dispatcher | 3 |
| P2-MED-002 | Medium | `currentTotalExposure` hardcoded as `'0.00'` in dispatcher | 3 |
| P2-MED-003 | Medium | Mandatory square-off does not check freeze quantity | 4 |
| P2-MED-004 | Medium | No reconciliation on startup for pending orders | 3 |
| P1-HIGH-001 | High | CLOSING phase at 14:30 blocks entries too early | 4 |
| P1-HIGH-003 | High | Dashboard uses imperative DOM, not React | 8 |
