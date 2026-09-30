import { Pool } from 'pg';
import { config } from './config.js';

// Neon requires SSL. `rejectUnauthorized: false` is the standard approach for
// managed Postgres providers whose certs aren't in Node's default trust store —
// the connection is still encrypted, this just skips strict cert-chain validation.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 10, // keep the pool small — free-tier Postgres has limited concurrent connections
  connectionTimeoutMillis: 10_000,
  query_timeout: 15_000,
  statement_timeout: 15_000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
});
