/**
 * AuthModule — NestJS module for authentication and session management.
 *
 * Provides:
 *  - `AuthController`  — 4 REST endpoints (login, refresh, logout, status)
 *  - `AuthService`     — business logic, JWT issuance, audit logging
 *  - `JwtStrategy`     — Passport RS256 JWT verification strategy
 *  - `JwtAuthGuard`    — guard for protecting endpoints in any importing module
 *
 * JWT configuration:
 *  - Algorithm: RS256
 *  - Private key: `JWT_PRIVATE_KEY` env (PEM — used for signing)
 *  - Public key:  `JWT_PUBLIC_KEY`  env (PEM — used for verification)
 *  - Max validity: `JWT_EXPIRY_SECONDS` env (default 1800, hard ceiling 1800 s)
 *
 * Database access: `BrokerAccounts`, `BrokerSessions`, `AuditLogs`
 * Redis access: provided globally by `RedisModule` (reads `trading:armed_state`)
 *
 * Requirements: 1.7, 1.8, 2.5, 16.9
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { BrokerAccounts } from '../../database/entities/broker-accounts.entity';
import { BrokerSessions } from '../../database/entities/broker-sessions.entity';
import { AuditLogs } from '../../database/entities/audit-logs.entity';

/**
 * Normalise a PEM string sourced from an environment variable.
 * Converts literal `\n` escape sequences to real newlines so that
 * `jsonwebtoken` can parse the PEM header/footer lines correctly.
 */
function normalisePem(raw: string): string {
  return raw.replace(/\\n/g, '\n').replace(/\\r/g, '');
}

@Module({
  imports: [
    ConfigModule,

    // Passport with JWT as the default strategy.
    PassportModule.register({ defaultStrategy: 'jwt' }),

    // JwtModule configured asynchronously so ConfigService is available.
    // The module signs tokens with the RS256 private key and the strategy
    // verifies them with the RS256 public key.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // Retrieve and normalise keys — PEM values may have literal `\n` when
        // set as single-line strings in .env files.
        const privateKey = normalisePem(config.getOrThrow<string>('JWT_PRIVATE_KEY'));
        const publicKey = normalisePem(config.getOrThrow<string>('JWT_PUBLIC_KEY'));

        // Cap expiry at 1800 s (30 minutes) — requirement 1.7.
        const configured = parseInt(config.get<string>('JWT_EXPIRY_SECONDS', '1800'), 10);
        const expirySeconds = Math.min(isNaN(configured) ? 1800 : configured, 1800);

        return {
          privateKey,
          publicKey,
          signOptions: {
            algorithm: 'RS256',
            expiresIn: expirySeconds,
          },
        };
      },
    }),

    // TypeORM repositories for credential lookup, session management, and audit
    TypeOrmModule.forFeature([BrokerAccounts, BrokerSessions, AuditLogs]),
  ],

  controllers: [AuthController],

  providers: [
    AuthService,
    JwtStrategy,
    // JwtAuthGuard is listed here so NestJS injects its dependencies
    // (AuditLogs repo + JwtService) at module initialisation time.
    JwtAuthGuard,
  ],

  // Export AuthService and JwtAuthGuard so other NestJS modules can:
  //  - Import AuthModule and use @UseGuards(JwtAuthGuard) on their controllers
  //  - Inject AuthService for cross-module auth operations
  // Export JwtModule so importing modules can inject JwtService if needed.
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
