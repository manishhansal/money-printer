# Paper / Live Engine Parity Audit

**Date:** 2026-11-11

---

## Isolation Guarantees

| Concern | Paper | Live | Parity |
|---------|-------|------|--------|
| Database tables | paper_orders, paper_positions, paper_trades, paper_executions | orders, positions, trades, executions | ✅ Fully isolated |
| Redis key namespace | `paper:*` | `trading:*`, `orders:*` | ✅ Fully isolated |
| Redis pub/sub | `events:paper:*` | `events:*` | ✅ Fully isolated |
| Broker API calls | None — no Dhan calls | DhanApiClient | ✅ Fully isolated |

## Quantity Calculation Parity (Post-Fix)

Both paths now use the same conversion:
```
quantity_units = positionSize × instrument.lotSize
```

| Step | Paper | Live | Same Logic? |
|------|-------|------|-------------|
| Instrument lookup | ✅ (added in Phase 1) | ✅ | ✅ YES |
| lotSize validation | ✅ | ✅ | ✅ YES |
| quantity = lots × lotSize | ✅ | ✅ | ✅ YES |
| lotSize validation in service | ✅ | ✅ | ✅ YES |
| PaperTrade.lot_size | ✅ Actual (was hardcoded 1) | N/A | ✅ FIXED |

## Fill Price Realism

| Component | Paper | Live |
|-----------|-------|------|
| Fill price source | Bid/ask from Redis market snapshot | Actual Dhan fill price |
| Slippage | Configurable (fixed, %, market impact) | Actual Dhan slippage |
| Latency | Simulated (uniform/normal/log-normal) | Actual network latency |
| Rejection simulation | Configurable probability | Actual Dhan rejection |
| Partial fills | Not supported | Supported via handleFill() |

## Trading Charges

Both paper and live use `TradingChargesService.calculate()` with identical rates (Dhan NSE F&O, October 2024 basis):
- Brokerage: ₹20 flat × 2
- STT: 0.1% sell-side
- Exchange: 0.053% total
- GST: 18% on brokerage + exchange
- SEBI: ₹10/crore
- Stamp: 0.003% buy-side

## Open Issues

1. **Paper partial fills not implemented.** Paper orders fill in a single execution. Live supports multi-fill aggregation via VWAP calculation in `handleFill()`.

2. **Paper square-off** uses the standard `submitPaperOrder(SELL)` path. It does not currently use the same escalation schedule as live. No dedicated paper-specific square-off cron.

3. **Paper starting capital** is configurable via UserSettings. After reset, old paper_positions/paper_trades remain in DB. No cleanup mechanism.
