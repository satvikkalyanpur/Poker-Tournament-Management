/**
 * GET /api/players/[id] — full career profile for one player.
 * Demonstrates the correlated subquery, window function and recursive
 * query work from the query set, served through the API.
 */
import { guard, json, fail } from '@/lib/api';
import { queryOne, queryRows } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = guard('analytics:read', async (req, { params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id)) return fail('Invalid player id.');

  const profile = await queryOne(
    'SELECT * FROM v_player_profile WHERE player_id = $1', [id]);
  if (!profile) return fail('Player not found.', 404);

  const [results, positional, knockouts, phones, trajectory] = await Promise.all([
    queryRows(
      `SELECT t.tournament_id, t.title, t.buy_in, t.start_time,
              r.finish_rank, r.prize_won, r.entry_no, t.entrants_count
         FROM registration r
         JOIN tournament t ON t.tournament_id = r.tournament_id
        WHERE r.player_id = $1
        ORDER BY t.start_time DESC
        LIMIT 25`, [id]),

    // positional win rate — the analytical centrepiece
    queryRows(
      `WITH outcomes AS (
         SELECT CASE WHEN hp.is_dealer THEN 'button'
                     WHEN hp.seat_no <= 3 THEN 'early'
                     WHEN hp.seat_no <= 6 THEN 'middle'
                     ELSE 'late' END AS position_group,
                hp.net_result
           FROM hand_player hp
           JOIN registration r ON r.registration_id = hp.registration_id
          WHERE r.player_id = $1)
       SELECT position_group,
              COUNT(*)::int                                  AS hands,
              COUNT(*) FILTER (WHERE net_result > 0)::int    AS won,
              ROUND(100.0 * COUNT(*) FILTER (WHERE net_result > 0)
                    / NULLIF(COUNT(*),0), 1)                 AS win_rate_pct,
              SUM(net_result)::int                           AS net_chips
         FROM outcomes
        GROUP BY position_group
        ORDER BY net_chips DESC`, [id]),

    queryRows(
      `SELECT victim_p.screen_name AS victim, t.title, loser.finish_rank
         FROM registration me
         JOIN registration loser ON loser.eliminated_by_reg_id = me.registration_id
         JOIN player victim_p ON victim_p.player_id = loser.player_id
         JOIN tournament t ON t.tournament_id = loser.tournament_id
        WHERE me.player_id = $1
        ORDER BY loser.bust_time DESC
        LIMIT 15`, [id]),

    queryRows('SELECT phone, is_primary FROM player_phone WHERE player_id = $1', [id]),

    queryRows(
      `SELECT c.level_no, c.chip_stack, t.title
         FROM chip_count_log c
         JOIN registration r ON r.registration_id = c.registration_id
         JOIN tournament t ON t.tournament_id = c.tournament_id
        WHERE r.player_id = $1
          AND c.registration_id = (SELECT registration_id FROM registration
                                    WHERE player_id = $1
                                    ORDER BY finish_rank ASC NULLS LAST LIMIT 1)
        ORDER BY c.level_no`, [id]),
  ]);

  return json({ profile, results, positional, knockouts, phones, trajectory });
});
