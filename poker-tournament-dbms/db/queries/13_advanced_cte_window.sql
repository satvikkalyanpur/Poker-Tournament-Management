-- =====================================================================
--  File   : queries/13_advanced_cte_window.sql
--  Rubric : item 8 - Advanced SQL (CTE, window functions, analytics)
--
--  Read-only.
-- =====================================================================

\echo '--- Q1. CTE chain: tournament profitability report'
\echo '        Three named steps instead of one unreadable nested query.'
WITH entry_money AS (
    SELECT r.tournament_id,
           SUM(tx.amount) FILTER (WHERE tx.txn_type IN ('BUYIN','REENTRY','ADDON')) AS gross_in,
           SUM(tx.amount) FILTER (WHERE tx.txn_type = 'PAYOUT')                      AS paid_out
      FROM tournament_transaction tx
      JOIN registration r ON r.registration_id = tx.registration_id
     GROUP BY r.tournament_id
),
field_stats AS (
    SELECT tournament_id,
           COUNT(*)                                   AS entries,
           COUNT(DISTINCT player_id)                  AS unique_players,
           COUNT(*) FILTER (WHERE entry_no > 1)       AS reentries
      FROM registration
     GROUP BY tournament_id
)
SELECT t.title,
       f.entries,
       f.unique_players,
       f.reentries,
       m.gross_in,
       m.paid_out,
       ROUND(m.gross_in - COALESCE(m.paid_out, 0), 2)                   AS house_retained,
       ROUND(100.0 * (m.gross_in - COALESCE(m.paid_out,0)) / m.gross_in, 2) AS margin_pct
  FROM tournament t
  JOIN entry_money m ON m.tournament_id = t.tournament_id
  JOIN field_stats f ON f.tournament_id = t.tournament_id
 ORDER BY m.gross_in DESC;

\echo ''
\echo '--- Q2. RANK / DENSE_RANK / ROW_NUMBER side by side'
\echo '        Shows exactly how the three differ on tied values.'
SELECT p.screen_name,
       p.lifetime_earnings,
       ROW_NUMBER() OVER (ORDER BY p.lifetime_earnings DESC) AS row_number,
       RANK()       OVER (ORDER BY p.lifetime_earnings DESC) AS rank,
       DENSE_RANK() OVER (ORDER BY p.lifetime_earnings DESC) AS dense_rank
  FROM player p
 WHERE p.lifetime_earnings > 0
 ORDER BY p.lifetime_earnings DESC
 LIMIT 12;

\echo ''
\echo '--- Q3. PARTITION BY: rank players WITHIN each country'
SELECT country, screen_name, lifetime_earnings, national_rank
  FROM (SELECT p.country,
               p.screen_name,
               p.lifetime_earnings,
               RANK() OVER (PARTITION BY p.country
                            ORDER BY p.lifetime_earnings DESC) AS national_rank
          FROM player p
         WHERE p.lifetime_earnings > 0) z
 WHERE national_rank <= 2
 ORDER BY country, national_rank;

\echo ''
\echo '--- Q4. LAG / LEAD: chip trajectory, level by level'
\echo '        The change from one level to the next needs the PREVIOUS'
\echo '        row, which is exactly what a window frame provides.'
SELECT p.screen_name,
       c.level_no,
       c.chip_stack,
       LAG(c.chip_stack)  OVER w               AS previous_level,
       c.chip_stack - LAG(c.chip_stack) OVER w AS change,
       LEAD(c.chip_stack) OVER w               AS next_level,
       CASE
         WHEN c.chip_stack > LAG(c.chip_stack) OVER w THEN 'up'
         WHEN c.chip_stack < LAG(c.chip_stack) OVER w THEN 'down'
         ELSE 'flat'
       END AS direction
  FROM chip_count_log c
  JOIN registration r ON r.registration_id = c.registration_id
  JOIN player p       ON p.player_id       = r.player_id
 WHERE c.registration_id = (SELECT registration_id FROM registration
                             WHERE finish_rank = 1 ORDER BY registration_id LIMIT 1)
WINDOW w AS (PARTITION BY c.registration_id ORDER BY c.level_no)
 ORDER BY c.level_no;

