/**
 * agents.module.ts
 *
 * AgentsModule — multi-agent intelligence engine.
 *
 * Provides:
 *   - LlmClientService — provider-agnostic LLM API calls
 *   - AgentOrchestratorService — 6-phase workflow (15 agents)
 *   - AgentsController — REST API for research decisions
 *
 * Configuration via environment variables:
 *   LLM_PROVIDER=openai|anthropic|disabled  (default: disabled)
 *   LLM_MODEL=gpt-4o                        (default: gpt-4o)
 *   LLM_MAX_TOKENS=1000                     (default: 1000)
 *   LLM_TEMPERATURE=0.3                     (default: 0.3)
 *   OPENAI_API_KEY=sk-...                   (required when provider=openai)
 *   ANTHROPIC_API_KEY=sk-ant-...            (required when provider=anthropic)
 *
 * When LLM_PROVIDER=disabled, all agents use rule-based analysis
 * from verified MoneyPrinter market data — no external API calls.
 *
 * Requirements: Phase 3, 4
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LlmClientService } from './llm-client.service';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { DecisionMemoryService } from './decision-memory.service';
import { AgentsController } from './agents.controller';
import { AgentDecisions } from '../../database/entities/agent-decisions.entity';
import { SecretsModule } from '../secrets/secrets.module';

@Module({
  imports: [TypeOrmModule.forFeature([AgentDecisions]), SecretsModule],
  controllers: [AgentsController],
  providers: [LlmClientService, AgentOrchestratorService, DecisionMemoryService],
  exports: [AgentOrchestratorService, LlmClientService, DecisionMemoryService],
})
export class AgentsModule {}
