-- =====================================================================
--  File   : queries/11_joins_aggregates.sql
--  Rubric : item 6 - JOIN, GROUP BY, HAVING, ORDER BY, aggregates
--
--  Read-only. Safe to run at any time.
-- =====================================================================

\echo '--- Q1. INNER JOIN across five tables: who played where, for how much'
SELECT p.screen_name,
       t.title                AS tournament,
       v.city,
       s.season_name,
       r.finish_rank,
       r.prize_won
  FROM registration r
  INNER JOIN player     p ON p.player_id     = r.player_id
  INNER JOIN tournament t ON t.tournament_id = r.tournament_id
  INNER JOIN venue      v ON v.venue_id      = t.venue_id
  INNER JOIN season     s ON s.season_id     = t.season_id
 WHERE r.prize_won > 0
 ORDER BY r.prize_won DESC
 LIMIT 10;

\echo ''
\echo '--- Q2. LEFT JOIN: every player, including those who never cashed'
SELECT p.screen_name,
       p.country,
       COUNT(r.registration_id)                      AS entries,
       COUNT(*) FILTER (WHERE r.prize_won > 0)       AS cashes,
       COALESCE(SUM(r.prize_won), 0)                 AS total_won
  FROM player p
  LEFT JOIN registration r ON r.player_id = p.player_id
 GROUP BY p.player_id, p.screen_name, p.country
 ORDER BY total_won DESC, entries DESC
 LIMIT 12;

\echo ''
\echo '--- Q3. SELF JOIN: every knockout, eliminator paired with victim'
SELECT winner_p.screen_name  AS eliminator,
       loser_p.screen_name   AS eliminated,
       t.title               AS tournament,
       loser.finish_rank     AS victim_finished
  FROM registration loser
  JOIN registration winner_r ON winner_r.registration_id = loser.eliminated_by_reg_id
  JOIN player winner_p ON winner_p.player_id = winner_r.player_id
  JOIN player loser_p  ON loser_p.player_id  = loser.player_id
  JOIN tournament t    ON t.tournament_id    = loser.tournament_id
 ORDER BY loser.bust_time DESC
 LIMIT 10;

\echo ''
\echo '--- Q4. GROUP BY + HAVING: venues that have hosted a real programme'
SELECT v.venue_name,
       v.city,
       COUNT(DISTINCT t.tournament_id)       AS tournaments_hosted,
       COUNT(r.registration_id)              AS total_entries,
       ROUND(AVG(t.buy_in), 2)               AS avg_buy_in,
       MAX(r.prize_won)                      AS biggest_prize
  FROM venue v
  JOIN tournament   t ON t.venue_id      = v.venue_id
  LEFT JOIN registration r ON r.tournament_id = t.tournament_id
 GROUP BY v.venue_id, v.venue_name, v.city
HAVING COUNT(DISTINCT t.tournament_id) >= 1
   AND COUNT(r.registration_id) > 20
 ORDER BY total_entries DESC;

\echo ''
\echo '--- Q5. Aggregate family: COUNT, SUM, AVG, MIN, MAX, STDDEV'
SELECT t.title,
       COUNT(DISTINCT r.registration_id)          AS entries,
       SUM(r.prize_won)                           AS paid_out,
       ROUND(AVG(r.prize_won), 2)                 AS avg_prize,
       MIN(r.prize_won) FILTER (WHERE r.prize_won > 0) AS smallest_cash,
       MAX(r.prize_won)                           AS biggest_cash,
       ROUND(STDDEV_POP(r.prize_won), 2)          AS prize_spread
  FROM tournament t
  JOIN registration r ON r.tournament_id = t.tournament_id
 WHERE t.status = 'COMPLETED'
 GROUP BY t.tournament_id, t.title
 ORDER BY paid_out DESC;

