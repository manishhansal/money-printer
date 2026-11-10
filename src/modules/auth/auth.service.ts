/**
 * AuthService — business logic for all authentication operations.
 *
 * Responsibilities:
 *  - Validate credentials against BrokerAccounts
 *  - Issue RS256 JWTs capped at JWT_EXPIRY_SECONDS (max 1800 s = 30 min)
 *  - Manage BrokerSessions lifecycle (create, refresh, invalidate)
 *  - Write an AuditLogs record for every auth event (login, logout, failure,
 *    token refresh, token expiry)
 *  - Return current auth status including the armedState from Redis
 *
 * Requirements: 1.7, 1.8, 2.5, 16.9
 */

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { BrokerAccounts } from '../../database/entities/broker-accounts.entity';
import { BrokerSessions } from '../../database/entities/broker-sessions.entity';
import { AuditLogs } from '../../database/entities/audit-logs.entity';
import { JwtPayload } from './jwt.strategy';
import { RedisService } from '../redis/redis.service';

// String-literal constants for audit log fields — avoids enum runtime issues
// across TypeScript/ts-jest version combinations.  Values must stay in sync
// with the AuditEventType and AuditOutcome declarations in audit-logs.entity.ts.
const AUTH_EVENT = {
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  LOGIN_FAILURE: 'LOGIN_FAILURE',
  TOKEN_REFRESH: 'TOKEN_REFRESH',
  TOKEN_EXPIRY: 'TOKEN_EXPIRY',
} as const;

const AUTH_OUTCOME = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
} as const;

// ─── Response shapes ──────────────────────────────────────────────────────────

export interface LoginResult {
  /** Signed RS256 JWT — returned to the Extension as the session token. */
  sessionToken: string;
  /** UTC ISO 8601 expiry time so the Extension can schedule re-authentication. */
  expiresAt: string;
}

export interface AuthStatusResult {
  /** Whether the presented JWT corresponds to an active session. */
  authenticated: boolean;
  /**
   * Current arming state of the LiveEngine.
   * Sourced from the `trading:armed_state` Redis key.
   * Defaults to `'DISARMED'` when the key is absent.
   */
  armedState: string;
  /** ISO 8601 UTC expiry of the current session. */
  sessionExpiresAt: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * Effective token validity in seconds.
   * Computed once at construction time; capped at 1800 (30 minutes).
   */
  readonly expirySeconds: number;

  constructor(
    @InjectRepository(BrokerAccounts)
    private readonly brokerAccountsRepo: Repository<BrokerAccounts>,
    @InjectRepository(BrokerSessions)
    private readonly brokerSessionsRepo: Repository<BrokerSessions>,
    @InjectRepository(AuditLogs)
    private readonly auditLogsRepo: Repository<AuditLogs>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    const configured = parseInt(this.configService.get<string>('JWT_EXPIRY_SECONDS', '1800'), 10);
    // Hard ceiling: token validity never exceeds 30 minutes (requirement 1.7)
    this.expirySeconds = Math.min(isNaN(configured) ? 1800 : configured, 1800);
  }

  // ─── login ─────────────────────────────────────────────────────────────────

