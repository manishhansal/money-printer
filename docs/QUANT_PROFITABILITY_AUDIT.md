# QUANTITATIVE PROFITABILITY AUDIT — MoneyPrinter
**Audit Date:** 2026-11-12  
**Auditor Role:** Institutional Quantitative Researcher / NSE Derivatives Specialist  
**Commit SHA:** `5d9fd24bb8df5c6b5f0b23a7672420331b6c646e`

---

## EXECUTIVE SUMMARY

**A statistically defensible positive net expectancy CANNOT be established for any strategy in MoneyPrinter.**

This conclusion is not a matter of insufficient testing time. It is a structural finding derived from code inspection and confirmed by the absence of required data and implemented logic. The reasons are stated in full below.

---

## 1. DATA AVAILABILITY ASSESSMENT

### 1.1 Required vs Available

| Data Type | Required | Available |
|---|---|---|
| Historical expired NSE options contracts | YES | **NO** |
| Historical options premium OHLCV | YES | **NO** |
| Historical bid/ask history | YES | **NO** |
| Historical OI per strike | YES | **NO** |
| Historical IV surfaces | YES | **NO** |
| Historical lot sizes per expiry | YES | **NO** |
| Underlying (NIFTY/BANKNIFTY) OHLCV | YES | Framework exists via `HistoricalCandleIngestionService`; NOT seeded |
| NSE holiday calendar | YES | **NO** |
| Expiry-specific contract specs | YES | **NO** |
| Greeks (Delta, Gamma, Theta, Vega) | DESIRABLE | **NO** |

### 1.2 Data Coverage Score

**0% — No historical options data exists in the system or in any connected data source.**

The `BacktestService.runBacktest()` accepts a caller-provided `BacktestTrade[]` array. There is no pipeline that could populate this array from real historical trades. The `HistoricalCandleIngestionService` can fetch underlying candle data from the Dhan API, but:

1. It is not automatically invoked.
2. It covers underlying OHLCV only — not options premium data.
3. Dhan API does not provide expired options historical data (options chains are only available for current/near expiries).

### 1.3 Consequence

> **Any backtest result would be entirely synthetic. It would have no connection to actual historical market conditions and cannot be used to establish or deny profitability.**

---

## 2. SIGNAL GENERATION ASSESSMENT

### 2.1 Strategy Entry Logic Status

All 8 strategies (A–H) are defined as database configuration rows. They specify:
- Compatible market regimes
- Minimum R:R ratios
- Concurrency limits
- Opening phase eligibility

**None of the 8 strategies have distinct entry condition implementations in code.**

The `signal-scanner.service.ts` builds every signal candidate with `entryConditionsMet: true`. The scanner does NOT implement:

| Strategy | Required Entry Logic | Implemented |
|---|---|---|
| A — Opening Range Breakout | ORB range calculation, breakout detection | ❌ |
| B — VWAP Reclaim and Rejection | VWAP level, reclaim confirmation | ❌ |
| C — Momentum Expansion | Momentum measurement, expansion filter | ❌ |
| D — Breakout and Retest | Level identification, retest confirmation | ❌ |
| E — Trend Continuation | Trend direction, pullback entry | ❌ |
| F — Liquidity Sweep and Reversal | Sweep detection, reversal confirmation | ❌ |
| G — Fair Value Gap and Market Structure | FVG identification, structure analysis | ❌ |
| H — Options Flow Intelligence | OI analysis, flow detection | ❌ |

The `TechnicalAnalysisService` correctly implements VWAP, ATR, RSI, EMA, support/resistance, MACD, ORB, relative volume. However, it is never called from the signal scanner.

### 2.2 Signal Scoring Quality

Component scores are computed in `computeComponentScores()` using trivial heuristics:

| Component | Actual Computation | Expected |
|---|---|---|
| `regimeAlignment` | Static lookup from regime code (4–15) | Based on regime strength and direction alignment |
| `priceStructure` | 12 if bid+ask present, else 10 | Support/resistance proximity, structure analysis |
| `volumeConfirmation` | 13 if volume>100, 10 if >0, else 7 | Relative volume vs 20-day average |
| `momentum` | **Always 8** (hardcoded) | RSI, MACD, rate of change |
| `vwapTrendAlignment` | **Always 8** (hardcoded) | VWAP deviation, trend direction |
| `optionsFuturesConfirmation` | Spread percentage | OI analysis, PCR, futures basis |
| `liquidityExecution` | Spread percentage | Bid/ask depth, historical fill quality |
| `rrQuality` | R:R ≥ 2.0 → 10, ≥ 1.5 → 8, else 5 | Correct |

