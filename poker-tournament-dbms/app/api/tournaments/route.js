/**
 * /api/tournaments
 *   GET  — list tournaments (uses the v_tournament_overview view)
 *   POST — create a tournament with its blind structure and payout
 *          ladder, in ONE transaction (DIRECTOR or ADMIN only)
 */

import { guard, json, fail, pagination } from '@/lib/api';
import { queryRows, withTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = guard('analytics:read', async (req) => {
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const search = url.searchParams.get('q');
  const { pageSize, offset, page } = pagination(req);

  // Parameterised throughout — no string concatenation of user input.
  const rows = await queryRows(
    `SELECT *
       FROM v_tournament_overview
      WHERE ($1::tournament_status IS NULL OR status = $1::tournament_status)
        AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%')
      ORDER BY start_time DESC
      LIMIT $3 OFFSET $4`,
    [status || null, search || null, pageSize, offset],
  );

  const [{ total }] = await queryRows(
    `SELECT COUNT(*)::int AS total
       FROM tournament
      WHERE ($1::tournament_status IS NULL OR status = $1::tournament_status)
        AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%')`,
    [status || null, search || null],
  );

  return json({ tournaments: rows, page, pageSize, total });
});

export const POST = guard('tournament:create', async (req, { user, dbRole }) => {
  const body = await req.json().catch(() => null);
  if (!body) return fail('Expected a JSON body.');

  const {
    venueId, seasonId, title, gameType = 'NLH', format = 'FREEZEOUT',
    buyIn, rakePct = 10, guarantee = 0, startingStack = 25000,
    maxEntries = 100, startTime, levels = 15, tableCount = 4,
  } = body;

  if (!venueId || !title || !buyIn || !startTime) {
    return fail('venueId, title, buyIn and startTime are required.');
  }

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO tournament
         (venue_id, season_id, created_by, title, game_type, format, buy_in,
          rake_pct, guarantee, starting_stack, max_entries, start_time, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'SCHEDULED')
       RETURNING tournament_id, title`,
      [venueId, seasonId ?? null, user.staffId ?? null, title, gameType, format,
       buyIn, rakePct, guarantee, startingStack, maxEntries, startTime],
    );
    const tid = rows[0].tournament_id;

    // blind structure
    let sb = Math.max(100, Math.round(startingStack / 200 / 50) * 50);
    for (let l = 1; l <= Math.min(Number(levels) || 15, 40); l += 1) {
      const isBreak = l % 6 === 0;
      await client.query(
        `INSERT INTO blind_level (tournament_id, level_no, small_blind, big_blind,
                                  ante, duration_min, is_break)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tid, l, sb, sb * 2, l >= 4 ? Math.round(sb / 2) : 0, isBreak ? 15 : 20, isBreak],
      );
      sb = Math.max(sb + 50, Math.round((sb * 1.4) / 50) * 50);
    }

    // standard payout ladder (99% of pool)
    for (const [from, to, pct] of [[1,1,30],[2,2,20],[3,3,13],[4,5,8],[6,9,5]]) {
      await client.query(
        `INSERT INTO payout_tier (tournament_id, rank_from, rank_to, pct_of_pool)
         VALUES ($1,$2,$3,$4)`,
        [tid, from, to, pct],
      );
    }

    // tables
    for (let n = 1; n <= Math.min(Number(tableCount) || 4, 40); n += 1) {
      await client.query(
        `INSERT INTO poker_table (tournament_id, table_no, max_seats, status)
         VALUES ($1,$2,9,'OPEN')`,
        [tid, n],
      );
    }

    return rows[0];
  }, { role: dbRole });

  return json({ tournament: result }, 201);
});
