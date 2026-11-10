-- PostgreSQL initialisation script for MoneyPrinter local development.
-- Runs once when the postgres container is first created.

-- Enable uuid-ossp so uuid_generate_v4() is available as a column default.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable pg_crypto for any AES-256-GCM encryption needs at the DB layer.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
