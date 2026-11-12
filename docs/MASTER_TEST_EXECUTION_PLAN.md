# MASTER TEST EXECUTION PLAN — MoneyPrinter
**Audit Session Date:** 2026-11-12  
**Auditor Role:** Independent Principal QA Architect / Trading Systems Auditor  
**Repository Commit:** `5d9fd24bb8df5c6b5f0b23a7672420331b6c646e`  
**Branch:** `feat/money-printer` (tracking `origin/main`)  
**TypeScript:** Clean (0 errors)  
**Test Baseline:** 59 suites · 1535 tests · 1535 passed · 0 failed

---

## 1. GIT INTEGRITY BASELINE

```
Commit SHA:   5d9fd24bb8df5c6b5f0b23a7672420331b6c646e
Branch:       feat/money-printer (points to same commit as origin/main)
Git status:   clean — no modified, staged, or untracked files
Modifications to source: NONE (testing engagement only)
```

> **Note**: Local branch is `feat/money-printer`, not `main`. Both branches point to the same HEAD commit via the GitHub merge (PR #7).

---

## 2. REPOSITORY INVENTORY

### Backend modules (src/modules/)
| Module | Source Files | Spec Files |
|---|---|---|
| agents | 6 | 0 |
| analytics | 7 | 5 |
| auth | 5 | 1 |
| backtest | 3 | 1 |
| charges | 2 | 0 |
| compliance | 2 | 1 |
| dhan | 6 | 2 |
| event-wiring | 3 | 3 |
| execution | 4 | 1 |
| instrument-discovery | 4 | 3 |
| live-trading | 3 | 1 |
| market-data | 5 | 2 |
| market-regime | 3 | 1 |
| notification | 3 | 1 |
| options-flow | 3 | 1 |
| options-intelligence | 7 | 6 |
| paper-trading | 4 | 1 |
| portfolio | 2 | 1 |
| position-monitoring | 5 | 2 |
| reconciliation | 3 | 1 |
| redis | 2 | 1 |
| risk-management | 7 | 4 |
| secrets | 2 | 1 |
| session-manager | 2 | 1 |
| signal-scanner | 5 | 1 |
| signal-scoring | 5 | 2 |
| strategy | 3 | 1 |
| system-health-monitor | 2 | 1 |
| technical-analysis | 2 | 1 |
| trade-journal | 12 | 3 |
| trailing-stop | 6 | 3 |
| watchdog | 2 | 1 |
| **TOTAL** | **174** | **59** |

### Database entities: 30  
### Migrations: 4  
### Strategies: 8 (A–H)  
### Source lines inspected: ~12,000

### Critical services WITHOUT spec files
| Service | Lines | Risk Level |
|---|---|---|
| `agent-orchestrator.service.ts` | 1141 | P1 |
| `signal-scanner.service.ts` | ~400 | P1 |
| `signal-dispatcher.service.ts` | ~300 | P1 |
| `decision-memory.service.ts` | ~249 | P1 |
| `llm-client.service.ts` | 298 | P1 |
| `historical-candle-ingestion.service.ts` | 226 | P2 |
| `instrument-master.service.ts` | 366 | P2 |
| `dhan-order-update.client.ts` | 292 | P2 |
| `order-status-poller.service.ts` | 203 | P2 |
| `trading-charges.service.ts` | 106 | P3 |

---

## 3. DEPENDENCY AVAILABILITY

| Dependency | Status | Impact |
|---|---|---|
| PostgreSQL | NOT RUNNING (docker-compose) | Integration tests BLOCKED |
| Redis | NOT RUNNING | Integration tests BLOCKED |
| Dhan API credentials | Not present in `.env` | Live API tests BLOCKED |
| Dhan WebSocket | NOT CONNECTED | Real-time tests BLOCKED |
| Historical options data | NOT PRESENT | Quantitative backtesting BLOCKED |
| NSE instrument master | NOT SEEDED | Scanner tests BLOCKED |
| LLM provider | `disabled` (config) | Agent tests run rule-based only |
| Frontend | Static files present | UI tests limited |
| Chrome extension | Built | Extension tests run offline |

> All testing in this engagement is conducted offline against mocked dependencies (unit tests). Integration and E2E tests that require live services are classified as BLOCKED.

---

## 4. TEST EXECUTION STAGES

### Stage 1 — Static Analysis
- TypeScript: `npx tsc --noEmit` → **0 errors**
- Lint: ESLint configured, not run in this engagement
- Dependencies: All pinned to fixed/caret versions; no anomalies

### Stage 2 — Unit Testing
- Command: `npx jest --no-coverage --runInBand --passWithNoTests --forceExit`
- Result: **1535 / 1535 passed**
- Duration: ~11 seconds
- 59 test suites

### Stage 3 — Contract Testing
- Database: BLOCKED (PostgreSQL not running)
- Redis: BLOCKED
- Dhan API: BLOCKED (no live credentials)
- Paper-trading contract: COVERED by unit tests with mocks

### Stage 4 — Integration Testing
- BLOCKED: No integration test suite present (`test/jest-e2e.json` referenced but no e2e test files found)

### Stage 5 — End-to-End Trading Scenarios
- BLOCKED: Requires live services

### Stage 6 — Failure Injection
- Covered partially in unit tests (mocked DB failures, Redis unavailability)
- Not covered: live failure injection scenarios

### Stage 7 — Quantitative Research
- BLOCKED: No historical expired-options data exists in the repository or any configured data source

### Stage 8 — Paper-Trading Validation
- BLOCKED: Requires running services

### Stage 9 — Reliability and Performance
- NOT TESTED: No load testing tools configured

---

## 5. TEST CASE REGISTRY (ABBREVIATED)

Each test case below maps to the full execution evidence in MASTER_TEST_RESULTS.md.

### 5.1 Pre-Trade Validation Chain (TC-EXEC-001 through TC-EXEC-010)
All 10 pre-trade guard tests covered in `execution.service.spec.ts`.

### 5.2 Risk Engine Gates (TC-RISK-001 through TC-RISK-012)
All 8 gate evaluations covered in `risk-management.service.spec.ts`.

### 5.3 Daily Loss State Machine (TC-DLSM-001 through TC-DLSM-038)
39 tests covering TWO_LOSS_LOCKOUT, EMERGENCY_HALT, KILL_SWITCH transitions.

### 5.4 Paper Trading (TC-PAPER-001 through TC-PAPER-080)
~80 tests covering fill mechanics, slippage models, cost calculations, paper/live separation.

### 5.5 Position Sizing Arithmetic (TC-POS-001 through TC-POS-010)
BigInt precision, lot-size multiplication, floor rounding.

### 5.6 Signal Scoring (TC-SIG-001 through TC-SIG-020)
Score computation, R:R enforcement, threshold gating.

### 5.7 Reconciliation (TC-REC-001 through TC-REC-010)
EOD reconciliation, reconnection reconciliation, halt-on-discrepancy.

### 5.8 Backtest Framework (TC-BT-001 through TC-BT-012)
Walk-forward split, bootstrap CI, survivorship-bias prevention.

### 5.9 Market Regime Classification (TC-REG-001 through TC-REG-025)
VIX override, all 10 regime branches, property-based invariants.

### 5.10 Strategy Gate Evaluation (TC-STR-001 through TC-STR-020)
All 5 gates, regime compatibility, R:R gating, event emission.

---

## 6. TEST COVERAGE GAPS

The following critical scenarios have NO test coverage:

| Gap ID | Description | Severity |
|---|---|---|
| GAP-001 | `signal-scanner.service.ts` scan loop — engine hardcoding, entry condition logic | P1 |
| GAP-002 | `signal-dispatcher.service.ts` routing logic — paper vs live dispatch | P1 |
| GAP-003 | `agent-orchestrator.service.ts` — full 6-phase workflow, 1141 lines | P1 |
| GAP-004 | `decision-memory.service.ts` — record, settle, reflect | P1 |
| GAP-005 | `llm-client.service.ts` — LLM calls, timeout, fallback | P1 |
| GAP-006 | `historical-candle-ingestion.service.ts` — data ingestion integrity | P2 |
| GAP-007 | `instrument-master.service.ts` — instrument refresh, duplicate handling | P2 |
| GAP-008 | `dhan-order-update.client.ts` — WebSocket order updates | P2 |
| GAP-009 | `order-status-poller.service.ts` — polling fallback | P2 |
| GAP-010 | End-to-end trade lifecycle (Scenario A through O) | P1 |
| GAP-011 | Historical options data validation | P0 |
| GAP-012 | OOS strategy profitability | P0 |
| GAP-013 | Live trading pipeline integration | P0 |
| GAP-014 | Mandatory square-off with real broker | P0 |
| GAP-015 | Crash recovery and restart reconciliation | P1 |
