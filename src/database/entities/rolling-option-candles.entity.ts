/**
 * rolling-option-candles.entity.ts
 *
 * RollingOptionCandles — persistent store for Dhan v2 rolling / expired-options
 * historical data fetched from POST /v2/charts/rollingoption.
 *
 * # What "rolling" means
 *
 * Unlike a fixed-contract candle (where every row belongs to one specific
 * option contract), a rolling candle belongs to an ATM-relative strike
 * position at a given point in time.  For example, `strikeOffset = 'ATM'`
 * always represents the nearest ATM strike at the candle timestamp — which
 * might be NIFTY 23000 CE at 09:15 and NIFTY 23050 CE at 11:30 when the
 * underlying has moved up.  The `actualStrike` column records the absolute
 * strike inferred from the API's `strike` response field, and `spotPrice`
 * records the underlying spot at that timestamp.
 *
 * # Why a separate entity
 *
 * Rolling candles differ from `HistoricalCandles` in several ways:
 *   - They are keyed by (underlying, expiryFlag, expiryCode, strikeOffset,
 *     optionType, interval, timestamp), not by an instrument DB UUID.
 *   - They include IV, OI per candle natively.
 *   - They include the underlying spot price per candle.
 *   - The `actualStrike` may shift across candles as ATM rebalances.
 *
 * # Date coverage
 *
 * Dhan documents up to 5 years of rolling data (empirically validate; mark
 * rows with dataSourceVersion and fetchedAt for auditability).
 *
 * Requirements: Phase 2 — Dhan Historical Backfill
 */

import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * ATM-relative strike offsets supported by the Dhan rolling option API.
 *
 * Index options (OPTIDX): ATM-10 to ATM+10.
 * Stock options (OPTSTK): ATM-3 to ATM+3.
 */
export type RollingStrikeOffset =
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

/**
 * Unique constraint: one candle per (underlying, expiry type, expiry ordinal,
 * strike offset, option type, interval, timestamp).
 *
 * SQL:
 *   UNIQUE (underlying_security_id, expiry_flag, expiry_code,
 *           strike_offset, option_type, interval, timestamp)
 */
@Entity({ name: 'rolling_option_candles' })
@Unique('UQ_rolling_option_candles_key', [
  'underlyingSecurityId',
  'expiryFlag',
  'expiryCode',
  'strikeOffset',
  'optionType',
  'interval',
  'timestamp',
])
@Index('IDX_rolling_option_candles_underlying_expiry_strike', [
  'underlyingSecurityId',
  'expiryFlag',
  'strikeOffset',
  'optionType',
  'timestamp',
])
@Index('IDX_rolling_option_candles_underlying_ts', ['underlyingSecurityId', 'timestamp'])
export class RollingOptionCandles {
  /** UUID primary key. */
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Dhan security ID of the UNDERLYING instrument.
   * Example: '13' for NIFTY 50, '25' for BANKNIFTY.
   * This is the underlying, NOT the option contract's security ID.
   */
  @Column({ name: 'underlying_security_id', type: 'varchar', length: 20 })
  underlyingSecurityId!: string;

  /**
   * Underlying symbol for human readability.
   * Example: 'NIFTY', 'BANKNIFTY', 'RELIANCE'.
   */
  @Column({ name: 'underlying_symbol', type: 'varchar', length: 32 })
  underlyingSymbol!: string;

  /**
   * Exchange segment of the OPTION contract.
   * Typically 'NSE_FNO' for index options and 'NSE_FNO' for stock options.
   */
  @Column({ name: 'exchange_segment', type: 'varchar', length: 16 })
  exchangeSegment!: string;

  /**
   * Instrument type classification.
   * 'OPTIDX' = index option; 'OPTSTK' = stock option.
   */
  @Column({ name: 'instrument_type', type: 'varchar', length: 10 })
  instrumentType!: 'OPTIDX' | 'OPTSTK';

  /**
   * Expiry type selector.
   * 'WEEK' = weekly expiry; 'MONTH' = monthly expiry.
   */
  @Column({ name: 'expiry_flag', type: 'varchar', length: 8 })
  expiryFlag!: 'WEEK' | 'MONTH';

  /**
   * Expiry ordinal.
   * 0 = current (nearest) expiry, 1 = next, 2 = far, etc.
   */
  @Column({ name: 'expiry_code', type: 'smallint' })
  expiryCode!: number;

