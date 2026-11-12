# Remediation Log

**Date:** 2026-11-11  
**Repository:** money-printer  
**Total Sessions:** 3

---

## Session 1 — Phase 0 (Forensic Audit) + Phase 1 (Lot-Size)

### Defects Fixed

| ID | File | Defect | Fix |
|----|------|--------|-----|
| P0-CRIT-001 | signal-dispatcher.service.ts | positionSize (lots) sent as quantity (units) to Dhan | Multiply by instrument.lotSize before dispatch |
| P0-CRIT-001 | execution.service.ts | No quantity invariant check | Added quantityUnits % lotSize === 0 validation |
| P0-CRIT-001 | paper-trading.service.ts | lot_size:1 hardcoded in PaperTrade records | Use actual lotSize from PaperOrderRequest |
| P0-CRIT-001 | paper-trading.types.ts | No lotSize field in PaperOrderRequest | Added lotSize and selectedLots |
| P0-CRIT-002 | execution.service.ts | Broker submission before DB persistence | DB-first transactional outbox |
| P0-CRIT-003 | seed_instruments.py | Missing lot_size defaults to 1 | Reject and skip with warning |
| P0-CRIT-003 | seed_index_options.py | Missing lot_size defaults to 1 | Reject and skip with warning |
| P0-CRIT-004 | seed_instruments.py | ON CONFLICT DO NOTHING preserves stale lot_size | Full UPSERT updating lot_size |
| P0-CRIT-004 | seed_index_options.py | Partial UPSERT misses lot_size | Extended UPSERT |
| P1-HIGH-002 | extension/src/popup/popup.ts | Hardcoded http://localhost:3002 | Dynamic getApiBaseUrl() |

### Tests Added
- 9 lot-size invariant tests in execution.service.spec.ts
- 1,442 → 1,451 tests

---

## Session 2 — Phases 2–8

### Defects Fixed

| ID | File | Defect | Fix |
|----|------|--------|-----|
| P0 | execution.types.ts | quantity documented as "Lot/unit count" (ambiguous) | Clarified as UNITS; added selectedLots |
| P2-MED-001 | signal-dispatcher.service.ts | dynamicCapital hardcoded '100000.00' | PortfolioService.getDynamicCapital('LIVE') |
| P2-MED-002 | signal-dispatcher.service.ts | All risk gate inputs hardcoded zeros | Computed from open positions |
| P2-MED-003 | signal-dispatcher.service.ts | riskPercentage hardcoded '1.00' | UserSettings.defaultRiskPercentage |
| P1-HIGH-001 | session-manager.service.ts | CLOSING phase at 14:30 blocks entries too early | Added AFTERNOON_LATE (14:30-15:00); CLOSING now 15:00 |
| P0 | live-trading.service.ts | No entry cutoff / escalation crons | Added 15:10/15:20/15:25/15:28 crons |
| P0 | live-trading.service.ts | Square-off used DB qty not Dhan reconciled qty | getPositions() reconciliation before exits |

### New Services Created
- InstrumentMasterService (CSV download, rejection of invalid lot_size, full UPSERT)
- SniperEntryService (8 configurable pre-qualification filters)
- TargetAndRunnerService (post-target continuation, lot-aware partial exit)
- DhanTokenWatcherService (24h expiry alerting via event)
- OrderStatusPollerService (15s FILLED/PARTIAL/REJECTED detection)
- NseHolidayCalendarService (36 holidays FY2025-2026)

### React Dashboard
- All 13 panels implemented
- CandlestickChart (TradingView Lightweight Charts)
- MarketIntelligence panel (NIFTY/BANKNIFTY/FINNIFTY/VIX)
- Collapsible sidebar navigation

### Tests Added
- 5 session phase boundary tests (AFTERNOON_LATE)
- 3 NSE holiday tests
- 1,451 → 1,459 tests

---

## Session 3 — Phases 5–11 (Final Integration)

### Integrations Completed

| Component | Integration | Status |
|-----------|-------------|--------|
| TargetAndRunnerService | Registered in position-monitoring.module.ts | ✅ |
| SniperEntryService | Registered in signal-scanner.module.ts | ✅ |
| SniperEntryService | Integrated into SignalScannerService.isEligible() | ✅ |
| NseHolidayCalendarService | Registered in session-manager.module.ts | ✅ |
| NseHolidayCalendarService | Integrated into SessionManagerService.determinePhase() | ✅ |
| DhanTokenWatcherService | Registered in dhan-api.module.ts | ✅ |
| OrderStatusPollerModule | Created and added to app.module.ts | ✅ |
| DailyLossStateMachine.onTradeClosed() | Wired via PAPER_TRADE_CLOSED_EVENT from PaperTradingService | ✅ |
| LiveTradingService | Handles dhan.token.expired event (no circular dep) | ✅ |
| BacktestController | POST /backtest/run, GET /backtest/charges exposed | ✅ |
| main.ts | enableShutdownHooks() for graceful shutdown | ✅ |

### Defects Fixed

| ID | File | Defect | Fix |
|----|------|--------|-----|
| P0 | live-trading.service.ts | Kill-switch exit used DB qty not Dhan reconciled qty | getPositions() reconciliation (same as mandatorySquareOff) |
| P0 | execution.service.ts | No freeze quantity check | Queries Instruments.freezeQuantity before broker submission |
| P2 | signal-scanner.service.ts | isEligible() used hardcoded MIN_LTP/MAX_SPREAD_RATIO | Now delegates to SniperEntryService.evaluate() |
| P2 | dhan-api.client.ts | Missing GET /trades/{order-id} endpoint | Added getTradesByOrderId() |
| P2 | execution.module.ts | Instruments not injectable in ExecutionService | Added to TypeOrmModule.forFeature |

### Tests Added
- 19 SniperEntryService tests (all 8 filters + quality score)
- 23 TargetAndRunnerService tests (all phases, lot-awareness, greedy integration)
- 1,459 → 1,489 tests

---

## Final Test Count

| Session | Tests | Status |
|---------|-------|--------|
| Baseline | 1,442 | All pass |
| After Session 1 | 1,451 | All pass |
| After Session 2 | 1,459 | All pass |
| After Session 3 | 1,489 | All pass |

**All 1,489 tests pass. Zero regressions across all sessions.**

---

## Known Remaining Gaps (Accepted for Backlog)

| Item | Reason deferred |
|------|-----------------|
| Freeze quantity order slicing | Requires multi-order coordination logic |
| Dhan Live Order Update WebSocket | No separate order update feed in Dhan v2 MV3 protocol |
| Walk-forward validation engine | Schema exists, exposing via BacktestController; full automation deferred |
| NSE trading calendar automation | Manual update required annually |
| SEBI algo registration | Operator responsibility |
| Static IP configuration | Infrastructure concern |
| Dhan token auto-renewal | Dhan has no programmatic renewal API for retail users |
