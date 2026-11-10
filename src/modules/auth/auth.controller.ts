/**
 * AuthController — exposes the four auth endpoints required by the CloudEngine
 * and consumed exclusively by the Chrome Extension.
 *
 * Endpoints:
 *  POST /auth/login    — credential exchange → session JWT
 *  POST /auth/refresh  — token rotation (requires valid JWT)
 *  POST /auth/logout   — session invalidation (requires valid JWT) → 204
 *  GET  /auth/status   — current auth + arming status (requires valid JWT)
 *
 * All requests go over HTTPS (enforced at the load balancer / TLS terminator).
 *
 * Requirements: 1.7, 1.8, 2.5, 16.9
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { AuthService, LoginResult, AuthStatusResult } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './jwt.strategy';

/** Express request augmented with the Passport-populated `user` property. */
interface AuthenticatedRequest extends ExpressRequest {
  user: JwtPayload;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─── POST /auth/login ─────────────────────────────────────────────────────

  /**
   * Validates `clientId` + `apiKey` against BrokerAccounts.
   *
   * Returns `{ sessionToken, expiresAt }` on success.
   * Returns HTTP 401 with an error message on credential failure.
   *
   * The session token is a signed RS256 JWT valid for at most 30 minutes.
   * The `expiresAt` field (ISO 8601 UTC) allows the Extension to schedule
   * proactive token refresh before expiry (requirement 1.8).
   */
  @Post('login')
  async login(@Body() loginDto: LoginDto, @Request() req: ExpressRequest): Promise<LoginResult> {
    return this.authService.login(loginDto.clientId, loginDto.apiKey, req.ip);
  }

  // ─── POST /auth/refresh ───────────────────────────────────────────────────

  /**
   * Issues a replacement JWT for the current valid session.
   *
   * The old session is invalidated; a new BrokerSessions row is created.
   * Requires a valid (non-expired) JWT in the `Authorization: Bearer` header.
   */
  @UseGuards(JwtAuthGuard)
  @Post('refresh')
  async refresh(@Request() req: AuthenticatedRequest): Promise<LoginResult> {
    return this.authService.refresh(req.user, req.ip);
  }

  // ─── POST /auth/logout ────────────────────────────────────────────────────

  /**
   * Invalidates the current session.
   *
   * After a successful logout, any subsequent request bearing the same JWT
   * will be rejected with 401 because the session's `isActive` flag is false.
   *
   * Returns HTTP 204 No Content on success (even if the session was already
   * inactive — logout is idempotent from the client's perspective).
   */
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Request() req: AuthenticatedRequest): Promise<void> {
    await this.authService.logout(req.user, req.ip);
  }

  // ─── GET /auth/status ─────────────────────────────────────────────────────

  /**
   * Returns the current authentication and arming status.
   *
   * Response shape:
   *   `{ authenticated: boolean, armedState: string, sessionExpiresAt: ISO8601 }`
   *
   * `armedState` reflects the LiveEngine state from Redis.  It is always
   * `'DISARMED'` when the LiveEngine module has not yet been initialised.
   * The Extension uses this endpoint to synchronise its display state after
   * a Background Service Worker restart (requirement 1.3).
   */
  @UseGuards(JwtAuthGuard)
  @Get('status')
  async getStatus(@Request() req: AuthenticatedRequest): Promise<AuthStatusResult> {
    return this.authService.getStatus(req.user);
  }
}