\echo ''
\echo '--- Q6. Aggregation over gameplay: the most aggressive players'
\echo '        (share of actions that are a bet, raise or all-in)'
SELECT p.screen_name,
       COUNT(*)                                                      AS actions,
       COUNT(*) FILTER (WHERE a.action IN ('BET','RAISE','ALLIN'))   AS aggressive,
       ROUND(100.0 * COUNT(*) FILTER (WHERE a.action IN ('BET','RAISE','ALLIN'))
             / COUNT(*), 1)                                          AS aggression_pct,
       ROUND(AVG(a.think_time_sec), 1)                               AS avg_think_sec
  FROM hand_action a
  JOIN hand_player hp ON hp.hand_player_id = a.hand_player_id
  JOIN registration r ON r.registration_id = hp.registration_id
  JOIN player p       ON p.player_id       = r.player_id
 GROUP BY p.player_id, p.screen_name
HAVING COUNT(*) >= 20
 ORDER BY aggression_pct DESC
 LIMIT 10;

\echo ''
\echo '--- Q7. GROUPING SETS: totals by game type, by format, and overall'
SELECT COALESCE(t.game_type::TEXT, 'ALL TYPES')  AS game_type,
       COALESCE(t.format::TEXT, 'ALL FORMATS')   AS format,
       COUNT(*)                                  AS tournaments,
       ROUND(AVG(t.entrants_count), 1)           AS avg_field
  FROM tournament t
 GROUP BY GROUPING SETS ((t.game_type), (t.format), ())
 ORDER BY game_type, format;

\echo ''
\echo '--- Q8. FULL OUTER JOIN: seats versus occupants on the live floor'
SELECT pt.table_no,
       sa.seat_no,
       COALESCE(p.screen_name, '(empty)') AS occupant,
       pt.status
  FROM poker_table pt
  LEFT JOIN seat_assignment sa
         ON sa.table_id = pt.table_id AND sa.vacated_at IS NULL
  FULL OUTER JOIN registration r ON r.registration_id = sa.registration_id
  LEFT JOIN player p ON p.player_id = r.player_id
 WHERE pt.tournament_id = (SELECT MIN(tournament_id) FROM tournament)
 ORDER BY pt.table_no, sa.seat_no
 LIMIT 15;

\echo ''
\echo '--- Q9. CROSS JOIN: a coverage matrix of every country vs season'
SELECT c.country, s.season_name,
       COUNT(r.registration_id) AS entries
  FROM (SELECT DISTINCT country FROM player) c
 CROSS JOIN season s
  LEFT JOIN player p ON p.country = c.country
  LEFT JOIN registration r ON r.player_id = p.player_id
  LEFT JOIN tournament t ON t.tournament_id = r.tournament_id
                        AND t.season_id = s.season_id
 GROUP BY c.country, s.season_name
 ORDER BY entries DESC
 LIMIT 10;

\echo ''
\echo '--- Q10. Set operations: UNION, INTERSECT, EXCEPT'
\echo '         players who have won a title vs players who never cashed'
(SELECT p.screen_name, 'CHAMPION' AS category
   FROM player p JOIN registration r ON r.player_id = p.player_id
  WHERE r.finish_rank = 1)
UNION
(SELECT p.screen_name, 'NEVER CASHED'
   FROM player p
  WHERE NOT EXISTS (SELECT 1 FROM registration r
                     WHERE r.player_id = p.player_id AND r.prize_won > 0))
 ORDER BY category, screen_name
 LIMIT 12;

\echo ''
\echo '--- Q11. INTERSECT: players who have both won a title AND busted first'
SELECT p.screen_name FROM player p
  JOIN registration r ON r.player_id = p.player_id WHERE r.finish_rank = 1
INTERSECT
SELECT p.screen_name FROM player p
  JOIN registration r ON r.player_id = p.player_id
  JOIN tournament t ON t.tournament_id = r.tournament_id
 WHERE r.finish_rank = t.entrants_count;

\echo ''
\echo '--- Q12. EXCEPT: countries represented among players but never among winners'
SELECT country FROM player
EXCEPT
SELECT p.country FROM player p
  JOIN registration r ON r.player_id = p.player_id
 WHERE r.finish_rank = 1;
