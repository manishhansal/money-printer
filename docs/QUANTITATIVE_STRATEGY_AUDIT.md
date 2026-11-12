# Quantitative Strategy Audit

**Date:** 2026-11-11

---

## Strategy Catalogue

| Code | Name | Regimes | Min R:R | Opening | Max Concurrent |
|------|------|---------|---------|---------|----------------|
| A | Opening Range Breakout | BREAKOUT, STRONG_BULL, STRONG_BEAR | 1.5 | ✅ | 3 |
| B | VWAP Reclaim and Rejection | WEAK_BULL, WEAK_BEAR, REVERSAL | 1.5 | ❌ | 3 |
| C | Momentum Expansion | STRONG_BULL, STRONG_BEAR, BREAKOUT | 2.0 | ❌ | 2 |
| D | Breakout and Retest | BREAKOUT, STRONG_BULL, STRONG_BEAR | 2.0 | ❌ | 2 |
| E | Trend Continuation | STRONG_BULL, WEAK_BULL, STRONG_BEAR, WEAK_BEAR | 1.5 | ❌ | 3 |
| F | Liquidity Sweep and Reversal | REVERSAL, UNSTABLE | 2.0 | ❌ | 2 |
| G | Fair Value Gap and Market Structure | STRONG_BULL, STRONG_BEAR, WEAK_BULL, WEAK_BEAR | 2.0 | ❌ | 2 |
| H | Options Flow Intelligence | STRONG_BULL, STRONG_BEAR, BREAKOUT, HIGH_VOL | 1.5 | ❌ | 3 |

## Signal Scoring Components

| Component | Weight | Source |
|-----------|--------|--------|
| Regime alignment | Included | MarketRegimeService |
| Price structure | Included | TechnicalAnalysisService |
| Volume confirmation | Included | Market data |
| Momentum | Included | TechnicalAnalysisService |
| VWAP/trend | Included | TechnicalAnalysisService |
| Options/futures | Included | OptionsIntelligenceService |
| Liquidity/execution | Included | InstrumentDiscoveryService |
| R:R quality | Included | StrategyService.computeRrRatio() |

**Composite threshold:** ≥ 80 to pass.

## Adaptive Strategy Engine

- **Auto-suspension:** A strategy is suspended when its out-of-sample win rate over the last 20 trading sessions falls below `minPerformanceThreshold`.
- **Re-enable:** Manual only via `StrategyService.reenableStrategy()`.
- **Win rate computation:** Trailing 20 `StrategyPerformance` records per strategy × regime.

## Position Sizing Formula (BigInt precision)

```
risk_amount = Dynamic_Capital × riskPercentage / 100
per_unit_risk = |entry_price − stop_price| × lot_size
selected_lots = FLOOR(risk_amount / per_unit_risk)
quantity_units = selected_lots × lot_size
```

## Validation Gaps

1. **No out-of-sample backtesting framework.** Only forward paper trading. No historical simulation with expired option data.

2. **No walk-forward validation.** Strategy performance metrics exist in `strategy_performance` table but no automated walk-forward engine.

3. **Strategy H (Options Flow Intelligence) is signal-label only.** The options flow data processing exists but the specific entry logic for H is not independently validated.

4. **Regime classification not independently validated.** `MarketRegimeService` classifications drive all strategy routing. If regimes are misclassified, all strategies would be affected.
