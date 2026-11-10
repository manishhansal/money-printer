import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial migration — enables PostgreSQL extensions required by the platform.
 *
 * uuid-ossp: provides uuid_generate_v4() as an alternative UUID default for
 *            columns that prefer database-generated UUIDs over TypeScript-generated ones.
 *
 * pgcrypto:  provides gen_random_uuid() and cryptographic functions used by
 *            field-level AES-256-GCM encryption in later migrations.
 *
 * Note: TypeORM entities use @PrimaryGeneratedColumn('uuid') which generates
 * UUIDs in TypeScript via the `uuid` package.  These extensions are provided
 * as a foundation for any raw SQL that prefers database-side generation.
 */
export class EnablePostgresExtensions1700000000000 implements MigrationInterface {
  public readonly name = 'EnablePostgresExtensions1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Extensions are shared infrastructure; dropping them in a revert is
    // intentionally skipped to avoid breaking other database objects.
    // To remove them, do so manually with: DROP EXTENSION IF EXISTS "uuid-ossp";
  }
}
