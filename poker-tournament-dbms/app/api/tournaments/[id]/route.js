/**
 * /api/tournaments/[id]
 *   GET    — one tournament with structure, standings, finances, top pots
 *   PATCH  — update mutable fields
 *   DELETE — remove a scheduled tournament (ADMIN only)
 */

import { guard, json, fail } from '@/lib/api';
import { queryRows, queryOne, withTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = guard('analytics:read', async (req, { params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id)) return fail('Invalid tournament id.');

  const tournament = await queryOne(
    'SELECT * FROM v_tournament_overview WHERE tournament_id = $1',
    [id],
  );
  if (!tournament) return fail('Tournament not found.', 404);

  const [levels, payouts, standings, finance, topPots, tables] = await Promise.all([
    queryRows(
      `SELECT level_no, small_blind, big_blind, ante, duration_min, is_break
         FROM blind_level WHERE tournament_id = $1 ORDER BY level_no`, [id]),
    queryRows(
      `SELECT rank_from, rank_to, pct_of_pool
         FROM payout_tier WHERE tournament_id = $1 ORDER BY rank_from`, [id]),
    queryRows('SELECT * FROM fn_tournament_standings($1) ORDER BY standing_pos LIMIT 60', [id]),
    queryOne('SELECT * FROM v_financial_summary WHERE tournament_id = $1', [id]),
    queryRows(
      `SELECT h.hand_id, h.hand_no, h.pot_size, h.board_cards, h.went_to_showdown,
              hs.summary_text
         FROM hand h
         LEFT JOIN hand_summary hs ON hs.hand_id = h.hand_id
        WHERE h.tournament_id = $1
        ORDER BY h.pot_size DESC
        LIMIT 8`, [id]),
    queryRows(
      `SELECT pt.table_no, pt.status, COUNT(sa.seat_id)::int AS seated
         FROM poker_table pt
         LEFT JOIN seat_assignment sa
                ON sa.table_id = pt.table_id AND sa.vacated_at IS NULL
        WHERE pt.tournament_id = $1
        GROUP BY pt.table_id, pt.table_no, pt.status
        ORDER BY pt.table_no`, [id]),
  ]);

  // chip trajectory of the chip leader, for the chart
  const trajectory = await queryRows(
    `SELECT c.level_no, c.chip_stack, p.screen_name
       FROM chip_count_log c
       JOIN registration r ON r.registration_id = c.registration_id
       JOIN player p ON p.player_id = r.player_id
      WHERE c.tournament_id = $1
        AND c.registration_id = (
              SELECT registration_id FROM registration
               WHERE tournament_id = $1
               ORDER BY finish_rank ASC NULLS LAST, chip_stack DESC
               LIMIT 1)
      ORDER BY c.level_no`,
    [id],
  );

  return json({ tournament, levels, payouts, standings, finance, topPots, tables, trajectory });
});

export const PATCH = guard('tournament:update', async (req, { params, dbRole }) => {
  const id = Number(params.id);
  const body = await req.json().catch(() => null);
  if (!body) return fail('Expected a JSON body.');

  const allowed = ['title', 'guarantee', 'status', 'start_time', 'max_entries'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (body[key] !== undefined) {
      values.push(body[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }
  if (!sets.length) return fail('No updatable field supplied.');
  values.push(id);

  const row = await withTransaction(
    async (client) => {
      const { rows } = await client.query(
        `UPDATE tournament SET ${sets.join(', ')}
          WHERE tournament_id = $${values.length}
          RETURNING tournament_id, title, status, guarantee, max_entries`,
        values,
      );
      return rows[0];
    },
    { role: dbRole },
  );

  if (!row) return fail('Tournament not found.', 404);
  return json({ tournament: row });
});

export const DELETE = guard('tournament:delete', async (req, { params, dbRole }) => {
  const id = Number(params.id);

  const result = await withTransaction(
    async (client) => {
      const { rows } = await client.query(
        `DELETE FROM tournament
          WHERE tournament_id = $1 AND status = 'SCHEDULED'
          RETURNING tournament_id`,
        [id],
      );
      return rows[0];
    },
    { role: dbRole },
  );

  if (!result) {
    return fail('Only a SCHEDULED tournament can be deleted.', 409);
  }
  return json({ deleted: result.tournament_id });
});
