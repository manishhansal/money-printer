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

// ---------------------------------------------------------------------------
// Kill Switch
// ---------------------------------------------------------------------------

/** Response from POST /v2/killswitch or GET /v2/killswitch. */
export interface DhanKillSwitchResponse {
  dhanClientId: string;
  /**
   * POST response: descriptive message e.g. "Kill Switch has been successfully activated".
   * GET response: 'ACTIVATE' | 'DEACTIVATE'.
   */
  killSwitchStatus: string;
}

// ---------------------------------------------------------------------------
// P&L Based Auto-Exit
// ---------------------------------------------------------------------------

/** Request body for POST /v2/pnlExit. */
export interface DhanPnlExitRequest {
  /** Target profit in INR — exit all positions when cumulative P&L reaches this value. */
  profitValue: string;
  /** Target loss in INR — exit all positions when cumulative P&L falls to -lossValue. */
  lossValue: string;
  /** Product types to apply the rule to. */
  productType: Array<'INTRADAY' | 'DELIVERY'>;
  /**
   * When true, Dhan will also activate the account-level kill switch after
   * exiting positions (prevents new orders for the rest of the day).
   */
  enableKillSwitch: boolean;
}

/** Response from POST /v2/pnlExit or DELETE /v2/pnlExit. */
export interface DhanPnlExitResponse {
  pnlExitStatus: 'ACTIVE' | 'INACTIVE' | 'DISABLED';
  message: string;
}

/** Response from GET /v2/pnlExit. */
export interface DhanPnlExitGetResponse {
  pnlExitStatus: 'ACTIVE' | 'INACTIVE';
  profit: string;
  loss: string;
  productType: Array<'INTRADAY' | 'DELIVERY'>;
  enable_kill_switch: boolean;
}

// ---------------------------------------------------------------------------
// Margin Calculator (POST /v2/margincalculator)
// ---------------------------------------------------------------------------

/** Single instrument margin calculation request item. */
export interface DhanMarginInstrument {
  exchangeSegment: DhanExchangeSegment;
  transactionType: DhanTransactionType;
  quantity: number;
  productType: DhanProductType;
  securityId: string;
  price: number;
}

/** Request body for POST /v2/margincalculator. */
export interface DhanMarginCalculatorRequest {
  dhanClientId: string;
  instruments: DhanMarginInstrument[];
}

/** Response from POST /v2/margincalculator. */
export interface DhanMarginCalculatorResponse {
  dhanClientId: string;
  totalMargin: number;
  spanMargin: number;
  exposureMargin: number;
  availableBalance: number;
  variableMargin: number;
  insufficientBalance: boolean;
  netMarginRequired: number;
}

// ---------------------------------------------------------------------------
// Order by Correlation ID (GET /v2/orders/external/{correlationId})
// ---------------------------------------------------------------------------

/**
 * Response from GET /v2/orders/external/{correlationId}.
 * Returns the DhanOrder matching the client-assigned correlation ID.
 * Used for crash-recovery: if a broker submission succeeded but the DB write
 * failed, this endpoint recovers the Dhan order ID by correlationId.
 */
export type DhanOrderByCorrelationIdResponse = DhanOrder;

// ---------------------------------------------------------------------------
// Rolling Option Historical Data (POST /v2/charts/rollingoption)
// ---------------------------------------------------------------------------

/**
 * ATM-relative strike positions for rolling option data.
 *
 * Index options (OPTIDX): ATM-10 through ATM+10 (21 strikes).
 * Stock options (OPTSTK): ATM-3 through ATM+3 (7 strikes).
 *
 * The API provides data relative to the ATM strike at each timestamp,
 * so the actual absolute strike shifts as the underlying moves.
 * The `strike` field in `requiredData` gives the actual strike per candle.
 *
 * DhanHQ v2 expired options API: https://dhanhq.co/docs/v2/expired-options-data/
 */
export type DhanRollingOptionStrike =
  | 'ATM'
  | 'ATM-1'
  | 'ATM-2'
  | 'ATM-3'
  | 'ATM-4'
  | 'ATM-5'
  | 'ATM-6'
  | 'ATM-7'
  | 'ATM-8'
  | 'ATM-9'
  | 'ATM-10'
  | 'ATM+1'
  | 'ATM+2'
  | 'ATM+3'
  | 'ATM+4'
  | 'ATM+5'
  | 'ATM+6'
  | 'ATM+7'
  | 'ATM+8'
  | 'ATM+9'
  | 'ATM+10';

/** Fields that can be requested from the rolling option endpoint. */
export type DhanRollingOptionDataField =
  'open' | 'high' | 'low' | 'close' | 'iv' | 'volume' | 'strike' | 'oi' | 'spot';

