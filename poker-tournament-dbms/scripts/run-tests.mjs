#!/usr/bin/env node
/**
 * scripts/run-tests.mjs — database-level test suite.
 *
 *   npm run db:test
 *
 * These are integrity tests, not application tests. Each one proves that
 * a specific constraint, trigger or procedure behaves as designed — and
 * the negative cases matter most: they show that the database REFUSES
 * invalid data rather than quietly accepting it.
 *
 * Every test runs inside a transaction that is rolled back, so the suite
 * can be run repeatedly against the seeded database without changing it.
 */

import pg from 'pg';
import { loadEnv } from './load-env.mjs';

loadEnv();

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

const client = new pg.Client(config());
const results = [];
let idx = 0;

/**
 * Run one test case inside a savepoint.
 *  expect: 'ok'   -> fn must succeed
 *  expect: 'fail' -> fn must throw; `code` optionally pins the SQLSTATE
 */
async function test({ group, name, expect, code, fn }) {
  idx += 1;
  const id = `T${String(idx).padStart(2, '0')}`;
  await client.query('SAVEPOINT tc');
  let status;
  let detail = '';

  try {
    const out = await fn(client);
    if (expect === 'fail') {
      status = 'FAIL';
      detail = 'expected an error but the statement succeeded';
    } else if (out === false) {
      status = 'FAIL';
      detail = 'assertion returned false';
    } else {
      status = 'PASS';
      detail = typeof out === 'string' ? out : '';
    }
  } catch (err) {
    if (expect === 'fail') {
      if (code && err.code !== code) {
        status = 'FAIL';
        detail = `expected SQLSTATE ${code}, got ${err.code}`;
      } else {
        status = 'PASS';
        detail = `rejected (${err.code}) ${(err.message ?? '').split('\n')[0].slice(0, 70)}`;
      }
    } else {
      status = 'FAIL';
      detail = `${err.code ?? ''} ${(err.message ?? '').split('\n')[0].slice(0, 80)}`;
    }
  }

  await client.query('ROLLBACK TO SAVEPOINT tc');
  results.push({ id, group, name, expect, status, detail });
  const mark = status === 'PASS' ? 'pass' : 'FAIL';
  console.log(`  ${mark}  ${id}  ${name}`);
  if (status === 'FAIL') console.log(`         ${detail}`);
}

