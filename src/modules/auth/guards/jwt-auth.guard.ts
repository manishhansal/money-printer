/**
 * JwtAuthGuard — NestJS guard that enforces JWT authentication on protected
 * endpoints via the Passport JWT strategy.
 *
 * In addition to standard authentication, this guard intercepts expired-token
 * errors and writes an `AuditLogs` record (requirement 16.9) so that every
 * token expiry event is captured with the user ID, session ID, and UTC
 * timestamp.  The audit write is fire-and-forget so it never delays the 401
 * response to the client.
 *
 * Requirements: 1.7, 1.8, 2.5, 16.9
 */

import { ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { AuditLogs } from '../../../database/entities/audit-logs.entity';
import { JwtPayload } from '../jwt.strategy';

// String-literal constants — mirrors AuditEventType / AuditOutcome from entity
const AUTH_EVENT_EXPIRY = 'TOKEN_EXPIRY' as const;
const AUTH_OUTCOME_FAILURE = 'FAILURE' as const;

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    @InjectRepository(AuditLogs)
    private readonly auditLogsRepo: Repository<AuditLogs>,
    private readonly jwtService: JwtService,
  ) {
    super();
  }

  /**
   * Called by Passport after the JWT strategy resolves (or fails).
   *
   * If the token has expired (`info.name === 'TokenExpiredError'`):
   *  1. Decodes the expired token without re-verification to extract user context.
   *  2. Writes a TOKEN_EXPIRY AuditLogs record (non-blocking).
   *  3. Throws 401 with an "expired" message so the Extension can re-authenticate.
   *
   * For other validation failures (missing token, bad signature, invalidated
   * session), a generic 401 is thrown without an audit record — those events
   * are not classified as "auth events" by the requirements (they are either
   * client errors or handled elsewhere in the login flow).
   */
  handleRequest<TUser = any>(
    err: Error | null,
    user: TUser,
    info: unknown,
    context: ExecutionContext,
  ): TUser {
    const infoError = info instanceof Error ? info : null;

    if (infoError?.name === 'TokenExpiredError') {
      this.recordTokenExpiryAudit(context);
      throw new UnauthorizedException('Token has expired — please re-authenticate');
    }

    if (err || !user) {
      throw err ?? new UnauthorizedException();
    }

    return user;
  }

  /**
   * Decodes the expired JWT (without signature verification) to retrieve the
   * user ID and session ID, then writes an async AuditLogs record.
   *
   * Failures are swallowed and logged — they must never surface as a 500
   * error since the primary response is already a 401.
   */
  private recordTokenExpiryAudit(context: ExecutionContext): void {
    try {
      const request = context.switchToHttp().getRequest<Request>();
      const authHeader = request.headers?.authorization;

      if (!authHeader?.startsWith('Bearer ')) {
        return;
      }

      const token = authHeader.slice(7);
      const decoded = this.jwtService.decode(token) as Partial<JwtPayload> | null;

      if (!decoded?.sub) {
        return;
      }

      const log = this.auditLogsRepo.create({
        userId: decoded.sub,
        eventType: AUTH_EVENT_EXPIRY,
        timestamp: new Date(),
        outcome: AUTH_OUTCOME_FAILURE,
        ipAddress: request.ip ?? null,
        previousValue: null,
        newValue: null,
        metadata: {
          sessionId: decoded.sid ?? null,
          reason: 'token expired',
        },
      });

      // Fire-and-forget — the 401 response must not be delayed by the DB write.
      void this.auditLogsRepo.save(log).catch((saveErr: Error) => {
        this.logger.error(
          `Failed to write TOKEN_EXPIRY audit log for user ${decoded.sub}: ${saveErr.message}`,
        );
      });
    } catch (decodeErr) {
      this.logger.warn(
        `Could not decode expired token for audit logging: ${(decodeErr as Error).message}`,
      );
    }
  }
}
