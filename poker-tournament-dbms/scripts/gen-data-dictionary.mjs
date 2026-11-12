#!/usr/bin/env node
/**
 * scripts/gen-data-dictionary.mjs — build docs/DATA_DICTIONARY.md from the
 * LIVE schema, so the document can never drift from the database.
 *
 *   node scripts/gen-data-dictionary.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from './load-env.mjs';

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'docs', 'DATA_DICTIONARY.md');

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

/** Human descriptions for columns the schema comments do not cover. */
const NOTES = {
  'app_user.password_hash': 'bcrypt hash, cost 10. Plaintext is never stored.',
  'app_user.role': 'ADMIN | DIRECTOR | PLAYER — drives application and database role selection.',
  'player.lifetime_earnings': 'Maintained by trigger tr_sync_player_earnings; never written by hand.',
  'player.date_of_birth': 'age is DERIVED from this by fn_player_age(); age is never stored.',
  'player_phone.phone': 'Partial key. Realises the multivalued ER attribute "phone".',
  'tournament.rake_pct': 'House fee. Makes prize_pool genuinely derivable.',
  'tournament.entrants_count': 'Maintained by trigger tr_entrants_count; the field-cap CHECK depends on it.',
  'blind_level.level_no': 'Partial key — meaningless without its tournament.',
  'payout_tier.rank_from': 'Partial key.',
  'poker_table.table_no': 'Partial key. table_id is a surrogate so child rows get a single-column FK.',
  'registration.eliminated_by_reg_id': 'Self-referencing FK. Basis of the recursive elimination-chain query.',
  'registration.entry_no': 'Distinguishes re-entries by the same player in one tournament.',
  'registration.chip_stack': 'Live stack during play; snapshots per level live in chip_count_log.',
  'seat_assignment.vacated_at': 'NULL means the seat is occupied NOW. Partial unique indexes depend on this.',
  'hand_player.net_result': 'GENERATED column (chips_after - chips_before). Cannot drift.',
  'hand_summary.embedding': '256-dimension L2-normalised vector; HNSW index with vector_cosine_ops.',
  'hand_summary.search_tsv': 'GENERATED tsvector for lexical search; GIN indexed.',
  'hand_summary.metadata': 'JSONB facets used to pre-filter before the ANN ordering.',
  'hand_summary.token_count': 'Recomputed by trigger tr_summary_touch on every write.',
  'audit_log.old_data': 'JSONB image of the row before the change.',
  'audit_log.new_data': 'JSONB image of the row after the change.',
};

const TABLE_PURPOSE = {
  app_user: 'Authentication identity for every human using the system.',
  player: 'Competitor domain identity. 1:1 optional with app_user.',
  player_phone: 'WEAK. Multivalued attribute "phone" realised as its own relation.',
  staff: 'Dealers, floor managers and tournament directors.',
  venue: 'Physical card room hosting tournaments.',
  season: 'Named competitive period grouping tournaments.',
  tournament: 'The central event entity.',
  blind_level: 'WEAK. Blind structure; PK (tournament_id, level_no).',
  payout_tier: 'WEAK. Prize ladder; PK (tournament_id, rank_from).',
  registration: 'PIVOT ENTITY. One entry by one player into one tournament.',
  tournament_transaction: 'WEAK. Money in and out, tied to an entry.',
  poker_table: 'WEAK. A physical table within one tournament.',
  seat_assignment: 'Which entry occupies which seat, and when.',
  chip_count_log: 'Stack snapshot per entry per blind level.',
  hand: 'One dealt hand.',
  hand_player: 'ASSOCIATIVE. Resolves M:N between registration and hand.',
  hand_action: 'WEAK. Every bet, call, raise and fold. Largest table.',
  hand_summary: 'VECTOR LAYER. Narrative + embedding + metadata, 1:1 with hand.',
  audit_log: 'Append-only trail written by triggers. Deliberately has no FK.',
};

const client = new pg.Client(config());