  /**
   * Validates `clientId` + `apiKey` against BrokerAccounts, creates a new
   * BrokerSessions record, and returns a signed JWT.
   *
   * On credential failure: writes a LOGIN_FAILURE audit record and throws 401.
   * On success: writes a LOGIN audit record.
   */
  async login(clientId: string, apiKey: string, ipAddress?: string): Promise<LoginResult> {
    // Look up the active broker account by clientId.
    const account = await this.brokerAccountsRepo.findOne({
      where: { clientId, isActive: true },
    });

    // Constant-time comparison is not critical here because BrokerAccounts rows
    // are internal application credentials (not user passwords), but we still
    // validate both fields before deciding outcome.
    const credentialsValid = account !== null && account.apiKey === apiKey;

    if (!credentialsValid) {
      await this.writeAuditLog({
        userId: account?.userId ?? 'unknown',
        eventType: AUTH_EVENT.LOGIN_FAILURE,
        outcome: AUTH_OUTCOME.FAILURE,
        ipAddress,
        metadata: { reason: 'invalid credentials', clientId },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    // ── Create a BrokerSessions placeholder ──────────────────────────────────
    const expiresAt = new Date(Date.now() + this.expirySeconds * 1_000);

    // Use a placeholder so the row exists before we sign the JWT.
    // We update it with the real token once signing completes.
    const sessionPlaceholder = this.brokerSessionsRepo.create({
      brokerAccountId: account.id,
      sessionToken: '__pending__',
      expiresAt,
      isActive: true,
    });
    const savedSession = await this.brokerSessionsRepo.save(sessionPlaceholder);

    // ── Sign JWT ─────────────────────────────────────────────────────────────
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: account.userId,
      clientId: account.clientId,
      sid: savedSession.id,
    };

    const token = await this.jwtService.signAsync(payload, {
      expiresIn: this.expirySeconds,
    });

    // Persist the actual token (encrypted at rest via encryptedColumnTransformer)
    await this.brokerSessionsRepo.update(savedSession.id, { sessionToken: token });

    // ── Audit log ─────────────────────────────────────────────────────────────
    await this.writeAuditLog({
      userId: account.userId,
      eventType: AUTH_EVENT.LOGIN,
      outcome: AUTH_OUTCOME.SUCCESS,
      ipAddress,
      metadata: { sessionId: savedSession.id },
    });

    return { sessionToken: token, expiresAt: expiresAt.toISOString() };
  }

  // ─── refresh ───────────────────────────────────────────────────────────────

  /**
   * Issues a replacement JWT for an already-validated (non-expired) session.
   *
   * The old session is invalidated before the new one is created, ensuring that
   * at most one active session exists per refresh cycle.
   */
  async refresh(jwtPayload: JwtPayload, ipAddress?: string): Promise<LoginResult> {
    // Verify the session is still active (strategy already checked this, but
    // we re-verify inside a transaction-like sequence to prevent TOCTOU).
    const oldSession = await this.brokerSessionsRepo.findOne({
      where: { id: jwtPayload.sid, isActive: true },
    });

    if (!oldSession) {
      await this.writeAuditLog({
        userId: jwtPayload.sub,
        eventType: AUTH_EVENT.TOKEN_REFRESH,
        outcome: AUTH_OUTCOME.FAILURE,
        ipAddress,
        metadata: { reason: 'session not found or already inactive', sessionId: jwtPayload.sid },
      });
      throw new UnauthorizedException('Session is no longer active');
    }

    // Invalidate the old session first
    await this.brokerSessionsRepo.update(oldSession.id, { isActive: false });

    // Create a new session
    const expiresAt = new Date(Date.now() + this.expirySeconds * 1_000);
    const newSessionPlaceholder = this.brokerSessionsRepo.create({
      brokerAccountId: oldSession.brokerAccountId,
      sessionToken: '__pending__',
      expiresAt,
      isActive: true,
    });
    const savedNewSession = await this.brokerSessionsRepo.save(newSessionPlaceholder);

    // Sign new JWT
    const newPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: jwtPayload.sub,
      clientId: jwtPayload.clientId,
      sid: savedNewSession.id,
    };

    const token = await this.jwtService.signAsync(newPayload, {
      expiresIn: this.expirySeconds,
    });

    await this.brokerSessionsRepo.update(savedNewSession.id, { sessionToken: token });

    await this.writeAuditLog({
      userId: jwtPayload.sub,
      eventType: AUTH_EVENT.TOKEN_REFRESH,
      outcome: AUTH_OUTCOME.SUCCESS,
      ipAddress,
      metadata: {
        oldSessionId: oldSession.id,
        newSessionId: savedNewSession.id,
      },
    });

    return { sessionToken: token, expiresAt: expiresAt.toISOString() };
  }

  // ─── logout ────────────────────────────────────────────────────────────────

  /**
   * Invalidates the current session referenced by the JWT's `sid` claim.
   *
   * Subsequent requests bearing the same JWT will be rejected by `JwtStrategy`
   * because the session's `isActive` flag is set to `false`.
   */
  async logout(jwtPayload: JwtPayload, ipAddress?: string): Promise<void> {
    const result = await this.brokerSessionsRepo.update(
      { id: jwtPayload.sid, isActive: true },
      { isActive: false },
    );

    const didInvalidate = (result.affected ?? 0) > 0;

    await this.writeAuditLog({
      userId: jwtPayload.sub,
      eventType: AUTH_EVENT.LOGOUT,
      outcome: didInvalidate ? AUTH_OUTCOME.SUCCESS : AUTH_OUTCOME.FAILURE,
      ipAddress,
      metadata: {
        sessionId: jwtPayload.sid,
        reason: didInvalidate ? undefined : 'session already inactive',
      },
    });
  }

  // ─── getStatus ─────────────────────────────────────────────────────────────

  /**
   * Returns the current authentication status for the caller.
   *
   * `armedState` is read from the `trading:armed_state` Redis key — this key
   * is managed by the LiveTradingModule.  It defaults to `'DISARMED'` when
   * absent so that auth/status responses are always valid even before the
   * LiveEngine module is initialised.
   */
  async getStatus(jwtPayload: JwtPayload): Promise<AuthStatusResult> {
    const session = await this.brokerSessionsRepo.findOne({
      where: { id: jwtPayload.sid, isActive: true },
    });

    const armedState = (await this.redisService.get('trading:armed_state')) ?? 'DISARMED';

    return {
      authenticated: session !== null,
      armedState,
      sessionExpiresAt: session ? session.expiresAt.toISOString() : new Date().toISOString(),
    };
  }

  // ─── recordTokenExpiry (called by JwtAuthGuard) ───────────────────────────

  /**
   * Records a TOKEN_EXPIRY audit event for an expired JWT.
   *
   * Called by `JwtAuthGuard` when passport-jwt rejects a structurally valid
   * but expired token.  The token is decoded without verification to extract
   * the user ID and session ID.
   *
   * This method is safe to call with arbitrary token strings — any decode or
   * DB error is caught and logged without re-throwing.
   */
  async recordTokenExpiry(rawToken: string, ipAddress?: string): Promise<void> {
    try {
      const decoded = this.jwtService.decode(rawToken) as Partial<JwtPayload> | null;
      if (!decoded?.sub) {
        return;
      }

      await this.writeAuditLog({
        userId: decoded.sub,
        eventType: AUTH_EVENT.TOKEN_EXPIRY,
        outcome: AUTH_OUTCOME.FAILURE,
        ipAddress,
        metadata: { sessionId: decoded.sid ?? null, reason: 'token expired' },
      });

      // Also mark the session as inactive if it is still flagged active
      if (decoded.sid) {
        await this.brokerSessionsRepo.update(
          { id: decoded.sid, isActive: true },
          { isActive: false },
        );
      }
    } catch (err) {
      this.logger.error(`recordTokenExpiry failed: ${(err as Error).message}`);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Writes a single row to `audit_logs`.
   *
   * Failures are caught and logged rather than re-thrown — an audit-log write
   * failure must never prevent the primary auth operation from completing.
   */
  private async writeAuditLog(params: {
    userId: string;
    eventType: string;
    outcome: string;
    ipAddress?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const log = this.auditLogsRepo.create({
        userId: params.userId,
        eventType: params.eventType,
        timestamp: new Date(),
        outcome: params.outcome,
        ipAddress: params.ipAddress ?? null,
        previousValue: null,
        newValue: null,
        metadata: params.metadata ?? null,
      });
      await this.auditLogsRepo.save(log);
    } catch (err) {
      // Audit failures are non-fatal but must be operator-visible.
      this.logger.error(
        `[AuditLog] Failed to write ${params.eventType} event for user ${params.userId}: ${(err as Error).message}`,
      );
    }
  }
}