**Result:** Every eligible instrument in a moderate regime with bid/ask quotes will score approximately 73–82 points. The 80-point threshold is effectively gamed by default in liquid conditions. The score has no genuine predictive content.

### 2.3 Direction Logic

The scanner always sets `direction: 'BUY'`. The comment reads:
```
// Paper engine is options-buying only — always use BUY to prevent
// the paper engine's short-selling guard from rejecting the order.
```

This means:
- PUT option entries (which require a bearish direction signal) are not differentiated from CALL entries
- In a STRONG_BEAR regime, the system still sends BUY signals
- The instrument selected (CE or PE) would need to encode the directional bet, but this is not done at the scanner level

---

## 3. STRATEGY-BY-STRATEGY PROFITABILITY ANALYSIS

### 3.1 Classification Framework

Before reviewing results: acceptance criteria for `PROFITABLE_OOS_EVIDENCE` requires all of:
1. Trustworthy historical data ❌
2. Point-in-time correct backtest ❌
3. Realistic transaction costs ✅ (cost model is correct)
4. Adequate OOS sample ❌
5. Positive net expectancy ❌ (cannot be established)
6. Uncertainty analysis supports result ❌
7. Stability across subperiods ❌
8. Not driven by one or two outlier trades ❌
9. Acceptable drawdown and tail risk ❌
10. Survives slippage sensitivity ❌

### 3.2 Per-Strategy Results

| Strategy | Sample Size | Data Coverage | Gross Expectancy | Net Expectancy | Win Rate | Profit Factor | Max DD | Sharpe | OOS Result | Classification |
|---|---|---|---|---|---|---|---|---|---|---|
| A — Opening Range Breakout | N/A | 0% | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | NOT AVAILABLE | **UNVERIFIED_DATA** |
| B — VWAP Reclaim and Rejection | N/A | 0% | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | NOT AVAILABLE | **UNVERIFIED_DATA** |
| C — Momentum Expansion | N/A | 0% | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | NOT AVAILABLE | **UNVERIFIED_DATA** |
| D — Breakout and Retest | N/A | 0% | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | NOT AVAILABLE | **UNVERIFIED_DATA** |
| E — Trend Continuation | N/A | 0% | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | NOT AVAILABLE | **UNVERIFIED_DATA** |
| F — Liquidity Sweep and Reversal | N/A | 0% | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | NOT AVAILABLE | **UNVERIFIED_DATA** |
| G — FVG and Market Structure | N/A | 0% | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | NOT AVAILABLE | **UNVERIFIED_DATA** |
| H — Options Flow Intelligence | N/A | 0% | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | CANNOT COMPUTE | NOT AVAILABLE | **UNVERIFIED_DATA** |

**All 8 strategies are classified: UNVERIFIED_DATA**

This is not a negative profitability finding. It is a finding that **profitability cannot be established or denied** with the evidence available.

---

## 4. TRANSACTION COST MODEL VERIFICATION

The `TradingChargesService` is correctly implemented and consistent across paper trading and backtesting.

| Component | Implemented Rate | Correct Rate | Status |
|---|---|---|---|
| Brokerage | ₹20/order × 2 = ₹40 round-trip | ₹40 (Dhan flat rate) | ✅ |
| STT | 0.1% of sell-side turnover | 0.1% (Budget 2024, effective Oct 2024) | ✅ |
| Exchange charges | 0.053% of total turnover | 0.053% (NSE F&O, post-Oct 2023) | ✅ |
| GST | 18% of (brokerage + exchange) | 18% | ✅ |
| SEBI charges | ₹10/crore | ₹10/crore | ✅ |
| Stamp duty | 0.003% of buy-side turnover | 0.003% | ✅ |

The cost model is one of the genuinely well-implemented components of the system. The `PaperTradingService` uses the same `TradingChargesService` as the backtest engine, ensuring cost-model parity.

### Cost Impact Illustration

For a typical option trade: 1 lot NIFTY (50 units) at ₹100 premium, exit at ₹110:
- Gross P&L: (110 − 100) × 50 = **₹500**
- Brokerage: ₹40
- STT: 110 × 50 × 0.001 = ₹5.50
- Exchange: (100 + 110) × 50 × 0.00053 = ₹5.565
- GST: (40 + 5.565) × 0.18 = ₹8.20
- SEBI: (100 + 110) × 50 × 0.000001 = ₹0.011
- Stamp duty: 100 × 50 × 0.00003 = ₹0.15
- **Total costs: ~₹59.43**
- **Net P&L: ₹440.57 (88.1% of gross)**

