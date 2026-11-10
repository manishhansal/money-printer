/**
 * TypeORM DataSource — used by both the NestJS runtime and the TypeORM CLI
 * (migration:generate, migration:run, migration:revert).
 *
 * The default export is the DataSource instance required by the CLI.
 * The named export `dataSourceOptions` is consumed by AppModule so the
 * NestJS TypeORM module shares the same configuration.
 */

import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { join } from 'path';
import * as dotenv from 'dotenv';

// Load .env when the file is executed directly by the TypeORM CLI (ts-node context).
// In the NestJS runtime, ConfigModule handles this; the dotenv.config() call is a no-op.
dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL environment variable is required. ' +
      'Set it in .env or export it before running migrations.',
  );
}

/**
 * Shared TypeORM configuration options.
 *
 * UUID strategy: TypeORM generates UUIDs in TypeScript via the `uuid` package
 * (@PrimaryGeneratedColumn('uuid')).  The Docker init script also enables the
 * PostgreSQL `uuid-ossp` extension so uuid_generate_v4() is available as a
 * column default for any raw SQL migrations that prefer it.
 */
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: databaseUrl,

  // Entity discovery — glob covers both ts-node (*.ts) and compiled (*.js) contexts.
  entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],

  // Migration files live in `src/migrations/` (compiled to `dist/migrations/`).
  // Using one level up from __dirname covers both ts-node (src/database → src/migrations)
  // and the compiled runtime (dist/database → dist/migrations).
  migrations: [join(__dirname, '..', 'migrations', '*.{ts,js}')],

  // ALWAYS false — schema changes are managed exclusively through migrations.
  synchronize: false,

  // Do not auto-run pending migrations on startup; run them explicitly with
  // `npm run migration:run` before deploying a new version.
  migrationsRun: false,

  // Log queries in development; suppress in production to avoid leaking data.
  logging: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],

  // Driver-level connection timeout (pg pool).
  // Complements the application-level 10-second startup guard in main.ts.
  extra: {
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    max: 10,
    min: 2,
  },

  // TLS/SSL: enable when connecting to a managed cloud PostgreSQL instance.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
};

/**
 * Exported DataSource instance.
 * The TypeORM CLI (`migration:generate`, `migration:run`, etc.) requires a
 * default-exported DataSource from the file passed via the `-d` flag.
 */
const AppDataSource = new DataSource(dataSourceOptions);
export default AppDataSource;
