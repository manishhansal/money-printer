/**
 * JwtStrategy — Passport JWT strategy for RS256 token validation.
 *
 * Verifies the Bearer token signature using the RS256 public key from the
 * `JWT_PUBLIC_KEY` environment variable (PEM format).  After signature
 * verification, it validates that the referenced session is still active in
 * `BrokerSessions` (guards against tokens that are structurally valid but
 * belong to an invalidated/logged-out session).
 *
 * Requirements: 1.7 (session token ≤ 30 min), 2.5 (HTTPS + auth)
 */

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BrokerSessions } from '../../database/entities/broker-sessions.entity';

/** Shape of the JWT payload issued by AuthService. */
export interface JwtPayload {
  /** Subject — the application user ID (`BrokerAccounts.userId`). */
  sub: string;
  /** Dhan client identifier (`BrokerAccounts.clientId`). */
  clientId: string;
  /** Session ID — `BrokerSessions.id` used to check liveness on every request. */
  sid: string;
  /** Issued-at Unix timestamp (seconds). */
  iat: number;
  /** Expiry Unix timestamp (seconds). */
  exp: number;
}

/**
 * Normalise a PEM string sourced from an environment variable.
 *
 * Dotenv stores unquoted multi-line values with literal `\n` escape sequences.
 * This helper converts them to real newlines so `jsonwebtoken` can parse the
 * PEM correctly.
 */
function normalisePem(raw: string): string {
  return raw.replace(/\\n/g, '\n').replace(/\\r/g, '');
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectRepository(BrokerSessions)
    private readonly brokerSessionsRepo: Repository<BrokerSessions>,
  ) {
    const rawPublicKey = configService.getOrThrow<string>('JWT_PUBLIC_KEY');

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // RS256 public key for signature verification — never the private key.
      secretOrKey: normalisePem(rawPublicKey),
      // Explicitly restrict to RS256; prevents algorithm-confusion attacks
      // where an attacker downgrades to HS256 and uses the public key as the
      // HMAC secret.
      algorithms: ['RS256'],
      ignoreExpiration: false,
    });
  }

  /**
   * Called by Passport after a successful signature and expiry check.
   *
   * Performs the additional liveness check: the session referenced by the
   * `sid` claim must still be active in `BrokerSessions`.  This ensures that
   * logout and session invalidation are respected even within the token's
   * validity window.
   *
   * @param payload  Decoded, verified JWT payload.
   * @returns        The same payload — it becomes `request.user` in controllers.
   */
  async validate(payload: JwtPayload): Promise<JwtPayload> {
    const session = await this.brokerSessionsRepo.findOne({
      where: { id: payload.sid, isActive: true },
    });

    if (!session) {
      throw new UnauthorizedException('Session is no longer active');
    }

    return payload;
  }
}
