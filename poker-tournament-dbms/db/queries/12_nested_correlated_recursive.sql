-- =====================================================================
--  File   : queries/12_nested_correlated_recursive.sql
--  Rubric : item 7 - Nested / correlated / recursive queries (4 marks)
--
--  Read-only. Each query states what kind it is and why that kind is
--  the right tool, which is what the viva question usually turns on.
-- =====================================================================

\echo '=== PART 1: NESTED (non-correlated) SUBQUERIES ==='
\echo ''
\echo '--- Q1. Scalar subquery in WHERE: above-average buy-in tournaments'
\echo '        The inner query runs ONCE; it does not depend on the outer row.'
SELECT t.title,
       t.buy_in,
       (SELECT ROUND(AVG(buy_in), 2) FROM tournament) AS field_average
  FROM tournament t
 WHERE t.buy_in > (SELECT AVG(buy_in) FROM tournament)
 ORDER BY t.buy_in DESC;

\echo ''
\echo '--- Q2. Subquery with IN: everyone who played the biggest field'
SELECT DISTINCT p.screen_name, p.country
  FROM player p
  JOIN registration r ON r.player_id = p.player_id
 WHERE r.tournament_id IN (
         SELECT tournament_id
           FROM registration
          GROUP BY tournament_id
         HAVING COUNT(*) = (SELECT MAX(c) FROM (
                    SELECT COUNT(*) AS c FROM registration GROUP BY tournament_id) z))
 ORDER BY p.screen_name
 LIMIT 10;

\echo ''
\echo '--- Q3. Subquery in FROM (derived table): per-player volatility'
SELECT d.screen_name,
       d.hands_played,
       d.biggest_pot_won,
       d.worst_loss
  FROM (SELECT p.screen_name,
               COUNT(hp.hand_player_id)      AS hands_played,
               MAX(hp.net_result)            AS biggest_pot_won,
               MIN(hp.net_result)            AS worst_loss
          FROM hand_player hp
          JOIN registration r ON r.registration_id = hp.registration_id
          JOIN player p       ON p.player_id       = r.player_id
         GROUP BY p.player_id, p.screen_name) d
 WHERE d.hands_played > 15
 ORDER BY d.biggest_pot_won DESC
 LIMIT 10;

\echo ''
\echo '--- Q4. Subquery with ANY / ALL'
SELECT t.title, t.buy_in
  FROM tournament t
 WHERE t.buy_in >= ALL (SELECT buy_in FROM tournament WHERE status = 'COMPLETED')
 ORDER BY t.buy_in DESC
 LIMIT 3;

\echo ''
\echo '=== PART 2: CORRELATED SUBQUERIES ==='
\echo '    The inner query references a column from the OUTER query, so it'
\echo '    is evaluated once PER OUTER ROW. That is the defining difference.'
\echo ''
\echo '--- Q5. Correlated scalar subquery: each entry vs its own event average'
SELECT p.screen_name,
       t.title,
       r.chip_stack,
       (SELECT ROUND(AVG(r2.chip_stack), 0)
          FROM registration r2
         WHERE r2.tournament_id = r.tournament_id   -- <-- correlation
           AND r2.is_active) AS avg_stack_in_event
  FROM registration r
  JOIN player p     ON p.player_id     = r.player_id
  JOIN tournament t ON t.tournament_id = r.tournament_id
 WHERE r.is_active
   AND r.chip_stack > (SELECT AVG(r3.chip_stack)
                         FROM registration r3
                        WHERE r3.tournament_id = r.tournament_id
                          AND r3.is_active)
 ORDER BY r.chip_stack DESC
 LIMIT 10;

\echo ''
\echo '--- Q6. Correlated EXISTS: players who have beaten a past champion'
SELECT DISTINCT p.screen_name
  FROM player p
  JOIN registration r ON r.player_id = p.player_id
 WHERE EXISTS (
         SELECT 1
           FROM registration victim
           JOIN registration champ_entry
                ON champ_entry.player_id = victim.player_id
          WHERE victim.eliminated_by_reg_id = r.registration_id  -- correlation
            AND champ_entry.finish_rank = 1)
 ORDER BY p.screen_name
 LIMIT 10;

\echo ''
\echo '--- Q7. Correlated NOT EXISTS: tournaments where nobody re-entered'
SELECT t.tournament_id, t.title, t.format
  FROM tournament t
 WHERE NOT EXISTS (
         SELECT 1 FROM registration r
          WHERE r.tournament_id = t.tournament_id   -- correlation
            AND r.entry_no > 1)
 ORDER BY t.tournament_id;

\echo ''
\echo '--- Q8. Correlated subquery in SELECT: each player''s best finish'
SELECT p.screen_name,
       (SELECT MIN(r.finish_rank)
          FROM registration r
         WHERE r.player_id = p.player_id            -- correlation
           AND r.finish_rank IS NOT NULL) AS best_finish,
       (SELECT COUNT(*)
          FROM registration r
         WHERE r.player_id = p.player_id) AS entries
  FROM player p
 WHERE EXISTS (SELECT 1 FROM registration r WHERE r.player_id = p.player_id)
 ORDER BY best_finish NULLS LAST, entries DESC
 LIMIT 10;

