/**
 * AppController — root-level routes served by the CloudEngine.
 *
 *  GET /        → readiness probe (plain text)
 *  GET /health  → system health in NestJS Terminus format for the dashboard
 *
 * Note: /debug/scan and /debug/stats are handled by DebugController
 *       (src/modules/debug/debug.controller.ts) with TypeORM repo queries.
 *       The former raw-SQL versions in this file were removed to avoid
 *       duplicate route registrations.
 */

import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppService } from './app.service';
import { RedisService } from './modules/redis/redis.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly redisService: RedisService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** GET / — simple readiness probe used by load balancers and the dashboard. */
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * GET /health
   *
   * Returns system health in the NestJS Terminus format consumed by the
   * MoneyPrinter dashboard HTML (`fetchHealth()`):
   *
   * ```json
   * {
   *   "status": "ok" | "error",
   *   "info": {
   *     "postgresql_connection":   { "status": "up" | "down" },
   *     "redis_availability":      { "status": "up" | "down" },
   *     "dhan_api_connectivity":   { "status": "up" | "down" }
   *   }
   * }
   * ```
   *
   * - PostgreSQL: verified with `SELECT 1` on the active DataSource.
   * - Redis: verified with `RedisService.isHealthy()` (PING).
   * - Dhan API: reads the `health:dhan_api_connectivity` key written by
   *   SystemHealthMonitorService every 30 s. Falls back to `down` if key absent.
   */
  @Get('health')
  async getHealth(): Promise<{
    status: string;
    info: Record<string, { status: string }>;
  }> {
    // ── PostgreSQL ────────────────────────────────────────────────────────────
    let pgStatus = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      pgStatus = 'up';
    } catch {
      /* remain down */
    }

    // ── Redis ─────────────────────────────────────────────────────────────────
    let redisStatus = 'down';
    try {
      redisStatus = (await this.redisService.isHealthy()) ? 'up' : 'down';
    } catch {
      /* remain down */
    }

    // ── Dhan API — read Redis key written by SystemHealthMonitorService ───────
    let dhanStatus = 'down';
    try {
      const val = await this.redisService.get('health:dhan_api_connectivity');
      dhanStatus = val === 'Healthy' ? 'up' : 'down';
    } catch {
      /* remain down */
    }

    return {
      status: pgStatus === 'up' && redisStatus === 'up' ? 'ok' : 'error',
      info: {
        postgresql_connection: { status: pgStatus },
        redis_availability: { status: redisStatus },
        dhan_api_connectivity: { status: dhanStatus },
      },
    };
  }
}
