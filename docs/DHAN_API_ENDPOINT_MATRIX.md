# Dhan API Endpoint Matrix

**Date:** 2026-11-11  
**Dhan API Version:** v2  
**Reference:** https://docs.dhanhq.co/api/v2/

| Endpoint | Method | Implemented | Method Name | Required Headers | Rate Limit | Tests |
|----------|--------|-------------|-------------|-----------------|------------|-------|
| /v2/orders | POST | ✅ | `placeOrder()` | access-token | Standard | dhan-api.client.spec.ts |
| /v2/orders/{id} | PUT | ✅ | `modifyOrder()` | access-token | Standard | ✅ |
| /v2/orders/{id} | DELETE | ✅ | `cancelOrder()` | access-token | Standard | ✅ |
| /v2/orders | GET | ✅ | `getOrderbook()` | access-token | Standard | ✅ |
| /v2/orders/{id} | GET | ✅ | `getOrderById()` | access-token | Standard | ✅ |
| /v2/orders/external/{correlId} | GET | ✅ **NEW** | `getOrderByCorrelationId()` | access-token | Standard | — |
| /v2/trades | GET | ✅ | `getTradebook()` | access-token | Standard | ✅ |
| /v2/super/orders | POST | ✅ | `placeSuperOrder()` | access-token | Standard | ✅ |
| /v2/super/orders/{id} | PUT | ✅ | `modifySuperOrder()` | access-token | Standard | ✅ |
| /v2/super/orders/{id}/{leg} | DELETE | ✅ | `cancelSuperOrder()` | access-token | Standard | ✅ |
| /v2/positions | GET | ✅ | `getPositions()` | access-token | Standard | ✅ |
| /v2/holdings | GET | ✅ | `getPortfolio()` | access-token | Standard | ✅ |
| /v2/fundlimit | GET | ✅ | `getFundLimit()` | access-token | Standard | ✅ |
| /v2/margincalculator | POST | ✅ **NEW** | `calculateMargin()` | access-token | Standard | — |
| /v2/marketfeed/ltp | POST | ✅ | `getLtp()` | access-token + client-id | Standard | ✅ |
| /v2/marketfeed/ohlc | POST | ✅ | `getOhlcSnapshot()` | access-token + client-id | Standard | ✅ |
| /v2/marketfeed/quote | POST | ✅ | `getQuote()` | access-token + client-id | Standard | ✅ |
| /v2/optionchain | POST | ✅ | `getOptionChain()` | access-token + client-id | 1 unique req/3s | ✅ |
| /v2/optionchain/expirylist | POST | ✅ | `getOptionExpiryList()` | access-token + client-id | Standard | ✅ |
| /v2/charts/intraday | POST | ✅ | `getHistoricalCandles()` | access-token | Standard | ✅ |
| /v2/charts/historical | POST | ✅ | `getHistoricalCandles()` | access-token | Standard | ✅ |
| /v2/killswitch | POST | ✅ | `setKillSwitch()` | access-token | Standard | ✅ |
| /v2/killswitch | GET | ✅ | `getKillSwitchStatus()` | access-token | Standard | ✅ |
| /v2/pnlExit | POST | ✅ | `setPnlExit()` | access-token | Standard | ✅ |
| /v2/pnlExit | DELETE | ✅ | `deletePnlExit()` | access-token | Standard | ✅ |
| /v2/pnlExit | GET | ✅ | `getPnlExit()` | access-token | Standard | ✅ |
| /v2/orders/{id}/trades | GET | ✅ **NEW** | `getTradesByOrderId()` | access-token | Standard | — |
| /v2/super/orders | GET | ✅ **NEW** | `getSuperOrders()` | access-token | Standard | — |

**Coverage: 28 / ~32 documented endpoints.**

---

## CloudEngine REST API Endpoints (Phase 9/10 additions)

New backend endpoints added during Sessions 3–5 for the React dashboard:

| Endpoint | Method | Controller | Module | Purpose |
|----------|--------|------------|--------|---------|
| `GET /live-trading/status` | GET | `LiveTradingController` | LiveTradingModule | Live engine arm state |
| `POST /live-trading/arm/request` | POST | `LiveTradingController` | LiveTradingModule | 2FA arm step 1 |
| `POST /live-trading/arm/confirm` | POST | `LiveTradingController` | LiveTradingModule | 2FA arm step 2 |
| `POST /live-trading/arm/disarm` | POST | `LiveTradingController` | LiveTradingModule | Disarm live engine |
| `POST /live-trading/kill-switch` | POST | `LiveTradingController` | LiveTradingModule | Emergency halt |
| `GET /orders/today` | GET | `OrdersController` | ExecutionModule | Today's live orders |
| `GET /analytics/metrics` | GET | `AnalyticsController` | AnalyticsModule | 12-metric dashboard |
| `GET /risk/state/:engine` | GET | `RiskStateController` | RiskManagementModule | Per-engine risk state |
| `GET /market-data/intelligence` | GET | `MarketIntelligenceController` | MarketDataModule | Live indices + regime |
| `GET /market-data/candles/:id` | GET | `MarketIntelligenceController` | MarketDataModule | OHLCV candle series |
| `GET /options-intelligence/chain` | GET | `OptionsChainController` | OptionsIntelligenceModule | Options chain data |
| `GET /options-intelligence/expiries` | GET | `OptionsChainController` | OptionsIntelligenceModule | Active expiry dates |
| `GET /trades/today` | GET | `TradesController` | PortfolioModule | Today's closed trades |
| `GET /debug/stats` | GET | `DebugController` | DebugModule | Dashboard counters |
| `GET /debug/scan` | GET | `DebugController` | DebugModule | Trigger on-demand scan |
| `POST /backtest/run` | POST | `BacktestController` | BacktestModule | Walk-forward backtest |
| `GET /backtest/charges` | GET | `BacktestController` | BacktestModule | Charge rate reference |
| `GET /backtest/historical` | GET | `BacktestController` | BacktestModule | Load DB trades for backtest |