  /**
   * ATM-relative strike offset.
   * The API returns data relative to ATM at each timestamp.
   * See RollingStrikeOffset for allowed values.
   */
  @Column({ name: 'strike_offset', type: 'varchar', length: 8 })
  strikeOffset!: RollingStrikeOffset;

  /**
   * Option type: 'CE' (call) or 'PE' (put).
   * Stored in canonical CE/PE format; CALL maps to CE, PUT maps to PE.
   */
  @Column({ name: 'option_type', type: 'varchar', length: 4 })
  optionType!: 'CE' | 'PE';

  /**
   * Candle interval in minutes.
   * One of: '1' | '5' | '15' | '25' | '60'.
   */
  @Column({ name: 'interval', type: 'varchar', length: 4 })
  interval!: '1' | '5' | '15' | '25' | '60';

  /**
   * Candle open-time in UTC (timestamp with time zone).
   * Converted from Unix epoch seconds returned by the Dhan API.
   * Note: Dhan timestamps are in IST; store in UTC for consistency.
   */
  @Column({ name: 'timestamp', type: 'timestamptz' })
  timestamp!: Date;

  /**
   * Opening price of the option contract for this candle period.
   * NUMERIC(12,2) — avoids floating-point precision loss.
   */
  @Column({ name: 'open_price', type: 'numeric', precision: 12, scale: 2, nullable: true })
  openPrice!: string | null;

  /**
   * Highest option price traded during the candle period.
   */
  @Column({ name: 'high_price', type: 'numeric', precision: 12, scale: 2, nullable: true })
  highPrice!: string | null;

  /**
   * Lowest option price traded during the candle period.
   */
  @Column({ name: 'low_price', type: 'numeric', precision: 12, scale: 2, nullable: true })
  lowPrice!: string | null;

  /**
   * Closing option price at the end of the candle period.
   */
  @Column({ name: 'close_price', type: 'numeric', precision: 12, scale: 2, nullable: true })
  closePrice!: string | null;

  /**
   * Traded volume during the candle period (option contracts).
   */
  @Column({ name: 'volume', type: 'bigint', nullable: true })
  volume!: string | null;

  /**
   * Implied volatility (%) at this candle timestamp.
   * Example: 18.50 means 18.50% IV.
   * Null when not requested (not in requiredData) or not available.
   */
  @Column({ name: 'implied_volatility', type: 'numeric', precision: 8, scale: 4, nullable: true })
  impliedVolatility!: string | null;

  /**
   * Open interest (number of open contracts) at this candle timestamp.
   * Null when not requested or not available.
   */
  @Column({ name: 'open_interest', type: 'bigint', nullable: true })
  openInterest!: string | null;

  /**
   * Actual absolute strike price of this rolling contract at this timestamp.
   *
   * The rolling strike shifts as the underlying moves and ATM rebalances.
   * For example, ATM-2 for NIFTY 50 might be 22850 at 09:15 and 22900 at 11:30.
   * Null when 'strike' was not included in requiredData.
   *
   * Essential for backtesting: use this to reconstruct which exact contract
   * was being tracked at each point in time.
   */
  @Column({
    name: 'actual_strike',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
  })
  actualStrike!: string | null;

  /**
   * Underlying spot price at this candle timestamp.
   *
   * Provided when 'spot' is in requiredData.
   * Essential for reconstructing ATM offset and validating data consistency.
   * Null when 'spot' was not included in requiredData.
   */
  @Column({ name: 'spot_price', type: 'numeric', precision: 12, scale: 2, nullable: true })
  spotPrice!: string | null;

  /**
   * Data quality flag.
   * 'ok' — passes all validation checks.
   * 'suspicious' — OHLC relationships invalid or values appear anomalous.
   * 'missing_fields' — one or more requested fields returned null/empty.
   */
  @Column({ name: 'data_quality', type: 'varchar', length: 16, default: 'ok' })
  dataQuality!: 'ok' | 'suspicious' | 'missing_fields';

  /**
   * UTC timestamp when this row was fetched from the Dhan API.
   * Used for auditing and incremental re-fetch decisions.
   */
  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt!: Date;

  /**
   * Dhan API version tag for this row.
   * Allows future re-fetch when Dhan changes its data model.
   * Default: 'v2'.
   */
  @Column({ name: 'data_source_version', type: 'varchar', length: 8, default: 'v2' })
  dataSourceVersion!: string;
}