async function main() {
  await client.connect();

  const { rows: tables } = await client.query(`
    SELECT c.relname AS table_name,
           obj_description(c.oid) AS table_comment,
           (SELECT COUNT(*) FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)::int AS n_cols
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`);

  const { rows: cols } = await client.query(`
    SELECT c.relname AS table_name, a.attname AS column_name, a.attnum,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null,
           pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
           a.attgenerated <> '' AS is_generated,
           col_description(c.oid, a.attnum) AS col_comment
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum`);

  const { rows: keys } = await client.query(`
    SELECT r.relname AS table_name, c.contype,
           c.conname,
           -- cast to text[]: the pg driver does not parse the name[] type
           ARRAY(SELECT a.attname::text FROM pg_attribute a
                  WHERE a.attrelid = r.oid AND a.attnum = ANY(c.conkey)
                  ORDER BY array_position(c.conkey, a.attnum))::text[] AS cols,
           CASE WHEN c.contype = 'f'
                THEN (SELECT rf.relname FROM pg_class rf WHERE rf.oid = c.confrelid)
           END AS ref_table,
           pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = 'public'
     ORDER BY r.relname, c.contype`);

  const { rows: idx } = await client.query(`
    SELECT tablename, indexname, indexdef FROM pg_indexes
     WHERE schemaname='public' ORDER BY tablename, indexname`);

  const { rows: counts } = await client.query(`
    SELECT relname AS table_name, n_live_tup::int AS rows
      FROM pg_stat_user_tables ORDER BY relname`);
  const rowCount = Object.fromEntries(counts.map((r) => [r.table_name, r.rows]));

  const keyOf = (t) => keys.filter((k) => k.table_name === t);

  const md = [];
  md.push('# Data dictionary');
  md.push('');
  md.push('> Generated directly from the live PostgreSQL schema by');
  md.push('> `node scripts/gen-data-dictionary.mjs`, so it cannot drift from');
  md.push('> the database. Regenerate after any schema change.');
  md.push('');
  md.push(`**${tables.length} tables · ${cols.length} columns · ${keys.length} constraints · ${idx.length} indexes**`);
  md.push('');
  md.push('## Table index');
  md.push('');
  md.push('| Table | Purpose | Columns | Rows |');
  md.push('|---|---|---:|---:|');
  for (const t of tables) {
    md.push(`| [\`${t.table_name}\`](#${t.table_name.replace(/_/g, '')}) | ${TABLE_PURPOSE[t.table_name] ?? t.table_comment ?? ''} | ${t.n_cols} | ${rowCount[t.table_name] ?? 0} |`);
  }
  md.push('');
  md.push('### Key to the Keys column');
  md.push('');
  md.push('`PK` primary key · `FK` foreign key · `UK` part of a unique constraint · `GEN` generated column');
  md.push('');
  md.push('---');
  md.push('');

  for (const t of tables) {
    const tk = keyOf(t.table_name);
    const pk = tk.find((k) => k.contype === 'p');
    const fks = tk.filter((k) => k.contype === 'f');
    const uks = tk.filter((k) => k.contype === 'u');
    const cks = tk.filter((k) => k.contype === 'c');

    md.push(`## ${t.table_name}`);
    md.push('');
    md.push(TABLE_PURPOSE[t.table_name] ?? t.table_comment ?? '');
    md.push('');
    if (t.table_comment && TABLE_PURPOSE[t.table_name]) {
      md.push(`*${t.table_comment}*`);
      md.push('');
    }

    md.push('| # | Column | Type | Null | Default | Keys | Notes |');
    md.push('|---:|---|---|---|---|---|---|');

    for (const c of cols.filter((x) => x.table_name === t.table_name)) {
      const flags = [];
      if (pk && pk.cols.includes(c.column_name)) flags.push('PK');
      for (const f of fks) {
        if (f.cols.includes(c.column_name)) flags.push(`FK→${f.ref_table}`);
      }
      if (uks.some((u) => u.cols.includes(c.column_name))) flags.push('UK');
      if (c.is_generated) flags.push('GEN');

      const note = NOTES[`${t.table_name}.${c.column_name}`] ?? c.col_comment ?? '';
      const def = c.default_expr
        ? `\`${String(c.default_expr).replace(/\|/g, '\\|').slice(0, 34)}\``
        : '';

      md.push(`| ${c.attnum} | \`${c.column_name}\` | \`${c.data_type}\` | ${c.not_null ? 'NO' : 'YES'} | ${def} | ${flags.join(' ')} | ${note.replace(/\|/g, '\\|')} |`);
    }
    md.push('');

    if (pk) {
      md.push(`**Primary key:** (${pk.cols.map((x) => `\`${x}\``).join(', ')})`);
      md.push('');
    }
    if (uks.length) {
      md.push('**Unique constraints:**');
      md.push('');
      for (const u of uks) md.push(`- \`${u.conname}\` — (${u.cols.map((x) => `\`${x}\``).join(', ')})`);
      md.push('');
    }
    if (fks.length) {
      md.push('**Foreign keys:**');
      md.push('');
      for (const f of fks) {
        md.push(`- \`${f.conname}\` — (${f.cols.map((x) => `\`${x}\``).join(', ')}) → \`${f.ref_table}\`` +
          `${/ON DELETE (\w+ ?\w*)/.exec(f.definition) ? `, ON DELETE ${/ON DELETE (\w+ ?\w*)/.exec(f.definition)[1]}` : ''}`);
      }
      md.push('');
    }
    if (cks.length) {
      md.push('**Check constraints:**');
      md.push('');
      for (const c of cks) {
        md.push(`- \`${c.conname}\` — \`${c.definition.replace(/^CHECK /, '').replace(/\|/g, '\\|').slice(0, 170)}\``);
      }
      md.push('');
    }

    const ti = idx.filter((i) => i.tablename === t.table_name);
    if (ti.length) {
      md.push('**Indexes:**');
      md.push('');
      for (const i of ti) {
        const kind = i.indexdef.includes('hnsw') ? 'HNSW'
          : i.indexdef.includes('USING gin') ? 'GIN'
            : i.indexdef.includes(' WHERE ') ? 'B-tree (partial)'
              : i.indexdef.includes('UNIQUE') ? 'B-tree (unique)' : 'B-tree';
        md.push(`- \`${i.indexname}\` — ${kind}`);
      }
      md.push('');
    }

    md.push('---');
    md.push('');
  }

  fs.writeFileSync(OUT, md.join('\n'));
  console.log(`Wrote ${OUT}`);
  console.log(`  ${tables.length} tables, ${cols.length} columns, ${keys.length} constraints`);
  await client.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
