-- =====================================================================
--  File   : queries/10_dml_operations.sql
--  Rubric : item 6 - DML operations (INSERT / UPDATE / DELETE / SELECT)
--
--  Run with:  psql -d pokerdb -f db/queries/10_dml_operations.sql
--  Every statement here is wrapped in a transaction that is ROLLED BACK
--  at the end, so running this file never changes the demo data.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Q1. INSERT - single row with explicit column list
-- ---------------------------------------------------------------------
INSERT INTO venue (venue_name, address_line, city, country, table_capacity)
VALUES ('Harbour Lights Club', '9 Dockside Lane', 'Kochi', 'IN', 28)
RETURNING venue_id, venue_name, city;

-- ---------------------------------------------------------------------
-- Q2. INSERT - multi-row
-- ---------------------------------------------------------------------
INSERT INTO season (season_name, start_date, end_date) VALUES
    ('Winter Series 2027', DATE '2027-01-02', DATE '2027-03-31'),
    ('Spring Series 2027', DATE '2027-04-01', DATE '2027-06-30')
RETURNING season_id, season_name;

-- ---------------------------------------------------------------------
-- Q3. INSERT ... SELECT - derive rows from existing data.
--     Clone the blind structure of tournament 1 onto a new tournament.
-- ---------------------------------------------------------------------
INSERT INTO tournament (venue_id, season_id, title, game_type, format,
                        buy_in, rake_pct, starting_stack, max_entries, start_time)
SELECT venue_id, season_id, 'Cloned Structure Demo', game_type, format,
       buy_in, rake_pct, starting_stack, max_entries, NOW() + INTERVAL '30 days'
  FROM tournament
 WHERE tournament_id = 1
RETURNING tournament_id, title;

INSERT INTO blind_level (tournament_id, level_no, small_blind, big_blind,
                         ante, duration_min, is_break)
SELECT (SELECT MAX(tournament_id) FROM tournament),
       level_no, small_blind, big_blind, ante, duration_min, is_break
  FROM blind_level
 WHERE tournament_id = 1;

SELECT COUNT(*) AS cloned_levels
  FROM blind_level
 WHERE tournament_id = (SELECT MAX(tournament_id) FROM tournament);

-- ---------------------------------------------------------------------
-- Q4. INSERT ... ON CONFLICT (UPSERT)
--     Re-inserting an existing venue updates its capacity instead of
--     failing on the unique constraint.
-- ---------------------------------------------------------------------
INSERT INTO venue (venue_name, address_line, city, country, table_capacity)
VALUES ('Harbour Lights Club', '9 Dockside Lane', 'Kochi', 'IN', 36)
ON CONFLICT (venue_name, city)
DO UPDATE SET table_capacity = EXCLUDED.table_capacity,
              address_line   = EXCLUDED.address_line
RETURNING venue_id, venue_name, table_capacity;

-- ---------------------------------------------------------------------
-- Q5. UPDATE - simple, with a WHERE clause
-- ---------------------------------------------------------------------
UPDATE tournament
   SET guarantee = 150000
 WHERE tournament_id = 1
RETURNING tournament_id, title, guarantee;

-- ---------------------------------------------------------------------
-- Q6. UPDATE ... FROM - update one table using another.
--     Grant 50 bonus ranking points to every player who has reached a
--     final table (top 9) at least twice.
-- ---------------------------------------------------------------------
UPDATE player p
   SET ranking_points = p.ranking_points + 50
  FROM (SELECT r.player_id
          FROM registration r
         WHERE r.finish_rank <= 9
         GROUP BY r.player_id
        HAVING COUNT(*) >= 2) ft
 WHERE p.player_id = ft.player_id
RETURNING p.player_id, p.screen_name, p.ranking_points;

-- ---------------------------------------------------------------------
-- Q7. UPDATE with a correlated scalar subquery.
--     Recompute every entry's chip stack from its most recent snapshot.
-- ---------------------------------------------------------------------
UPDATE registration r
   SET chip_stack = COALESCE((
           SELECT c.chip_stack
             FROM chip_count_log c
            WHERE c.registration_id = r.registration_id
            ORDER BY c.level_no DESC
            LIMIT 1), r.chip_stack)
 WHERE r.is_active;

-- ---------------------------------------------------------------------
-- Q8. DELETE - with a subquery predicate.
--     Remove blind levels beyond level 15 from scheduled tournaments.
-- ---------------------------------------------------------------------
DELETE FROM blind_level
 WHERE level_no > 15
   AND tournament_id IN (SELECT tournament_id
                           FROM tournament
                          WHERE status = 'SCHEDULED')
RETURNING tournament_id, level_no;

-- ---------------------------------------------------------------------
-- Q9. DELETE with NOT EXISTS - clean up venues never used
-- ---------------------------------------------------------------------
DELETE FROM venue v
 WHERE NOT EXISTS (SELECT 1 FROM tournament t WHERE t.venue_id = v.venue_id)
RETURNING venue_id, venue_name;

-- ---------------------------------------------------------------------
-- Q10. SELECT - projection, filter, sort, pagination
-- ---------------------------------------------------------------------
SELECT t.tournament_id, t.title, t.buy_in, t.status, v.city
  FROM tournament t
  JOIN venue v ON v.venue_id = t.venue_id
 WHERE t.buy_in BETWEEN 1000 AND 25000
 ORDER BY t.start_time DESC
 LIMIT 5 OFFSET 0;

-- ---------------------------------------------------------------------
-- Q11. Demonstrating that constraints actually reject bad DML.
--      Each of these SHOULD fail; they are shown as evidence that the
--      integrity rules are live. Uncomment one at a time to see it.
-- ---------------------------------------------------------------------
-- INSERT INTO player (screen_name, first_name, last_name, date_of_birth, country)
-- VALUES ('TooYoung','Kid','Player', CURRENT_DATE - INTERVAL '12 years','IN');
--   -> ERROR: new row violates check constraint "ck_player_adult"

-- INSERT INTO app_user (email, password_hash, role)
-- VALUES ('NotLowercase@Example.com','$2a$10$abcdefghijklmnopqrstuv','PLAYER');
--   -> ERROR: violates check constraint "ck_app_user_email_fmt"

-- UPDATE registration SET eliminated_by_reg_id = registration_id WHERE registration_id = 1;
--   -> ERROR: violates check constraint "ck_reg_not_self_ko"

ROLLBACK;   -- nothing above is persisted
