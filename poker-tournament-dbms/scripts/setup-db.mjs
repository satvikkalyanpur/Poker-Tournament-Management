#!/usr/bin/env node
/**
 * scripts/setup-db.mjs — execute every DDL file in order.
 *
 *   npm run db:setup
 *
 * Each file is run inside its own transaction, so a syntax error in one
 * file cannot leave the schema half-applied.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from './load-env.mjs';

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, '..', 'db');

const FILES = [
  '01_schema.sql',
  '02_indexes.sql',
  '03_functions_triggers.sql',
  '04_views.sql',
  '05_procedures.sql',
  '06_roles_rbac.sql',
  '07_seed_reference.sql',
];

function config() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? '',
    database: process.env.PGDATABASE ?? 'pokerdb',
  };
}

async function main() {
  const client = new pg.Client(config());

  try {
    await client.connect();
  } catch (err) {
    console.error('\n  Could not connect to PostgreSQL.\n');
    console.error(`  ${err.message}\n`);
    console.error('  Check that the server is running and that .env.local is correct.');
    console.error('  See HowToRun.md, section "Database setup".\n');
    process.exit(1);
  }

  const { rows } = await client.query('SELECT current_database() AS db, version() AS v');
  console.log(`\nConnected to "${rows[0].db}"`);
  console.log(`${rows[0].v.split(',')[0]}\n`);

  let totalStatements = 0;

  for (const file of FILES) {
    const full = path.join(DB_DIR, file);
    if (!fs.existsSync(full)) {
      console.log(`  skip   ${file} (not present)`);
      continue;
    }
    const sql = fs.readFileSync(full, 'utf8');
    const started = Date.now();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      const stmts = (sql.match(/;\s*$/gm) ?? []).length;
      totalStatements += stmts;
      console.log(`  ok     ${file.padEnd(28)} ${String(Date.now() - started).padStart(5)} ms`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`\n  FAILED ${file}`);
      console.error(`  ${err.message}`);
      if (err.position) {
        const upto = sql.slice(0, Number(err.position));
        console.error(`  near line ${upto.split('\n').length}`);
      }
      await client.end();
      process.exit(1);
    }
  }

  const summary = await client.query(`
    SELECT
      (SELECT count(*) FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE')       AS tables,
      (SELECT count(*) FROM information_schema.views
        WHERE table_schema='public')                                   AS views,
      (SELECT count(*) FROM pg_matviews WHERE schemaname='public')     AS matviews,
      (SELECT count(*) FROM pg_indexes WHERE schemaname='public')      AS indexes,
      (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)         AS triggers,
      -- exclude functions owned by extensions (pgvector ships ~70 of them)
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prokind='f'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.objid = p.oid AND d.deptype = 'e'))  AS functions,
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prokind='p')                    AS procedures,
      (SELECT count(*) FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
        JOIN pg_namespace n ON n.oid=r.relnamespace
        WHERE n.nspname='public' AND c.contype='c')                    AS checks,
      (SELECT count(*) FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
        JOIN pg_namespace n ON n.oid=r.relnamespace
        WHERE n.nspname='public' AND c.contype='f')                    AS foreign_keys
  `);

  const s = summary.rows[0];
  console.log('\n  Schema objects created');
  console.log('  ----------------------------------------');
  console.log(`    tables ................ ${s.tables}`);
  console.log(`    views ................. ${s.views}`);
  console.log(`    materialized views .... ${s.matviews}`);
  console.log(`    indexes ............... ${s.indexes}`);
  console.log(`    triggers .............. ${s.triggers}`);
  console.log(`    functions ............. ${s.functions}`);
  console.log(`    procedures ............ ${s.procedures}`);
  console.log(`    check constraints ..... ${s.checks}`);
  console.log(`    foreign keys .......... ${s.foreign_keys}`);
  console.log(`    statements executed ... ~${totalStatements}`);
  console.log('\n  Next step:  npm run db:seed\n');

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