A losing trade exiting at ₹92 (₹8 loss):
- Gross P&L: (92 − 100) × 50 = **−₹400**
- Costs: ~₹56.90
- **Net P&L: −₹456.90**

This creates asymmetry: wins are reduced by ~12%, losses are amplified by ~14%. Break-even gross P&L is not ₹0 — it is approximately +₹60.

**Minimum gross P&L required to break even:** ~₹60 per trade.
**At 1 lot NIFTY (₹100 premium), minimum winning move required:** >₹1.20 (1.2%)

---

## 5. PAPER TRADING EXECUTION QUALITY ASSESSMENT

The paper trading engine implementation is mechanically sound:

| Aspect | Assessment |
|---|---|
| Fill model | BUY at ask, SELL at bid — conservative and realistic |
| Slippage models | Fixed rupee, percentage, market impact, log-normal — well-designed |
| Latency simulation | Normal/uniform/log-normal distributions, configurable — good |
| Default slippage | ₹0.50 fixed (from dispatcher) — plausible for liquid options |
| Rejection simulation | Configurable probability — present |
| Cost calculation | Correct (see section 4) |
| Idempotency | Redis-based, 5-minute TTL — correct |
| Paper/live separation | Verified correct — separate Redis keys, separate DB tables |

**The paper trading engine would produce realistic simulation results IF it received properly scored and filtered signals.** Since signal scoring is heuristic (DEFECT-003) and entry conditions are not implemented (DEFECT-002), the paper trading results also lack economic validity.

---

## 6. BACKTEST FRAMEWORK ASSESSMENT

The `BacktestService` is correctly implemented as a framework:

| Feature | Status |
|---|---|
| Chronological split | ✅ Implemented and tested |
| No-look-ahead guarantee | ✅ Verified by test |
| Survivorship bias prevention | ✅ Delisted trades included |
| inSampleRatio validation [0.5, 0.9] | ✅ Throws on violation |
| Bootstrap CI (1000 iterations) | ✅ Implemented and tested |
| Ablation analysis | ✅ Implemented |
| Walk-forward | ⚠️ Single split only (not rolling windows) |
| Monte Carlo (trade sequence) | NOT_IMPLEMENTED — only bootstrap CI |
| Multi-strategy comparison | NOT_IMPLEMENTED |

The framework is usable if real historical trades are provided. Without real data, it is an empty shell.

---

## 7. RISK ANALYSIS

Since no trading history exists, risk metrics cannot be computed from actual trades. We can compute theoretical risk per trade:

| Metric | Value (1 lot, 1.5% SL) |
|---|---|
| Max loss per trade (gross) | 1.5% × LTP × lotSize |
| Max loss per trade at LTP=100, lot=50 | 1.5% × 100 × 50 = ₹75 |
| Total cost-adjusted max loss | ₹75 + ~₹57 = ₹132 |
| Default capital (paper) | ₹100,000 |
| Risk per trade at 1% capital risk | ₹1,000 |
| Lots achievable | floor(1000 / 75) = 13 lots |
| Required minimum capital for 1 lot without risk of 0 lots | ~₹13,200 |

**Daily loss limit (default 10,000):** This triggers EMERGENCY_HALT. At ₹132 max loss per trade, this allows approximately 75 consecutive full-stop-loss trades before the daily limit is hit. That is a reasonable buffer.

**Two-loss lockout:** After 2 net losing trades of any size (even ₹1), new entries are blocked for the session. This is an aggressive conservative setting.

---

## 8. CONCLUSIONS

1. **Profitability CANNOT be established or denied** — no data
2. **All 8 strategies are classified UNVERIFIED_DATA**
3. **Signal scoring has no genuine predictive content** — DEFECT-003
4. **Strategy entry logic is not implemented** — DEFECT-002
5. **The backtest framework is structurally sound** but unused
6. **The cost model is correct** — a genuine strength
7. **Paper trading mechanics are sound** — another genuine strength
8. **Risk controls (daily loss, position sizing) are well-implemented** — a genuine strength
9. **Live trading pipeline is broken** — DEFECT-001

The system has the structural components to eventually support a genuine quantitative evaluation, but this evaluation **cannot be performed today** because the prerequisite work (strategy entry logic, real indicator integration, historical data acquisition) is not complete.
