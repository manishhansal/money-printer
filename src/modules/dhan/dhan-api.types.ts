/**
 * dhan-api.types.ts
 *
 * TypeScript interfaces for all Dhan/DhanHQ v2 API requests and responses.
 *
 * References:
 *   https://dhanhq.co/docs/v2/orders/
 *   https://dhanhq.co/docs/v2/portfolio/
 *   https://dhanhq.co/docs/v2/historical-data/
 *   https://dhanhq.co/docs/v2/option-chain/
 *   https://dhanhq.co/docs/v2/super-order/
 *   https://dhanhq.co/docs/v2/funds/
 *   https://dhanhq.co/docs/v2/market-quote/
 *
 * Requirements: 3.1, 3.2, 3.3, 3.7
 */

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export type DhanExchangeSegment =
  'NSE_EQ' | 'NSE_FNO' | 'BSE_EQ' | 'BSE_FNO' | 'MCX_COMM' | 'IDX_I';

export type DhanTransactionType = 'BUY' | 'SELL';

export type DhanProductType = 'CNC' | 'INTRADAY' | 'MARGIN' | 'MTF' | 'CO' | 'BO';

export type DhanOrderType = 'LIMIT' | 'MARKET' | 'STOP_LOSS' | 'STOP_LOSS_MARKET';

export type DhanValidity = 'DAY' | 'IOC';

export type DhanOrderStatus =
  'TRANSIT' | 'PENDING' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';

export type DhanPositionType = 'LONG' | 'SHORT' | 'CLOSED';

export type DhanInstrumentType =
  'EQUITY' | 'FUTIDX' | 'FUTSTK' | 'OPTIDX' | 'OPTSTK' | 'FUTCOM' | 'OPTFUT';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when Dhan returns HTTP 401 or 403 (Requirement 3.7). */
export class DhanAuthFailureError extends Error {
  constructor(
    public readonly statusCode: 401 | 403,
    public readonly endpoint: string,
  ) {
    super(`Dhan authentication failure (HTTP ${statusCode}) on endpoint: ${endpoint}`);
    this.name = 'DhanAuthFailureError';
  }
}

