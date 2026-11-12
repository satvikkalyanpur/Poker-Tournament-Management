/**
 * lib/db.js — PostgreSQL connection pool and query helpers.
 *
 * Requirement 10: credentials come from environment variables only.
 * Nothing in this file (or anywhere in the repo) contains a real
 * password; .env.local is git-ignored and .env.example ships instead.
 */

import pg from 'pg';

const { Pool, types } = pg;

// Return NUMERIC as a JS number rather than a string so the UI can do
// arithmetic without parsing everywhere. Safe here: every monetary value
// in this schema is well inside IEEE-754 integer-exact range.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // bigint

let pool;

function buildConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PGPOOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    };
  }
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? '',
    database: process.env.PGDATABASE ?? 'pokerdb',
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

export function getPool() {
  if (!pool) {
    pool = new Pool(buildConfig());
    pool.on('error', (err) => {
      console.error('[db] idle client error:', err.message);
    });
  }
  return pool;
}

/**
 * Run a parameterised query.
 *
 * Every call site passes values as $1, $2 … placeholders. String
 * concatenation is never used to build SQL, which is what makes SQL
 * injection structurally impossible here (requirement 13).
 */
export async function query(text, params = []) {
  const started = Date.now();
  const res = await getPool().query(text, params);
  const ms = Date.now() - started;
  if (process.env.LOG_SQL === 'true') {
    console.log(`[sql ${ms}ms] ${text.split('\n')[0].slice(0, 90)}  rows=${res.rowCount}`);
  }
  return res;
}

export async function queryRows(text, params = []) {
  return (await query(text, params)).rows;
}

export async function queryOne(text, params = []) {
  const rows = await queryRows(text, params);
  return rows[0] ?? null;
}

/**
 * Run a function inside a single transaction.
 * Commits on success, rolls back on any thrown error.
 *
 * `role` escalates the connection to one of the database roles
 * (poker_admin / poker_director / poker_player) for the life of the
 * transaction only — SET LOCAL reverts automatically at COMMIT.
 * `playerId` feeds the row-level-security policy on registration.
 */
export async function withTransaction(fn, { role, playerId } = {}) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    if (role) {
      // role name is validated against an allow-list, never interpolated blind
      const allowed = ['poker_admin', 'poker_director', 'poker_player'];
      if (!allowed.includes(role)) throw new Error(`Unknown database role: ${role}`);
      await client.query(`SET LOCAL ROLE ${role}`);
    }
    if (playerId != null) {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_player_id',
        String(playerId),
      ]);
    }

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Map a PostgreSQL error to a clean HTTP-ish shape for the API layer. */
export function describeDbError(err) {
  const map = {
    23505: { status: 409, message: 'That record already exists.' },
    23503: { status: 409, message: 'Referenced record does not exist.' },
    23514: { status: 400, message: 'A database rule rejected this value.' },
    23502: { status: 400, message: 'A required field was missing.' },
    '42501': { status: 403, message: 'Your role is not permitted to do that.' },
    P0002: { status: 404, message: 'Record not found.' },
  };
  const hit = map[err.code];
  return {
    status: hit?.status ?? 500,
    message: err.message || hit?.message || 'Database error',
    code: err.code ?? null,
    constraint: err.constraint ?? null,
  };
}
