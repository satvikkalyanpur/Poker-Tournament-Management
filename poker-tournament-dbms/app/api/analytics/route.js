/**
 * GET /api/analytics — everything the dashboard needs, in one call.
 *
 * Each block below is one of the queries from db/queries/, so the
 * dashboard is a live demonstration of the query set rather than a
 * separate pile of SQL written just for the UI.
 */

import { guard, json } from '@/lib/api';
import { queryRows, queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = guard('analytics:read', async () => {
  const [
    totals, leaderboard, seasonBoard, venueStats, aggression,
    recentTournaments, potDistribution, eliminationChains, vectorStats, quartiles,
  ] = await Promise.all([
    // headline counters
    queryOne(`
      SELECT (SELECT COUNT(*)::int FROM player)                            AS players,
             (SELECT COUNT(*)::int FROM tournament)                        AS tournaments,
             (SELECT COUNT(*)::int FROM registration)                      AS entries,
             (SELECT COUNT(*)::int FROM hand)                              AS hands,
             (SELECT COUNT(*)::int FROM hand_action)                       AS actions,
             (SELECT COUNT(*)::int FROM hand_summary)                      AS embeddings,
             (SELECT COALESCE(SUM(prize_won),0) FROM registration)         AS total_paid,
             (SELECT COUNT(*)::int FROM registration WHERE is_active)      AS still_playing`),

    // career leaderboard, window-ranked
    queryRows(`
      SELECT screen_name, country, lifetime_earnings, ranking_points,
             times_cashed, titles, cash_rate_pct, roi_pct,
             RANK() OVER (ORDER BY lifetime_earnings DESC)::int AS rank
        FROM v_player_profile
       WHERE total_entries > 0
       ORDER BY lifetime_earnings DESC
       LIMIT 10`),

    queryRows(`
      SELECT season_name, season_rank::int, screen_name, country,
             events_played::int, season_points::int, season_winnings, wins::int
        FROM mv_season_leaderboard
       WHERE season_rank <= 5
       ORDER BY season_name, season_rank`),

    // GROUP BY + HAVING
    queryRows(`
      SELECT v.venue_name, v.city,
             COUNT(DISTINCT t.tournament_id)::int AS tournaments,
             COUNT(r.registration_id)::int        AS entries,
             ROUND(AVG(t.buy_in),0)               AS avg_buy_in
        FROM venue v
        JOIN tournament t ON t.venue_id = v.venue_id
        LEFT JOIN registration r ON r.tournament_id = t.tournament_id
       GROUP BY v.venue_id, v.venue_name, v.city
      HAVING COUNT(r.registration_id) > 0
       ORDER BY entries DESC`),

    // aggression index
    queryRows(`
      SELECT p.screen_name,
             COUNT(*)::int AS actions,
             ROUND(100.0 * COUNT(*) FILTER (WHERE a.action IN ('BET','RAISE','ALLIN'))
                   / COUNT(*), 1) AS aggression_pct,
             ROUND(AVG(a.think_time_sec),1) AS avg_think_sec
        FROM hand_action a
        JOIN hand_player hp ON hp.hand_player_id = a.hand_player_id
        JOIN registration r ON r.registration_id = hp.registration_id
        JOIN player p ON p.player_id = r.player_id
       GROUP BY p.player_id, p.screen_name
      HAVING COUNT(*) >= 20
       ORDER BY aggression_pct DESC
       LIMIT 10`),

    queryRows(`
      SELECT tournament_id, title, status, start_time, entrants_count,
             prize_pool, players_remaining, city
        FROM v_tournament_overview
       ORDER BY start_time DESC
       LIMIT 8`),

    // pot size distribution by level — chart data
    queryRows(`
      SELECT h.level_no::int,
             COUNT(*)::int            AS hands,
             ROUND(AVG(h.pot_size),0) AS avg_pot,
             MAX(h.pot_size)          AS max_pot
        FROM hand h
       GROUP BY h.level_no
       ORDER BY h.level_no`),

    // recursive CTE: knockout chain depth per champion
    queryRows(`
      WITH RECURSIVE chain AS (
        SELECT registration_id AS root_id, registration_id, 0 AS depth
          FROM registration WHERE finish_rank = 1
        UNION ALL
        SELECT c.root_id, r.registration_id, c.depth + 1
          FROM chain c
          JOIN registration r ON r.eliminated_by_reg_id = c.registration_id
         WHERE c.depth < 20)
      SELECT t.title, p.screen_name AS champion,
             (COUNT(*) - 1)::int AS chain_size,
             MAX(chain.depth)::int AS chain_depth
        FROM chain
        JOIN registration root ON root.registration_id = chain.root_id
        JOIN player p ON p.player_id = root.player_id
        JOIN tournament t ON t.tournament_id = root.tournament_id
       GROUP BY t.title, p.screen_name
       ORDER BY chain_size DESC
       LIMIT 8`),

    queryOne(`
      SELECT COUNT(*)::int                                   AS documents,
             MAX(vector_dims(embedding))::int                AS dimensions,
             ROUND(AVG(vector_norm(embedding))::numeric,4)   AS avg_norm,
             MAX(model_name)                                 AS model,
             ROUND(AVG(token_count),1)                       AS avg_tokens
        FROM hand_summary`),

    queryRows(`
      SELECT quartile::int,
             COUNT(*)::int AS players,
             ROUND(AVG(lifetime_earnings),0) AS avg_earnings
        FROM (SELECT lifetime_earnings,
                     NTILE(4) OVER (ORDER BY lifetime_earnings DESC) AS quartile
                FROM player) z
       GROUP BY quartile ORDER BY quartile`),
  ]);

  return json({
    totals, leaderboard, seasonBoard, venueStats, aggression,
    recentTournaments, potDistribution, eliminationChains, vectorStats, quartiles,
  });
});
