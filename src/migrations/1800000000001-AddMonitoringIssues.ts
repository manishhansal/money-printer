import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddMonitoringIssues — creates the monitoring_issues table for the
 * LocalMarketWatchdogService issue registry.
 *
 * Requirements: Phase 16.4
 */
export class AddMonitoringIssues1800000000001 implements MigrationInterface {
  name = 'AddMonitoringIssues1800000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "monitoring_issues" (
        "id"                    uuid NOT NULL DEFAULT uuid_generate_v4(),
        "issue_key"             character varying NOT NULL,
        "severity"              character varying(3) NOT NULL,
        "category"              character varying NOT NULL,
        "title"                 character varying NOT NULL,
        "description"           text NOT NULL,
        "source"                character varying NOT NULL,
        "first_detected_at"     TIMESTAMP WITH TIME ZONE NOT NULL,
        "last_detected_at"      TIMESTAMP WITH TIME ZONE NOT NULL,
        "occurrence_count"      integer NOT NULL DEFAULT 1,
        "affected_module"       character varying,
        "affected_instrument"   character varying,
        "affected_strategy"     character varying,
        "affected_order_id"     uuid,
        "reproduction_context"  jsonb,
        "root_cause"            text,
        "proposed_fix"          text,
        "status"                character varying NOT NULL DEFAULT 'DETECTED',
        "remediation_attempts"  integer NOT NULL DEFAULT 0,
        "test_status"           character varying,
        "affects_live_trading"  boolean NOT NULL DEFAULT false,
        "affects_paper_trading" boolean NOT NULL DEFAULT false,
        "is_systemic"           boolean NOT NULL DEFAULT false,
        "requires_human_approval" boolean NOT NULL DEFAULT false,
        "resolution_timestamp"  TIMESTAMP WITH TIME ZONE,
        "resolution_evidence"   text,
        "wont_fix_reason"       text,
        "created_at"            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_monitoring_issues_issue_key" UNIQUE ("issue_key"),
        CONSTRAINT "PK_monitoring_issues" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_monitoring_issues_severity_status"
        ON "monitoring_issues" ("severity", "status")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_monitoring_issues_first_detected"
        ON "monitoring_issues" ("first_detected_at")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_monitoring_issues_affects_live"
        ON "monitoring_issues" ("affects_live_trading", "status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_monitoring_issues_affects_live"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_monitoring_issues_first_detected"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_monitoring_issues_severity_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "monitoring_issues"`);
  }
}