\echo ''
\echo '--- Q9. LATERAL join - a correlated subquery that returns MANY rows.'
\echo '        Top 3 pots of each tournament, which a plain subquery cannot do.'
SELECT t.title, top.hand_no, top.pot_size
  FROM tournament t
 CROSS JOIN LATERAL (
         SELECT h.hand_no, h.pot_size
           FROM hand h
          WHERE h.tournament_id = t.tournament_id   -- correlation
          ORDER BY h.pot_size DESC
          LIMIT 3) top
 ORDER BY t.tournament_id, top.pot_size DESC
 LIMIT 12;

\echo ''
\echo '=== PART 3: RECURSIVE QUERIES (WITH RECURSIVE) ==='
\echo ''
\echo '--- Q10. THE ELIMINATION TREE.'
\echo '         registration.eliminated_by_reg_id is a self-referencing FK,'
\echo '         so "who did the winner knock out, and who did THEY knock'
\echo '         out" is a tree of unknown depth. No fixed number of JOINs'
\echo '         can walk it; recursion is the only correct tool.'
WITH RECURSIVE elimination_tree AS (
    -- ANCHOR: the champion of the chosen tournament
    SELECT r.registration_id,
           r.player_id,
           r.eliminated_by_reg_id,
           0                         AS depth,
           r.screen_path             AS path
      FROM (SELECT r.*, p.screen_name::TEXT AS screen_path
              FROM registration r JOIN player p ON p.player_id = r.player_id) r
     WHERE r.tournament_id = (SELECT MIN(tournament_id) FROM tournament
                               WHERE status = 'COMPLETED')
       AND r.finish_rank = 1

    UNION ALL

    -- RECURSIVE STEP: everyone eliminated by somebody already in the tree
    SELECT child.registration_id,
           child.player_id,
           child.eliminated_by_reg_id,
           parent.depth + 1,
           parent.path || ' -> ' || cp.screen_name
      FROM elimination_tree parent
      JOIN registration child ON child.eliminated_by_reg_id = parent.registration_id
      JOIN player cp ON cp.player_id = child.player_id
     WHERE parent.depth < 20            -- guard against cycles
)
SELECT depth,
       REPEAT('   ', depth) || (SELECT screen_name FROM player
                                 WHERE player_id = elimination_tree.player_id) AS knocked_out,
       path AS chain
  FROM elimination_tree
 ORDER BY depth, knocked_out
 LIMIT 25;

\echo ''
\echo '--- Q11. Recursive aggregate: how many victims does each knockout'
\echo '         chain ultimately account for? (subtree size per champion)'
WITH RECURSIVE chain AS (
    SELECT registration_id AS root_id, registration_id, 0 AS depth
      FROM registration
     WHERE finish_rank = 1
    UNION ALL
    SELECT c.root_id, r.registration_id, c.depth + 1
      FROM chain c
      JOIN registration r ON r.eliminated_by_reg_id = c.registration_id
     WHERE c.depth < 20
)
SELECT t.title,
       p.screen_name                     AS champion,
       COUNT(*) - 1                      AS players_in_their_chain,
       MAX(chain.depth)                  AS chain_depth
  FROM chain
  JOIN registration root ON root.registration_id = chain.root_id
  JOIN player p       ON p.player_id      = root.player_id
  JOIN tournament t   ON t.tournament_id  = root.tournament_id
 GROUP BY t.title, p.screen_name
 ORDER BY players_in_their_chain DESC
 LIMIT 10;

\echo ''
\echo '--- Q12. Recursive generation: project the blind-level clock.'
\echo '         Each level starts when the previous one ends, so the start'
\echo '         time of level N depends on level N-1 - a running total that'
\echo '         recursion expresses directly.'
WITH RECURSIVE level_clock AS (
    SELECT bl.tournament_id,
           bl.level_no,
           bl.small_blind,
           bl.big_blind,
           bl.duration_min,
           0                      AS minutes_from_start
      FROM blind_level bl
     WHERE bl.tournament_id = (SELECT MIN(tournament_id) FROM tournament)
       AND bl.level_no = 1

    UNION ALL

    SELECT nxt.tournament_id,
           nxt.level_no,
           nxt.small_blind,
           nxt.big_blind,
           nxt.duration_min,
           lc.minutes_from_start + lc.duration_min
      FROM level_clock lc
      JOIN blind_level nxt
        ON nxt.tournament_id = lc.tournament_id
       AND nxt.level_no      = lc.level_no + 1
)
SELECT level_no,
       small_blind || '/' || big_blind AS blinds,
       minutes_from_start              AS starts_at_minute,
       (minutes_from_start / 60) || 'h ' || (minutes_from_start % 60) || 'm' AS elapsed
  FROM level_clock
 ORDER BY level_no;

\echo ''
\echo '--- Q13. Recursive series generation without any table at all:'
\echo '         a payout ladder template for an arbitrary field size.'
WITH RECURSIVE ladder(place, pct) AS (
    SELECT 1, 30.0::NUMERIC
    UNION ALL
    SELECT place + 1, ROUND(pct * 0.68, 2)
      FROM ladder
     WHERE place < 9
)
SELECT place,
       pct AS pct_of_pool,
       ROUND(SUM(pct) OVER (ORDER BY place), 2) AS cumulative_pct
  FROM ladder
 ORDER BY place;