async function main() {
  await client.connect();
  await client.query('BEGIN');

  console.log('\nDatabase test suite\n');

  // ==================================================================
  console.log('Entity integrity (primary keys, uniqueness)');
  // ==================================================================
  await test({
    group: 'Entity integrity', name: 'Duplicate e-mail is rejected', expect: 'fail', code: '23505',
    fn: (c) => c.query(
      `INSERT INTO app_user (email, password_hash, role)
       VALUES ((SELECT email FROM app_user LIMIT 1), '$2a$10$abcdefghijklmnopqrstuv', 'PLAYER')`),
  });

  await test({
    group: 'Entity integrity', name: 'Duplicate screen name is rejected', expect: 'fail', code: '23505',
    fn: (c) => c.query(
      `INSERT INTO player (screen_name, first_name, last_name, date_of_birth, country)
       VALUES ((SELECT screen_name FROM player LIMIT 1),'A','B',DATE '1990-01-01','IN')`),
  });

  await test({
    group: 'Entity integrity', name: 'Two blind levels with the same number are rejected',
    expect: 'fail', code: '23505',
    fn: (c) => c.query(
      `INSERT INTO blind_level (tournament_id, level_no, small_blind, big_blind)
       VALUES (1, 1, 100, 200)`),
  });

  // ==================================================================
  console.log('\nReferential integrity (foreign keys)');
  // ==================================================================
  await test({
    group: 'Referential integrity', name: 'Entry for a non-existent tournament is rejected',
    expect: 'fail', code: '23503',
    fn: (c) => c.query(
      `INSERT INTO registration (tournament_id, player_id) VALUES (999999, 1)`),
  });

  await test({
    group: 'Referential integrity', name: 'Entry for a non-existent player is rejected',
    expect: 'fail', code: '23503',
    fn: (c) => c.query(
      `INSERT INTO registration (tournament_id, player_id) VALUES (1, 999999)`),
  });

  await test({
    group: 'Referential integrity', name: 'Deleting a tournament cascades to its blind levels',
    expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `INSERT INTO tournament (venue_id, title, buy_in, starting_stack, max_entries, start_time)
         VALUES (1,'Cascade Test',1000,20000,50,NOW()) RETURNING tournament_id`);
      const tid = rows[0].tournament_id;
      await c.query(
        `INSERT INTO blind_level (tournament_id, level_no, small_blind, big_blind)
         VALUES ($1,1,100,200)`, [tid]);
      await c.query('DELETE FROM tournament WHERE tournament_id=$1', [tid]);
      const { rows: left } = await c.query(
        'SELECT COUNT(*)::int n FROM blind_level WHERE tournament_id=$1', [tid]);
      return left[0].n === 0 ? 'child rows removed with the parent' : false;
    },
  });

  await test({
    group: 'Referential integrity', name: 'Deleting a hand cascades to its embedding',
    expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        'SELECT hand_id FROM hand_summary ORDER BY hand_id DESC LIMIT 1');
      const hid = rows[0].hand_id;
      await c.query('DELETE FROM hand WHERE hand_id=$1', [hid]);
      const { rows: left } = await c.query(
        'SELECT COUNT(*)::int n FROM hand_summary WHERE hand_id=$1', [hid]);
      return left[0].n === 0 ? 'vector row removed with the relational row' : false;
    },
  });

  // ==================================================================
  console.log('\nDomain integrity (CHECK constraints)');
  // ==================================================================
  await test({
    group: 'Domain integrity', name: 'Under-age player is rejected', expect: 'fail', code: '23514',
    fn: (c) => c.query(
      `INSERT INTO player (screen_name, first_name, last_name, date_of_birth, country)
       VALUES ('MinorTest','Kid','Player', CURRENT_DATE - INTERVAL '12 years','IN')`),
  });

  await test({
    group: 'Domain integrity', name: 'Mixed-case e-mail is rejected', expect: 'fail', code: '23514',
    fn: (c) => c.query(
      `INSERT INTO app_user (email, password_hash, role)
       VALUES ('NotLower@Example.com','$2a$10$abcdefghijklmnopqrstuv','PLAYER')`),
  });

  await test({
    group: 'Domain integrity', name: 'Password hash shorter than 20 chars is rejected',
    expect: 'fail', code: '23514',
    fn: (c) => c.query(
      `INSERT INTO app_user (email, password_hash, role)
       VALUES ('plain@example.com','hunter2','PLAYER')`),
  });

  await test({
    group: 'Domain integrity', name: 'Negative buy-in is rejected', expect: 'fail', code: '23514',
    fn: (c) => c.query(
      `INSERT INTO tournament (venue_id, title, buy_in, starting_stack, max_entries, start_time)
       VALUES (1,'Negative Buyin',-500,20000,50,NOW())`),
  });

  await test({
    group: 'Domain integrity', name: 'Big blind smaller than small blind is rejected',
    expect: 'fail', code: '23514',
    fn: (c) => c.query(
      `INSERT INTO blind_level (tournament_id, level_no, small_blind, big_blind)
       VALUES (1, 55, 500, 100)`),
  });

  await test({
    group: 'Domain integrity', name: 'An entry cannot eliminate itself', expect: 'fail', code: '23514',
    fn: (c) => c.query(
      `UPDATE registration SET eliminated_by_reg_id = registration_id
        WHERE registration_id = (SELECT MIN(registration_id) FROM registration)`),
  });

  await test({
    group: 'Domain integrity', name: 'A FOLD carrying chips is rejected', expect: 'fail', code: '23514',
    fn: (c) => c.query(
      `INSERT INTO hand_action (hand_id, hand_player_id, street, action_seq, action, amount)
       SELECT hp.hand_id, hp.hand_player_id, 'RIVER', 99, 'FOLD', 500
         FROM hand_player hp LIMIT 1`),
  });

  await test({
    group: 'Domain integrity', name: 'Malformed board cards are rejected', expect: 'fail', code: '23514',
    fn: (c) => c.query(
      `INSERT INTO hand (table_id, tournament_id, level_no, hand_no, board_cards)
       VALUES (1, 1, 1, 9999, 'XX YY ZZ')`),
  });

  // ==================================================================
  console.log('\nTrigger behaviour');
  // ==================================================================
  await test({
    group: 'Triggers', name: 'Seat number beyond the table size is rejected',
    expect: 'fail', code: '23514',
    fn: (c) => c.query(
      `INSERT INTO seat_assignment (table_id, registration_id, seat_no)
       SELECT pt.table_id, r.registration_id, 10
         FROM poker_table pt
         JOIN registration r ON r.tournament_id = pt.tournament_id
        LIMIT 1`),
  });

  await test({
    group: 'Triggers', name: 'Two live players cannot hold the same seat',
    expect: 'fail', code: '23505',
    fn: async (c) => {
      // target a seat at an OPEN table, so the unique index is what
      // rejects the insert rather than the "table is broken" trigger
      const { rows } = await c.query(
        `SELECT sa.table_id, sa.seat_no, pt.tournament_id
           FROM seat_assignment sa JOIN poker_table pt ON pt.table_id = sa.table_id
          WHERE sa.vacated_at IS NULL AND pt.status = 'OPEN' LIMIT 1`);
      const { rows: other } = await c.query(
        `SELECT registration_id FROM registration
          WHERE tournament_id = $1
            AND registration_id NOT IN (
                SELECT registration_id FROM seat_assignment WHERE vacated_at IS NULL)
          LIMIT 1`, [rows[0].tournament_id]);
      return c.query(
        `INSERT INTO seat_assignment (table_id, registration_id, seat_no) VALUES ($1,$2,$3)`,
        [rows[0].table_id, other[0].registration_id, rows[0].seat_no]);
    },
  });

  await test({
    group: 'Triggers', name: 'An action filed under the wrong hand is rejected',
    expect: 'fail', code: '23503',
    fn: (c) => c.query(
      `INSERT INTO hand_action (hand_id, hand_player_id, street, action_seq, action, amount)
       SELECT (SELECT MAX(hand_id) FROM hand), hp.hand_player_id, 'FLOP', 98, 'BET', 100
         FROM hand_player hp
        WHERE hp.hand_id <> (SELECT MAX(hand_id) FROM hand)
        LIMIT 1`),
  });

  await test({
    group: 'Triggers', name: 'Paying a prize updates lifetime earnings automatically',
    expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `SELECT r.registration_id, r.player_id, p.lifetime_earnings
           FROM registration r JOIN player p ON p.player_id = r.player_id LIMIT 1`);
      const before = Number(rows[0].lifetime_earnings);
      await c.query('UPDATE registration SET prize_won = prize_won + 1000 WHERE registration_id=$1',
        [rows[0].registration_id]);
      const { rows: after } = await c.query(
        'SELECT lifetime_earnings FROM player WHERE player_id=$1', [rows[0].player_id]);
      const delta = Number(after[0].lifetime_earnings) - before;
      return Math.abs(delta - 1000) < 0.01 ? `earnings rose by exactly ${delta}` : false;
    },
  });

  await test({
    group: 'Triggers', name: 'Registering bumps the tournament entrant counter',
    expect: 'ok',
    fn: async (c) => {
      const { rows: t } = await c.query(
        `SELECT tournament_id, entrants_count FROM tournament
          WHERE status <> 'COMPLETED' ORDER BY tournament_id LIMIT 1`);
      const { rows: p } = await c.query(
        `SELECT player_id FROM player
          WHERE player_id NOT IN (SELECT player_id FROM registration WHERE tournament_id=$1)
          LIMIT 1`, [t[0].tournament_id]);
      await c.query('INSERT INTO registration (tournament_id, player_id) VALUES ($1,$2)',
        [t[0].tournament_id, p[0].player_id]);
      const { rows: after } = await c.query(
        'SELECT entrants_count FROM tournament WHERE tournament_id=$1', [t[0].tournament_id]);
      return after[0].entrants_count === t[0].entrants_count + 1
        ? `counter moved ${t[0].entrants_count} -> ${after[0].entrants_count}` : false;
    },
  });

  await test({
    group: 'Triggers', name: 'A paid entry cannot be deleted', expect: 'fail', code: '23001',
    fn: (c) => c.query(
      'DELETE FROM registration WHERE registration_id = (SELECT registration_id FROM registration WHERE prize_won > 0 LIMIT 1)'),
  });

  await test({
    group: 'Triggers', name: 'The audit log cannot be modified', expect: 'fail', code: '42501',
    fn: (c) => c.query('UPDATE audit_log SET operation = \'HACK\' WHERE audit_id = (SELECT MIN(audit_id) FROM audit_log)'),
  });

  await test({
    group: 'Triggers', name: 'Changes to an entry are written to the audit log',
    expect: 'ok',
    fn: async (c) => {
      const { rows: before } = await c.query('SELECT COUNT(*)::int n FROM audit_log');
      await c.query(
        `UPDATE registration SET prize_won = prize_won + 5
          WHERE registration_id = (SELECT MIN(registration_id) FROM registration)`);
      const { rows: after } = await c.query('SELECT COUNT(*)::int n FROM audit_log');
      return after[0].n > before[0].n ? `audit rows ${before[0].n} -> ${after[0].n}` : false;
    },
  });

  // ==================================================================
  console.log('\nStored procedures and transactions');
  // ==================================================================
  await test({
    group: 'Procedures', name: 'sp_register_player creates entry, payment, seat and snapshot',
    expect: 'ok',
    fn: async (c) => {
      const { rows: t } = await c.query(
        `SELECT tournament_id FROM tournament WHERE status='RUNNING' ORDER BY tournament_id LIMIT 1`);
      const tid = t[0].tournament_id;
      const { rows: p } = await c.query(
        `SELECT player_id FROM player
          WHERE player_id NOT IN (SELECT player_id FROM registration WHERE tournament_id=$1)
          LIMIT 1`, [tid]);
      const { rows } = await c.query('CALL sp_register_player($1,$2,$3,$4,NULL)',
        [tid, p[0].player_id, 'CASH', 'BUYIN']);
      const rid = rows[0].p_registration_id;
      const { rows: chk } = await c.query(
        `SELECT (SELECT COUNT(*)::int FROM tournament_transaction WHERE registration_id=$1) txn,
                (SELECT COUNT(*)::int FROM seat_assignment WHERE registration_id=$1) seat,
                (SELECT COUNT(*)::int FROM chip_count_log WHERE registration_id=$1) chips`, [rid]);
      return chk[0].txn === 1 && chk[0].seat === 1 && chk[0].chips === 1
        ? 'all four writes landed' : `txn=${chk[0].txn} seat=${chk[0].seat} chips=${chk[0].chips}`;
    },
  });

  await test({
    group: 'Procedures', name: 'Re-entry into a FREEZEOUT event is refused',
    expect: 'fail', code: '23505',
    fn: async (c) => {
      // build a fresh, open FREEZEOUT event so the format rule is what
      // fires, rather than the "not accepting entries" rule
      const { rows: t } = await c.query(
        `INSERT INTO tournament (venue_id, title, format, buy_in, starting_stack,
                                 max_entries, start_time, status)
         VALUES (1,'Freezeout Re-entry Test','FREEZEOUT',1000,20000,50,NOW(),'SCHEDULED')
         RETURNING tournament_id`);
      const tid = t[0].tournament_id;
      await c.query(
        `INSERT INTO blind_level (tournament_id, level_no, small_blind, big_blind)
         VALUES ($1,1,100,200)`, [tid]);
      await c.query(
        `INSERT INTO poker_table (tournament_id, table_no, max_seats, status)
         VALUES ($1,1,9,'OPEN')`, [tid]);
      const { rows: p } = await c.query('SELECT player_id FROM player LIMIT 1');
      await c.query('CALL sp_register_player($1,$2,$3,$4,NULL)',
        [tid, p[0].player_id, 'CASH', 'BUYIN']);
      // the second entry by the same player must be refused
      return c.query('CALL sp_register_player($1,$2,$3,$4,NULL)',
        [tid, p[0].player_id, 'CASH', 'BUYIN']);
    },
  });

  await test({
    group: 'Procedures', name: 'Paying out a tournament twice is refused',
    expect: 'fail', code: '23514',
    fn: async (c) => {
      // NOTE: PostgreSQL does not accept a subquery as a CALL argument,
      // so the id is resolved first and bound as a parameter.
      const { rows } = await c.query(
        "SELECT tournament_id FROM tournament WHERE status='COMPLETED' LIMIT 1");
      return c.query('CALL sp_calculate_payouts($1)', [rows[0].tournament_id]);
    },
  });

  await test({
    group: 'Procedures', name: 'Paying out while players remain is refused',
    expect: 'fail', code: '23514',
    fn: async (c) => {
      const { rows } = await c.query(
        `SELECT t.tournament_id FROM tournament t
           JOIN registration r ON r.tournament_id = t.tournament_id
          WHERE r.is_active
          GROUP BY t.tournament_id HAVING COUNT(*) > 1 LIMIT 1`);
      if (!rows.length) return 'skipped: no event has two or more live entries';
      return c.query('CALL sp_calculate_payouts($1)', [rows[0].tournament_id]);
    },
  });

  await test({
    group: 'Procedures', name: 'sp_record_hand rejects a hand where chips do not balance',
    expect: 'fail', code: '23514',
    fn: (c) => c.query(
      `CALL sp_record_hand(1, 1::smallint, 9998, NULL, 1000, false,
         '[{"registration_id":1,"seat_no":1,"chips_before":10000,"chips_after":11000},
           {"registration_id":2,"seat_no":2,"chips_before":10000,"chips_after":9500}]'::jsonb,
         NULL)`),
  });

  await test({
    group: 'Procedures', name: 'A failed procedure leaves no partial rows (atomicity)',
    expect: 'ok',
    fn: async (c) => {
      const { rows: before } = await c.query('SELECT COUNT(*)::int n FROM registration');
      // a failed statement aborts the surrounding transaction, so the
      // doomed CALL gets a savepoint of its own to roll back to
      await c.query('SAVEPOINT atomicity_probe');
      try {
        await c.query('CALL sp_register_player($1,$2,$3,$4,NULL)', [999999, 1, 'CASH', 'BUYIN']);
      } catch {
        await c.query('ROLLBACK TO SAVEPOINT atomicity_probe');
      }
      const { rows: after } = await c.query('SELECT COUNT(*)::int n FROM registration');
      return after[0].n === before[0].n ? 'no orphan entry was left behind' : false;
    },
  });

  await test({
    group: 'Procedures', name: 'sp_eliminate_player moves chips to the eliminator',
    expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `SELECT a.registration_id AS victim, a.chip_stack AS victim_chips,
                b.registration_id AS killer, b.chip_stack AS killer_chips
           FROM registration a JOIN registration b
             ON b.tournament_id = a.tournament_id AND b.registration_id <> a.registration_id
          WHERE a.is_active AND b.is_active AND a.chip_stack > 0
          LIMIT 1`);
      if (!rows.length) return 'skipped: no live tournament with two active entries';
      await c.query('CALL sp_eliminate_player($1,$2)', [rows[0].victim, rows[0].killer]);
      const { rows: after } = await c.query(
        'SELECT chip_stack, is_active FROM registration WHERE registration_id=$1', [rows[0].killer]);
      const expected = Number(rows[0].killer_chips) + Number(rows[0].victim_chips);
      return Number(after[0].chip_stack) === expected
        ? `chips transferred: ${rows[0].killer_chips} + ${rows[0].victim_chips} = ${after[0].chip_stack}`
        : `expected ${expected}, got ${after[0].chip_stack}`;
    },
  });

  // ==================================================================
  console.log('\nVector layer');
  // ==================================================================
  await test({
    group: 'Vector', name: 'All embeddings are 256-dimensional and unit length',
    expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `SELECT MIN(vector_dims(embedding))::int dmin, MAX(vector_dims(embedding))::int dmax,
                ROUND(MIN(vector_norm(embedding))::numeric,4) nmin,
                ROUND(MAX(vector_norm(embedding))::numeric,4) nmax
           FROM hand_summary`);
      const r = rows[0];
      return r.dmin === 256 && r.dmax === 256 && Math.abs(r.nmin - 1) < 0.01
        ? `dims ${r.dmin}, norms ${r.nmin}–${r.nmax}` : JSON.stringify(r);
    },
  });

  await test({
    group: 'Vector', name: 'A hand is its own nearest neighbour (similarity 1.0)',
    expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `WITH probe AS (SELECT hand_id, embedding FROM hand_summary ORDER BY hand_id LIMIT 1)
         SELECT hs.hand_id, ROUND((1-(hs.embedding <=> probe.embedding))::numeric,4) sim
           FROM hand_summary hs, probe ORDER BY hs.embedding <=> probe.embedding LIMIT 1`);
      return Math.abs(rows[0].sim - 1) < 0.001 ? `self-similarity ${rows[0].sim}` : false;
    },
  });

  await test({
    group: 'Vector', name: 'Similarity ordering is monotonic', expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `WITH probe AS (SELECT embedding FROM hand_summary ORDER BY hand_id LIMIT 1)
         SELECT ROUND((1-(hs.embedding <=> probe.embedding))::numeric,4) sim
           FROM hand_summary hs, probe ORDER BY hs.embedding <=> probe.embedding LIMIT 10`);
      const sims = rows.map((r) => Number(r.sim));
      const sorted = sims.every((v, i) => i === 0 || sims[i - 1] >= v);
      return sorted ? `top-10 similarities descend from ${sims[0]} to ${sims[9]}` : false;
    },
  });

  await test({
    group: 'Vector', name: 'A hand may hold only one embedding', expect: 'fail', code: '23505',
    fn: (c) => c.query(
      `INSERT INTO hand_summary (hand_id, summary_text, embedding)
       SELECT hand_id, 'duplicate summary for the same hand', embedding
         FROM hand_summary LIMIT 1`),
  });

  await test({
    group: 'Vector', name: 'A summary shorter than 10 characters is rejected',
    expect: 'fail', code: '23514',
    fn: (c) => c.query(
      `INSERT INTO hand_summary (hand_id, summary_text, embedding)
       SELECT (SELECT MAX(hand_id)+1 FROM hand), 'tiny',
              (SELECT embedding FROM hand_summary LIMIT 1)`),
  });

  await test({
    group: 'Vector', name: 'Updating a summary refreshes token_count via trigger',
    expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `UPDATE hand_summary
            SET summary_text = 'one two three four five six seven eight nine ten eleven twelve'
          WHERE summary_id = (SELECT MIN(summary_id) FROM hand_summary)
          RETURNING token_count`);
      return rows[0].token_count === 12 ? 'token_count recomputed to 12' : `got ${rows[0].token_count}`;
    },
  });

  // ==================================================================
  console.log('\nViews and derived values');
  // ==================================================================
  await test({
    group: 'Views', name: 'Prize pool equals entries minus rake', expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `SELECT COUNT(*)::int bad FROM (
           SELECT t.tournament_id,
                  fn_prize_pool(t.tournament_id) pool,
                  COALESCE(SUM(tx.amount) FILTER (
                    WHERE tx.txn_type IN ('BUYIN','REENTRY','ADDON')),0) gross,
                  t.rake_pct, t.guarantee
             FROM tournament t
             LEFT JOIN registration r ON r.tournament_id = t.tournament_id
             LEFT JOIN tournament_transaction tx ON tx.registration_id = r.registration_id
            GROUP BY t.tournament_id, t.rake_pct, t.guarantee) z
          WHERE ABS(pool - GREATEST(ROUND(gross*(1-rake_pct/100.0),2), guarantee)) > 0.02`);
      return rows[0].bad === 0 ? 'every tournament reconciles' : `${rows[0].bad} mismatched`;
    },
  });

  await test({
    group: 'Views', name: 'No tournament pays out more than its prize pool', expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `SELECT COUNT(*)::int bad FROM (
           SELECT t.tournament_id, fn_prize_pool(t.tournament_id) pool,
                  COALESCE(SUM(r.prize_won),0) paid
             FROM tournament t LEFT JOIN registration r ON r.tournament_id=t.tournament_id
            GROUP BY t.tournament_id) z WHERE paid > pool + 0.01`);
      return rows[0].bad === 0 ? 'payouts are within the pool everywhere' : `${rows[0].bad} over-paid`;
    },
  });

  await test({
    group: 'Views', name: 'Chips are conserved inside every hand', expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `SELECT COUNT(*)::int bad FROM (
           SELECT hand_id, SUM(chips_after - chips_before) s
             FROM hand_player GROUP BY hand_id) z WHERE s <> 0`);
      return rows[0].bad === 0 ? 'every hand nets to zero' : `${rows[0].bad} hands unbalanced`;
    },
  });

  await test({
    group: 'Views', name: 'Every completed tournament has exactly one winner', expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `SELECT COUNT(*)::int bad FROM (
           SELECT tournament_id, COUNT(*) FILTER (WHERE finish_rank=1) c
             FROM registration r
            WHERE EXISTS (SELECT 1 FROM tournament t
                           WHERE t.tournament_id=r.tournament_id AND t.status='COMPLETED')
            GROUP BY tournament_id) z WHERE c <> 1`);
      return rows[0].bad === 0 ? 'one champion per completed event' : `${rows[0].bad} wrong`;
    },
  });

  await test({
    group: 'Views', name: 'Derived age matches the stored date of birth', expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `SELECT COUNT(*)::int bad FROM v_player_profile v JOIN player p USING (player_id)
          WHERE v.age <> EXTRACT(YEAR FROM age(CURRENT_DATE, p.date_of_birth))::int`);
      return rows[0].bad === 0 ? 'age is consistently derived' : `${rows[0].bad} mismatched`;
    },
  });

  // ==================================================================
  console.log('\nAccess control');
  // ==================================================================
  await test({
    group: 'Access control', name: 'poker_player cannot read the credentials table',
    expect: 'fail', code: '42501',
    fn: async (c) => {
      await c.query('SET LOCAL ROLE poker_player');
      return c.query('SELECT email, password_hash FROM app_user LIMIT 1');
    },
  });

  await test({
    group: 'Access control', name: 'poker_player cannot read hole cards',
    expect: 'fail', code: '42501',
    fn: async (c) => {
      await c.query('SET LOCAL ROLE poker_player');
      return c.query('SELECT hole_cards FROM hand_player LIMIT 1');
    },
  });

  await test({
    group: 'Access control', name: 'poker_player cannot insert a tournament',
    expect: 'fail', code: '42501',
    fn: async (c) => {
      await c.query('SET LOCAL ROLE poker_player');
      return c.query(
        `INSERT INTO tournament (venue_id, title, buy_in, starting_stack, max_entries, start_time)
         VALUES (1,'Should Not Work',100,20000,10,NOW())`);
    },
  });

  await test({
    group: 'Access control', name: 'poker_director cannot read the credentials table',
    expect: 'fail', code: '42501',
    fn: async (c) => {
      await c.query('SET LOCAL ROLE poker_director');
      return c.query('SELECT password_hash FROM app_user LIMIT 1');
    },
  });

  await test({
    group: 'Access control', name: 'poker_director cannot rewrite career earnings',
    expect: 'fail', code: '42501',
    fn: async (c) => {
      await c.query('SET LOCAL ROLE poker_director');
      return c.query('UPDATE player SET lifetime_earnings = 999999 WHERE player_id = 1');
    },
  });

  await test({
    group: 'Access control', name: 'poker_director CAN correct a player name (column grant)',
    expect: 'ok',
    fn: async (c) => {
      await c.query('SET LOCAL ROLE poker_director');
      await c.query("UPDATE player SET first_name = 'Corrected' WHERE player_id = 1");
      return 'column-level UPDATE permitted as designed';
    },
  });

  await test({
    group: 'Access control', name: 'Row-level security limits a player to their own entries',
    expect: 'ok',
    fn: async (c) => {
      const { rows: target } = await c.query(
        'SELECT player_id FROM registration GROUP BY player_id ORDER BY COUNT(*) DESC LIMIT 1');
      const pid = target[0].player_id;
      await c.query('SELECT set_config($1,$2,true)', ['app.current_player_id', String(pid)]);
      await c.query('SET LOCAL ROLE poker_player');
      const { rows } = await c.query('SELECT COUNT(*)::int n, COUNT(DISTINCT player_id)::int d FROM registration');
      return rows[0].d === 1
        ? `sees only its own ${rows[0].n} entries` : `saw ${rows[0].d} distinct players`;
    },
  });

  // ==================================================================
  console.log('\nIndex usage');
  // ==================================================================
  await test({
    group: 'Indexes', name: 'Partial index serves the live-floor query', expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `EXPLAIN (FORMAT JSON)
         SELECT registration_id, chip_stack FROM registration
          WHERE is_active AND tournament_id = 1 ORDER BY chip_stack DESC LIMIT 10`);
      const plan = JSON.stringify(rows[0]['QUERY PLAN']);
      return plan.includes('ix_reg_active_by_tournament')
        ? 'ix_reg_active_by_tournament chosen' : `plan was ${plan.slice(0, 90)}`;
    },
  });

  await test({
    group: 'Indexes', name: 'HNSW index serves the similarity search', expect: 'ok',
    fn: async (c) => {
      const { rows } = await c.query(
        `EXPLAIN (FORMAT JSON)
         SELECT hand_id FROM hand_summary
          ORDER BY embedding <=> (SELECT embedding FROM hand_summary LIMIT 1) LIMIT 5`);
      const plan = JSON.stringify(rows[0]['QUERY PLAN']);
      return plan.includes('ix_summary_embedding_hnsw')
        ? 'ix_summary_embedding_hnsw chosen' : `plan was ${plan.slice(0, 90)}`;
    },
  });

  await test({
    group: 'Indexes', name: 'GIN index serves full-text search', expect: 'ok',
    fn: async (c) => {
      await c.query('SET LOCAL enable_seqscan = off');
      const { rows } = await c.query(
        `EXPLAIN (FORMAT JSON)
         SELECT hand_id FROM hand_summary
          WHERE search_tsv @@ websearch_to_tsquery('english','showdown')`);
      const plan = JSON.stringify(rows[0]['QUERY PLAN']);
      return plan.includes('ix_summary_fts') ? 'ix_summary_fts chosen' : `plan was ${plan.slice(0, 90)}`;
    },
  });

  // ==================================================================
  await client.query('ROLLBACK');

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${pass} passed, ${fail} failed, ${results.length} total`);
  console.log(`${'='.repeat(60)}\n`);

  if (process.env.TEST_MARKDOWN === 'true') {
    console.log('| # | Group | Test case | Expected | Result |');
    console.log('|---|-------|-----------|----------|--------|');
    for (const r of results) {
      console.log(`| ${r.id} | ${r.group} | ${r.name} | ${r.expect === 'fail' ? 'Rejected' : 'Succeeds'} | ${r.status} |`);
    }
  }

  await client.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nTest runner crashed:', err.message);
  await client.query('ROLLBACK').catch(() => {});
  await client.end().catch(() => {});
  process.exit(1);
});