/**
 * Request body for POST /v2/charts/rollingoption.
 *
 * Returns up to 30 days per request of continuous rolling ATM-relative
 * option OHLCV + IV + OI data spanning up to 5 years of history.
 *
 * Key constraints from Dhan documentation:
 *   - fromDate to toDate window: maximum 30 calendar days per request.
 *   - Interval: 1, 5, 15, 25, or 60 minutes.
 *   - Strike range: index options support ATM±10; stock options support ATM±3.
 *   - expiryCode: 0 = current expiry, 1 = next expiry, etc.
 *   - expiryFlag: WEEK = weekly expiry, MONTH = monthly expiry.
 */
export interface DhanRollingOptionRequest {
  /** Exchange segment, e.g. 'NSE_FNO' for index/stock F&O. */
  exchangeSegment: DhanExchangeSegment;
  /** Candle interval in minutes: '1' | '5' | '15' | '25' | '60'. */
  interval: '1' | '5' | '15' | '25' | '60';
  /** Underlying security ID (e.g. 13 for NIFTY, 25 for BANKNIFTY). */
  securityId: string;
  /** Instrument type: OPTIDX for index options, OPTSTK for stock options. */
  instrument: 'OPTIDX' | 'OPTSTK';
  /**
   * Expiry type selector.
   * WEEK = weekly expiry (e.g. every Thursday for NIFTY).
   * MONTH = monthly expiry (last Thursday of the month).
   */
  expiryFlag: 'WEEK' | 'MONTH';
  /**
   * Expiry ordinal.
   * 0 = current (nearest) expiry, 1 = next expiry, etc.
   */
  expiryCode: 0 | 1 | 2 | 3;
  /**
   * ATM-relative strike offset.
   * For OPTIDX: ATM-10 to ATM+10.
   * For OPTSTK: ATM-3 to ATM+3.
   * 'ATM' means at-the-money.
   * '+' means out-of-the-money for CALL (or in-the-money for PUT).
   * '-' means in-the-money for CALL (or out-of-the-money for PUT).
   */
  strike: DhanRollingOptionStrike;
  /** Option type: CALL or PUT. */
  drvOptionType: 'CALL' | 'PUT';
  /**
   * Fields to include in the response.
   * Requesting only needed fields reduces response payload.
   * 'strike' field gives the actual absolute strike price per candle.
   * 'spot' field gives the underlying spot price per candle.
   */
  requiredData: DhanRollingOptionDataField[];
  /** Range start, YYYY-MM-DD format. */
  fromDate: string;
  /**
   * Range end, YYYY-MM-DD format.
   * Note: toDate is NON-INCLUSIVE per Dhan API semantics.
   * To fetch data through 2024-01-31, set toDate to 2024-02-01.
   */
  toDate: string;
}

/**
 * Data arrays for one option leg (CE or PE) from the rolling option response.
 * All arrays are parallel (index N corresponds to the same candle across fields).
 * Fields not included in requiredData will be absent or empty arrays.
 */
export interface DhanRollingOptionLeg {
  /** Opening prices for each candle. Present when 'open' in requiredData. */
  open?: number[];
  /** Period high prices. Present when 'high' in requiredData. */
  high?: number[];
  /** Period low prices. Present when 'low' in requiredData. */
  low?: number[];
  /** Closing prices. Present when 'close' in requiredData. */
  close?: number[];
  /** Traded volumes. Present when 'volume' in requiredData. */
  volume?: number[];
  /**
   * Implied volatility (%). Present when 'iv' in requiredData.
   * Values represent IV as a decimal percentage (e.g. 18.5 = 18.5%).
   */
  iv?: number[];
  /**
   * Actual absolute strike price at each candle timestamp.
   * Present when 'strike' in requiredData.
   * Shifts as the underlying moves and ATM rebalances across expirations.
   */
  strike?: number[];
  /** Open interest (contracts). Present when 'oi' in requiredData. */
  oi?: number[];
  /**
   * Underlying spot price at each candle timestamp.
   * Present when 'spot' in requiredData.
   * Useful for reconstructing the ATM offset and validating data consistency.
   */
  spot?: number[];
  /** Unix epoch timestamps (seconds) for each candle. Always present. */
  timestamp: number[];
}

/**
 * Response from POST /v2/charts/rollingoption.
 *
 * The response always has a `data` wrapper with `ce` and `pe` legs.
 * When only CALL is requested, `pe` is null and vice versa.
 * Both can be null when no data is available for the period.
 */
export interface DhanRollingOptionResponse {
  data: {
    ce: DhanRollingOptionLeg | null;
    pe: DhanRollingOptionLeg | null;
  };
}