\echo ''
\echo '--- Q5. Running totals and moving averages over a tournament'
SELECT h.hand_no,
       h.pot_size,
       SUM(h.pot_size) OVER (ORDER BY h.hand_no)                   AS cumulative_chips_wagered,
       ROUND(AVG(h.pot_size) OVER (ORDER BY h.hand_no
             ROWS BETWEEN 4 PRECEDING AND CURRENT ROW), 0)         AS moving_avg_5,
       ROUND(100.0 * h.pot_size
             / SUM(h.pot_size) OVER (), 2)                         AS pct_of_all_action
  FROM hand h
 WHERE h.tournament_id = (SELECT MIN(tournament_id) FROM tournament)
 ORDER BY h.hand_no
 LIMIT 15;

\echo ''
\echo '--- Q6. NTILE: split the player base into four skill quartiles'
SELECT quartile,
       COUNT(*)                        AS players,
       ROUND(AVG(lifetime_earnings),2) AS avg_earnings,
       MIN(lifetime_earnings)          AS floor_earnings,
       MAX(lifetime_earnings)          AS ceiling_earnings
  FROM (SELECT screen_name,
               lifetime_earnings,
               NTILE(4) OVER (ORDER BY lifetime_earnings DESC) AS quartile
          FROM player) z
 GROUP BY quartile
 ORDER BY quartile;

\echo ''
\echo '--- Q7. FIRST_VALUE / LAST_VALUE: compare each entry to its event''s'
\echo '        best and worst finisher'
SELECT t.title,
       p.screen_name,
       r.finish_rank,
       r.prize_won,
       FIRST_VALUE(r.prize_won) OVER w AS winner_got,
       ROUND(100.0 * r.prize_won / NULLIF(FIRST_VALUE(r.prize_won) OVER w, 0), 1)
                                        AS pct_of_first_prize
  FROM registration r
  JOIN player p     ON p.player_id     = r.player_id
  JOIN tournament t ON t.tournament_id = r.tournament_id
 WHERE r.prize_won > 0
WINDOW w AS (PARTITION BY r.tournament_id ORDER BY r.finish_rank
             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
 ORDER BY t.tournament_id, r.finish_rank
 LIMIT 15;

\echo ''
\echo '--- Q8. Window + aggregate together: positional win rate per player'
\echo '        The analytical heart of the project.'
WITH hand_outcomes AS (
    SELECT hp.registration_id,
           hp.seat_no,
           hp.net_result,
           CASE WHEN hp.is_dealer THEN 'button'
                WHEN hp.seat_no <= 3 THEN 'early'
                WHEN hp.seat_no <= 6 THEN 'middle'
                ELSE 'late' END AS position_group
      FROM hand_player hp
)
SELECT p.screen_name,
       o.position_group,
       COUNT(*)                                           AS hands,
       COUNT(*) FILTER (WHERE o.net_result > 0)           AS hands_won,
       ROUND(100.0 * COUNT(*) FILTER (WHERE o.net_result > 0)
             / COUNT(*), 1)                               AS win_rate_pct,
       SUM(o.net_result)                                  AS net_chips,
       ROUND(AVG(SUM(o.net_result)) OVER (PARTITION BY p.screen_name), 0)
                                                          AS player_avg_across_positions
  FROM hand_outcomes o
  JOIN registration r ON r.registration_id = o.registration_id
  JOIN player p       ON p.player_id       = r.player_id
 GROUP BY p.player_id, p.screen_name, o.position_group
HAVING COUNT(*) >= 8
 ORDER BY net_chips DESC
 LIMIT 15;

\echo ''
\echo '--- Q9. MATERIALIZED VIEW in use: the season leaderboard'
SELECT season_name, season_rank, screen_name, country,
       events_played, season_points, season_winnings, wins, final_tables
  FROM mv_season_leaderboard
 WHERE season_rank <= 5
 ORDER BY season_name, season_rank;

\echo ''
\echo '--- Q10. Calling the stored FUNCTIONS from a plain SELECT'
SELECT t.title,
       fn_prize_pool(t.tournament_id) AS prize_pool,
       t.entrants_count
  FROM tournament t
 WHERE t.status = 'COMPLETED'
 ORDER BY prize_pool DESC
 LIMIT 5;

\echo ''
\echo '--- Q11. Set-returning function: live standings of one tournament'
SELECT * FROM fn_tournament_standings(
    (SELECT MIN(tournament_id) FROM tournament)) LIMIT 10;

\echo ''
\echo '--- Q12. EXPLAIN: proof that the partial index is actually used'
EXPLAIN (COSTS OFF)
SELECT registration_id, chip_stack
  FROM registration
 WHERE is_active AND tournament_id = 1
 ORDER BY chip_stack DESC
 LIMIT 10;