/** Thrown when the rate-limit queue is at capacity (50 requests) (Requirement 3.9). */
export class DhanRateLimitQueueFullError extends Error {
  constructor() {
    super('Dhan rate-limit queue is at capacity (50 requests)');
    this.name = 'DhanRateLimitQueueFullError';
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Response from a Dhan session/token exchange. */
export interface DhanAuthResponse {
  /** Dhan access token (JWT). */
  accessToken: string;
  /** Dhan client ID associated with the token. */
  dhanClientId: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Live market quotes (REST snapshot)
// ---------------------------------------------------------------------------

/** Per-instrument LTP data. */
export interface DhanLtpData {
  last_price: number;
}

/** Per-instrument OHLC + LTP data. */
export interface DhanOhlcData {
  last_price: number;
  ohlc: {
    open: number;
    high: number;
    low: number;
    close: number;
  };
}

/** Full quote with market depth. */
export interface DhanQuoteData {
  last_price: number;
  ohlc: {
    open: number;
    high: number;
    low: number;
    close: number;
  };
  volume: number;
  average_price: number;
  oi: number;
  net_change: number;
  depth: {
    buy: Array<{ quantity: number; price: number; orders: number }>;
    sell: Array<{ quantity: number; price: number; orders: number }>;
  };
}

/** Request body for /marketfeed/quote — a map of exchangeSegment → securityId[]. */
export type DhanQuoteRequest = Partial<Record<DhanExchangeSegment, number[]>>;

/** Response from /marketfeed/ltp. */
export interface DhanLtpResponse {
  data: Partial<Record<DhanExchangeSegment, Record<string, DhanLtpData>>>;
  status: string;
}

/** Response from /marketfeed/ohlc. */
export interface DhanOhlcResponse {
  data: Partial<Record<DhanExchangeSegment, Record<string, DhanOhlcData>>>;
  status: string;
}

/** Response from /marketfeed/quote (market depth). */
export interface DhanQuoteResponse {
  data: Partial<Record<DhanExchangeSegment, Record<string, DhanQuoteData>>>;
  status: string;
}

// ---------------------------------------------------------------------------
// Historical candle data
// ---------------------------------------------------------------------------

/** Request for /charts/historical (daily candles). */
export interface DhanHistoricalCandleRequest {
  securityId: string;
  exchangeSegment: DhanExchangeSegment;
  instrument: DhanInstrumentType;
  /** Expiry code: 0 = current, 1 = next, 2 = far. */
  expiryCode?: 0 | 1 | 2;
  /** Include open interest (for F&O). */
  oi?: boolean;
  /** YYYY-MM-DD */
  fromDate: string;
  /** YYYY-MM-DD */
  toDate: string;
}

/** Request for /charts/intraday (minute candles). */
export interface DhanIntradayCandleRequest {
  securityId: string;
  exchangeSegment: DhanExchangeSegment;
  instrument: DhanInstrumentType;
  /** Candle interval in minutes. */
  interval: '1' | '5' | '15' | '25' | '60';
  /** YYYY-MM-DD */
  fromDate: string;
  /** YYYY-MM-DD */
  toDate: string;
}

/** Union request for historical or intraday candles. */
export type DhanCandleRequest = DhanHistoricalCandleRequest | DhanIntradayCandleRequest;

/** Candle data arrays returned by both historical endpoints. */
export interface DhanCandleResponse {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  /** Unix epoch timestamps. */
  timestamp: number[];
  open_interest: number[];
}

// ---------------------------------------------------------------------------
// Option chain
// ---------------------------------------------------------------------------

/** Request for /optionchain. */
export interface DhanOptionChainRequest {
  /** Security ID of the underlying instrument. */
  UnderlyingScrip: number;
  /** Exchange segment of the underlying. */
  UnderlyingSeg: DhanExchangeSegment;
  /** Expiry date in YYYY-MM-DD format. */
  Expiry: string;
}

/** Greeks for a single option contract. */
export interface DhanOptionGreeks {
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
}

/** Single CE or PE leg in the option chain. */
export interface DhanOptionLeg {
  average_price: number;
  greeks: DhanOptionGreeks;
  implied_volatility: number;
  last_price: number;
  oi: number;
  previous_close_price: number;
  previous_oi: number;
  previous_volume: number;
  security_id: number;
  top_ask_price: number;
  top_ask_quantity: number;
  top_bid_price: number;
  top_bid_quantity: number;
  volume: number;
}

/** One strike entry in the option chain. */
export interface DhanOptionStrike {
  ce?: DhanOptionLeg;
  pe?: DhanOptionLeg;
}

/** Full option chain response from /optionchain. */
export interface DhanOptionChainResponse {
  data: {
    last_price: number;
    /** Keys are strike prices as strings (e.g. "25650.000000"). */
    oc: Record<string, DhanOptionStrike>;
  };
}

/** Expiry list response from /optionchain/expirylist. */
export interface DhanOptionExpiryListResponse {
  data: string[];
}

// ---------------------------------------------------------------------------
// Order placement
// ---------------------------------------------------------------------------

/** Request body for POST /orders. */
export interface DhanOrderRequest {
  dhanClientId: string;
  /** User/partner generated correlation ID (max 30 chars). */
  correlationId?: string;
  transactionType: DhanTransactionType;
  exchangeSegment: DhanExchangeSegment;
  productType: DhanProductType;
  orderType: DhanOrderType;
  validity: DhanValidity;
  securityId: string;
  quantity: number;
  disclosedQuantity?: number;
  price?: number;
  triggerPrice?: number;
  afterMarketOrder?: boolean;
  amoTime?: string;
  boProfitValue?: number;
  boStopLossValue?: number;
}

/** Response from POST /orders. */
export interface DhanOrderResponse {
  orderId: string;
  orderStatus: DhanOrderStatus;
}

// ---------------------------------------------------------------------------
// Order modification
// ---------------------------------------------------------------------------

/** Request body for PUT /orders/{order-id}. */
export interface DhanModifyOrderRequest {
  dhanClientId: string;
  orderId: string;
  orderType: DhanOrderType;
  legName?: string;
  quantity: number;
  price?: number;
  disclosedQuantity?: number;
  triggerPrice?: number;
  validity: DhanValidity;
}

// ---------------------------------------------------------------------------
// Order cancellation
// ---------------------------------------------------------------------------

/** Response from DELETE /orders/{order-id}. */
export interface DhanCancelOrderResponse {
  orderId: string;
  orderStatus: DhanOrderStatus;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** A single open position record. */
export interface DhanPosition {
  dhanClientId: string;
  tradingSymbol: string;
  securityId: string;
  positionType: DhanPositionType;
  exchangeSegment: DhanExchangeSegment;
  productType: DhanProductType;
  buyAvg: number;
  buyQty: number;
  costPrice: number;
  sellAvg: number;
  sellQty: number;
  netQty: number;
  realizedProfit: number;
  unrealizedProfit: number;
  rbiReferenceRate: number;
  multiplier: number;
  carryForwardBuyQty: number;
  carryForwardSellQty: number;
  carryForwardBuyValue: number;
  carryForwardSellValue: number;
  dayBuyQty: number;
  daySellQty: number;
  dayBuyValue: number;
  daySellValue: number;
  /** YYYY-MM-DD, or '0001-01-01' for non-derivative positions. */
  drvExpiryDate: string;
  drvOptionType: 'CALL' | 'PUT' | null;
  drvStrikePrice: number;
  crossCurrency: boolean;
}

/** GET /positions response — array of positions. */
export type DhanPositionsResponse = DhanPosition[];

// ---------------------------------------------------------------------------
// Portfolio / holdings
// ---------------------------------------------------------------------------

/** A single holding in the demat account. */
export interface DhanHolding {
  exchange: string;
  tradingSymbol: string;
  securityId: string;
  isin: string;
  totalQty: number;
  dpQty: number;
  t1Qty: number;
  availableQty: number;
  collateralQty: number;
  avgCostPrice: number;
}

/** GET /holdings response — array of holdings. */
export type DhanPortfolioResponse = DhanHolding[];

// ---------------------------------------------------------------------------
// Tradebook
// ---------------------------------------------------------------------------

/** A single trade record. */
export interface DhanTrade {
  dhanClientId: string;
  orderId: string;
  exchangeOrderId: string;
  exchangeTradeId: string;
  transactionType: DhanTransactionType;
  exchangeSegment: DhanExchangeSegment;
  productType: DhanProductType;
  orderType: DhanOrderType;
  tradingSymbol: string;
  securityId: string;
  tradedQuantity: number;
  tradedPrice: number;
  /** ISO-8601 timestamp. */
  createTime: string;
  updateTime: string;
  exchangeTime: string;
  drvExpiryDate: string;
  drvOptionType: 'CALL' | 'PUT' | null;
  drvStrikePrice: number;
}

/** GET /trades response — array of trades. */
export type DhanTradebookResponse = DhanTrade[];

// ---------------------------------------------------------------------------
// Orderbook
// ---------------------------------------------------------------------------

/** A single order record. */
export interface DhanOrder {
  dhanClientId: string;
  orderId: string;
  correlationId: string;
  orderStatus: DhanOrderStatus;
  transactionType: DhanTransactionType;
  exchangeSegment: DhanExchangeSegment;
  productType: DhanProductType;
  orderType: DhanOrderType;
  validity: DhanValidity;
  tradingSymbol: string;
  securityId: string;
  quantity: number;
  disclosedQuantity: number;
  price: number;
  triggerPrice: number;
  afterMarketOrder: boolean;
  boProfitValue: number;
  boStopLossValue: number;
  averageTradedPrice: number;
  filledQty: number;
  pendingQuantity: number;
  cancelledQuantity: number;
  createTime: string;
  updateTime: string;
  exchangeTime: string;
  drvExpiryDate: string;
  drvOptionType: 'CALL' | 'PUT' | null;
  drvStrikePrice: number;
}

/** GET /orders response — array of orders. */
export type DhanOrderbookResponse = DhanOrder[];

// ---------------------------------------------------------------------------
// Super Orders
// ---------------------------------------------------------------------------

/** Request body for POST /super/orders. */
export interface DhanSuperOrderRequest {
  dhanClientId: string;
  correlationId?: string;
  transactionType: DhanTransactionType;
  exchangeSegment: DhanExchangeSegment;
  productType: DhanProductType;
  orderType: DhanOrderType;
  securityId: string;
  quantity: number;
  price: number;
  targetPrice: number;
  stopLossPrice: number;
  /** Price jump by which stop loss should be trailed. */
  trailingJump: number;
}

/** Request body for PUT /super/orders/{order-id}. */
export interface DhanModifySuperOrderRequest {
  dhanClientId: string;
  orderId: string;
  /** Leg to modify: 'ENTRY_LEG' | 'TARGET_LEG' | 'STOP_LOSS_LEG'. */
  orderLeg: 'ENTRY_LEG' | 'TARGET_LEG' | 'STOP_LOSS_LEG';
  quantity?: number;
  price?: number;
  targetPrice?: number;
  stopLossPrice?: number;
  trailingJump?: number;
}

/** Response from POST /super/orders or PUT /super/orders/{order-id}. */
export interface DhanSuperOrderResponse {
  orderId: string;
  orderStatus: DhanOrderStatus;
}

// ---------------------------------------------------------------------------
// Fund limits
// ---------------------------------------------------------------------------

/** Response from GET /fundlimit. */
export interface DhanFundLimitResponse {
  dhanClientId: string;
  /** Available balance to trade (note: Dhan API typo preserved). */
  availabelBalance: number;
  /** Start-of-day limit. */
  sodLimit: number;
  collateralAmount: number;
  receiveableAmount: number;
  utilizedAmount: number;
  blockedPayoutAmount: number;
  withdrawableBalance: number;
}

// ---------------------------------------------------------------------------
// Generic Dhan error response body
// ---------------------------------------------------------------------------

export interface DhanErrorResponse {
  errorType: string;
  errorCode: string;
  errorMessage: string;
}
