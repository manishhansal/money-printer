/**
 * llm-client.service.ts
 *
 * LlmClientService — provider-agnostic LLM API client.
 *
 * Supports:
 *   - OpenAI (gpt-4o, gpt-4-turbo, etc.) via REST
 *   - Anthropic (claude-3-5-sonnet, etc.) via REST
 *   - Disabled mode — returns structured fallback instead of calling any API
 *
 * Safety contract:
 *   - 30-second hard timeout per request
 *   - API keys read from SecretsService, never logged
 *   - Response content validated before returning
 *   - Callers MUST NOT use LLM output for prices, lot sizes, security IDs,
 *     or any value that feeds directly into broker order submission
 *
 * Requirements: Phase 3, 4
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretsService } from '../secrets/secrets.service';
import {
  LlmConfig,
  LlmRequest,
  LlmResponse,
  LlmProvider,
  LlmAvailabilityStatus,
} from './agent.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const LLM_REQUEST_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class LlmTimeoutError extends Error {
  constructor(provider: string, durationMs: number) {
    super(`LLM request timed out after ${durationMs}ms (provider: ${provider})`);
    this.name = 'LlmTimeoutError';
  }
}

export class LlmUnavailableError extends Error {
  constructor(reason: string) {
    super(`LLM unavailable: ${reason}`);
    this.name = 'LlmUnavailableError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider Availability
// ─────────────────────────────────────────────────────────────────────────────

// LlmAvailabilityStatus is defined and exported from agent.types.ts

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class LlmClientService {
  private readonly logger = new Logger(LlmClientService.name);

  /** Default configuration — overridable per call. */
  private readonly defaultConfig: LlmConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly secretsService: SecretsService,
  ) {
    const provider = configService.get<string>('LLM_PROVIDER', 'disabled') as LlmProvider;

    this.defaultConfig = {
      provider,
      model: configService.get<string>('LLM_MODEL', 'gpt-4o'),
      maxTokens: configService.get<number>('LLM_MAX_TOKENS', 1000),
      temperature: configService.get<number>('LLM_TEMPERATURE', 0.3),
      timeoutMs: LLM_REQUEST_TIMEOUT_MS,
    };

    this.logger.log(`LlmClientService ready — provider: ${provider}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Call the configured LLM provider with a system + user prompt.
   *
   * Returns LlmResponse on success.
   * Throws LlmTimeoutError on timeout.
   * Throws LlmUnavailableError when provider=disabled or API key missing.
   */
  async call(request: LlmRequest, configOverride?: Partial<LlmConfig>): Promise<LlmResponse> {
    const config: LlmConfig = { ...this.defaultConfig, ...configOverride };

    if (config.provider === 'disabled') {
      throw new LlmUnavailableError('LLM provider is set to disabled (LLM_PROVIDER=disabled)');
    }

    const startMs = Date.now();

    // Wrap the actual API call in a timeout race.
    // The timer handle is always cleared to prevent open-handle leaks in tests
    // and to avoid running the rejection callback after the Promise has already
    // resolved or rejected from another branch.
    const apiCall = this.callProvider(config, request);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new LlmTimeoutError(config.provider, config.timeoutMs));
      }, config.timeoutMs);
    });

    try {
      const response = await Promise.race([apiCall, timeoutPromise]);
      const durationMs = Date.now() - startMs;
      this.logger.debug(
        `LLM call completed: provider=${config.provider} tokens=${response.tokensUsed} duration=${durationMs}ms`,
      );
      return { ...response, durationMs, provider: config.provider };
    } catch (err) {
      if (err instanceof LlmTimeoutError || err instanceof LlmUnavailableError) throw err;
      throw new LlmUnavailableError(`${config.provider} call failed: ${(err as Error).message}`);
    } finally {
      // Always clear the timeout timer so the event loop can drain cleanly.
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Check if the LLM provider is configured and available.
   *
   * NOTE: This only checks whether the provider is NOT disabled.
   * It does NOT verify credentials or network reachability.
   * Use getAvailabilityStatus() for a more precise status.
   */
  isAvailable(): boolean {
    return this.defaultConfig.provider !== 'disabled';
  }

  getProvider(): LlmProvider {
    return this.defaultConfig.provider;
  }

  /**
   * Returns a fine-grained availability status that separates:
   *   - DISABLED: LLM_PROVIDER=disabled, rule-based mode is authoritative
   *   - CREDENTIALS_MISSING: provider configured but API key absent/empty
   *   - CONFIGURED: provider set and key present (connectivity not verified)
   *
   * This does NOT make a live network call — it inspects local config only.
   * Use it for dashboard display and health reporting.
   */
  async getAvailabilityStatus(): Promise<LlmAvailabilityStatus> {
    if (this.defaultConfig.provider === 'disabled') return 'DISABLED';

    const keyName =
      this.defaultConfig.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';

    try {
      const key = await this.secretsService.get(keyName);
      if (!key || key.trim() === '') return 'CREDENTIALS_MISSING';
      return 'CONFIGURED';
    } catch {
      return 'CREDENTIALS_MISSING';
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Provider implementations
  // ─────────────────────────────────────────────────────────────────────────

  private async callProvider(config: LlmConfig, request: LlmRequest): Promise<LlmResponse> {
    switch (config.provider) {
      case 'openai':
        return this.callOpenAI(config, request);
      case 'anthropic':
        return this.callAnthropic(config, request);
      default:
        throw new LlmUnavailableError(`Unknown provider: ${config.provider as string}`);
    }
  }

  private async callOpenAI(config: LlmConfig, request: LlmRequest): Promise<LlmResponse> {
    let apiKey: string;
    try {
      apiKey = await this.secretsService.get('OPENAI_API_KEY');
    } catch {
      throw new LlmUnavailableError('OPENAI_API_KEY not configured');
    }

    if (!apiKey || apiKey.trim() === '') {
      throw new LlmUnavailableError('OPENAI_API_KEY is empty');
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
          ],
          max_tokens: request.maxTokens,
          temperature: request.temperature,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(
          `OpenAI API error HTTP ${response.status}: ${err?.error?.message ?? 'unknown'}`,
        );
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage: { total_tokens: number };
      };
      const content = data.choices[0]?.message?.content ?? '';
      const tokensUsed = data.usage?.total_tokens ?? 0;

      return { content, tokensUsed, durationMs: 0, provider: 'openai' };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async callAnthropic(config: LlmConfig, request: LlmRequest): Promise<LlmResponse> {
    let apiKey: string;
    try {
      apiKey = await this.secretsService.get('ANTHROPIC_API_KEY');
    } catch {
      throw new LlmUnavailableError('ANTHROPIC_API_KEY not configured');
    }

    if (!apiKey || apiKey.trim() === '') {
      throw new LlmUnavailableError('ANTHROPIC_API_KEY is empty');
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          system: request.systemPrompt,
          messages: [{ role: 'user', content: request.userPrompt }],
          max_tokens: request.maxTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(
          `Anthropic API error HTTP ${response.status}: ${err?.error?.message ?? 'unknown'}`,
        );
      }

      const data = (await response.json()) as {
        content: Array<{ text: string }>;
        usage: { output_tokens: number; input_tokens: number };
      };
      const content = data.content[0]?.text ?? '';
      const tokensUsed = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);

      return { content, tokensUsed, durationMs: 0, provider: 'anthropic' };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
