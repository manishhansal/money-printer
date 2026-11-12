import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddAgentDecisions — creates the agent_decisions table for decision memory.
 *
 * Requirements: Phase 11
 */
export class AddAgentDecisions1800000000002 implements MigrationInterface {
  name = 'AddAgentDecisions1800000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "agent_decisions" (
        "id"                      uuid NOT NULL DEFAULT uuid_generate_v4(),
        "workflow_id"             uuid NOT NULL,
        "underlying"              character varying NOT NULL,
        "snapshot_at"             TIMESTAMP WITH TIME ZONE NOT NULL,
        "completed_at"            TIMESTAMP WITH TIME ZONE NOT NULL,
        "workflow_duration_ms"    integer NOT NULL,
        "market_context"          jsonb NOT NULL,
        "consensus_direction"     character varying NOT NULL,
        "consensus_confidence"    character varying NOT NULL,
        "final_verdict"           character varying NOT NULL,
        "advisory_risk_budget_pct" numeric(4,2) NOT NULL,
        "confidence_score"        integer NOT NULL,
        "all_agents_completed"    boolean NOT NULL DEFAULT false,
        "timed_out_agents"        integer NOT NULL DEFAULT 0,
        "full_decision"           jsonb NOT NULL,
        "was_executed"            boolean,
        "trade_id"                uuid,
        "actual_net_pnl"          numeric(15,2),
        "outcome"                 character varying NOT NULL DEFAULT 'PENDING',
        "direction_correct"       boolean,
        "reflection_notes"        text,
        "is_settled"              boolean NOT NULL DEFAULT false,
        "created_at"              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_agent_decisions_workflow_id" UNIQUE ("workflow_id"),
        CONSTRAINT "PK_agent_decisions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_agent_decisions_underlying_snapshot"
        ON "agent_decisions" ("underlying", "snapshot_at")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_agent_decisions_verdict_outcome"
        ON "agent_decisions" ("final_verdict", "outcome")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_agent_decisions_is_settled"
        ON "agent_decisions" ("is_settled", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_agent_decisions_is_settled"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_agent_decisions_verdict_outcome"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_agent_decisions_underlying_snapshot"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_decisions"`);
  }
}
