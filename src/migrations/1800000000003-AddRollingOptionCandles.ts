import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRollingOptionCandles1800000000003 implements MigrationInterface {
  name = 'AddRollingOptionCandles1800000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "rolling_option_candles" (
        "id"                    uuid          NOT NULL DEFAULT uuid_generate_v4(),
        "underlying_security_id" varchar(20)  NOT NULL,
        "underlying_symbol"     varchar(32)   NOT NULL,
        "exchange_segment"      varchar(16)   NOT NULL,
        "instrument_type"       varchar(10)   NOT NULL,
        "expiry_flag"           varchar(8)    NOT NULL,
        "expiry_code"           smallint      NOT NULL,
        "strike_offset"         varchar(8)    NOT NULL,
        "option_type"           varchar(4)    NOT NULL,
        "interval"              varchar(4)    NOT NULL,
        "timestamp"             TIMESTAMPTZ   NOT NULL,
        "open_price"            NUMERIC(12,2) NULL,
        "high_price"            NUMERIC(12,2) NULL,
        "low_price"             NUMERIC(12,2) NULL,
        "close_price"           NUMERIC(12,2) NULL,
        "volume"                BIGINT        NULL,
        "implied_volatility"    NUMERIC(8,4)  NULL,
        "open_interest"         BIGINT        NULL,
        "actual_strike"         NUMERIC(12,2) NULL,
        "spot_price"            NUMERIC(12,2) NULL,
        "data_quality"          varchar(16)   NOT NULL DEFAULT 'ok',
        "fetched_at"            TIMESTAMPTZ   NOT NULL,
        "data_source_version"   varchar(8)    NOT NULL DEFAULT 'v2',
        CONSTRAINT "PK_rolling_option_candles" PRIMARY KEY ("id")
      )
    `);

    // Unique key — one candle per (underlying, expiry type, expiry code,
    // strike offset, option type, interval, timestamp).
    await queryRunner.query(`
      ALTER TABLE "rolling_option_candles"
        ADD CONSTRAINT "UQ_rolling_option_candles_key"
        UNIQUE (
          "underlying_security_id",
          "expiry_flag",
          "expiry_code",
          "strike_offset",
          "option_type",
          "interval",
          "timestamp"
        )
    `);

    // Primary lookup index: by underlying + expiry + strike + type + time.
    await queryRunner.query(`
      CREATE INDEX "IDX_rolling_option_candles_underlying_expiry_strike"
        ON "rolling_option_candles" (
          "underlying_security_id",
          "expiry_flag",
          "strike_offset",
          "option_type",
          "timestamp" DESC
        )
    `);

    // Secondary index: by underlying + time (for coverage queries).
    await queryRunner.query(`
      CREATE INDEX "IDX_rolling_option_candles_underlying_ts"
        ON "rolling_option_candles" ("underlying_security_id", "timestamp" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rolling_option_candles_underlying_ts"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_rolling_option_candles_underlying_expiry_strike"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "rolling_option_candles"`);
  }
}
