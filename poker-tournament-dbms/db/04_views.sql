-- =====================================================================
--  File   : 04_views.sql
--  Purpose: VIEWS (logical abstraction + a security view) and one
--           MATERIALIZED VIEW (precomputed analytics).
--
--  Views serve three distinct purposes here:
--    1. Hide join complexity from the application layer.
--    2. Expose a SAFE projection of a sensitive table (v_player_public
--       never exposes password hashes or dates of birth).
--    3. Precompute expensive aggregates (materialised leaderboard).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. v_player_profile - player with derived age and computed ROI
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_player_profile AS
SELECT  p.player_id,
        p.screen_name,
        p.first_name || ' ' || p.last_name          AS full_name,
        p.country,
        fn_player_age(p.date_of_birth)              AS age,      -- DERIVED
        p.lifetime_earnings,
        p.ranking_points,
        fn_player_roi(p.player_id)                  AS roi_pct,
        COUNT(DISTINCT r.tournament_id)             AS tournaments_played,
        COUNT(r.registration_id)                    AS total_entries,
        COUNT(*) FILTER (WHERE r.prize_won > 0)     AS times_cashed,
        COUNT(*) FILTER (WHERE r.finish_rank = 1)   AS titles,
        ROUND(
            100.0 * COUNT(*) FILTER (WHERE r.prize_won > 0)
            / NULLIF(COUNT(r.registration_id), 0), 2)            AS cash_rate_pct
  FROM  player p
  LEFT JOIN registration r ON r.player_id = p.player_id
 GROUP BY p.player_id, p.screen_name, p.first_name, p.last_name,
          p.country, p.date_of_birth, p.lifetime_earnings, p.ranking_points;

COMMENT ON VIEW v_player_profile IS
    'Player career summary. age and roi_pct are derived, never stored.';

-- ---------------------------------------------------------------------
-- 2. v_player_public - SECURITY view.
--    Granted to the player role instead of the base table, so a logged
--    in player can browse opponents without ever being able to read
--    dates of birth, e-mail addresses or password hashes.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_player_public AS
SELECT  p.player_id,
        p.screen_name,
        p.country,
        p.lifetime_earnings,
        p.ranking_points
  FROM  player p;

-- ---------------------------------------------------------------------
-- 3. v_tournament_overview - the list page in one query
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_tournament_overview AS
SELECT  t.tournament_id,
        t.title,
        t.game_type,
        t.format,
        t.status,
        t.buy_in,
        t.rake_pct,
        t.guarantee,
        t.start_time,
        v.venue_name,
        v.city,
        s.season_name,
        t.entrants_count,
        t.max_entries,
        fn_prize_pool(t.tournament_id)                      AS prize_pool, -- DERIVED
        COUNT(*) FILTER (WHERE r.is_active)                 AS players_remaining,
        COALESCE(MAX(r.prize_won), 0)                       AS largest_payout
  FROM  tournament t
  JOIN  venue  v ON v.venue_id  = t.venue_id
  LEFT  JOIN season s ON s.season_id = t.season_id
  LEFT  JOIN registration r ON r.tournament_id = t.tournament_id
 GROUP BY t.tournament_id, t.title, t.game_type, t.format, t.status,
          t.buy_in, t.rake_pct, t.guarantee, t.start_time,
          v.venue_name, v.city, s.season_name, t.entrants_count, t.max_entries;

-- ---------------------------------------------------------------------
-- 4. v_live_floor - what the floor manager sees: every occupied seat
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_live_floor AS
SELECT  pt.tournament_id,
        t.title              AS tournament_title,
        pt.table_id,
        pt.table_no,
        pt.status            AS table_status,
        st.full_name         AS dealer_name,
        sa.seat_no,
        r.registration_id,
        p.screen_name,
        r.chip_stack,
        sa.assigned_at
  FROM  poker_table pt
  JOIN  tournament t ON t.tournament_id = pt.tournament_id
  LEFT  JOIN staff st ON st.staff_id = pt.dealer_id
  LEFT  JOIN seat_assignment sa
         ON sa.table_id = pt.table_id AND sa.vacated_at IS NULL
  LEFT  JOIN registration r ON r.registration_id = sa.registration_id
  LEFT  JOIN player p ON p.player_id = r.player_id;

-- ---------------------------------------------------------------------
-- 5. v_hand_detail - a hand with its participants folded into one row
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_hand_detail AS
SELECT  h.hand_id,
        h.tournament_id,
        t.title            AS tournament_title,
        pt.table_no,
        h.hand_no,
        h.level_no,
        bl.small_blind,
        bl.big_blind,
        h.board_cards,
        h.pot_size,
        h.went_to_showdown,
        h.started_at,
        COUNT(hp.hand_player_id)                            AS players_in_hand,
        STRING_AGG(p.screen_name, ', ' ORDER BY hp.seat_no) AS participants,
        MAX(hp.net_result)                                  AS biggest_win,
        hs.summary_text
  FROM  hand h
  JOIN  poker_table pt ON pt.table_id = h.table_id
  JOIN  tournament  t  ON t.tournament_id = h.tournament_id
  JOIN  blind_level bl ON bl.tournament_id = h.tournament_id
                      AND bl.level_no      = h.level_no
  LEFT  JOIN hand_player hp ON hp.hand_id = h.hand_id
  LEFT  JOIN registration r ON r.registration_id = hp.registration_id
  LEFT  JOIN player p ON p.player_id = r.player_id
  LEFT  JOIN hand_summary hs ON hs.hand_id = h.hand_id
 GROUP BY h.hand_id, h.tournament_id, t.title, pt.table_no, h.hand_no,
          h.level_no, bl.small_blind, bl.big_blind, h.board_cards,
          h.pot_size, h.went_to_showdown, h.started_at, hs.summary_text;

-- ---------------------------------------------------------------------
-- 6. v_financial_summary - money reconciliation per tournament.
--    The house take must equal gross entries minus payouts.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_financial_summary AS
SELECT  t.tournament_id,
        t.title,
        COALESCE(SUM(tx.amount) FILTER (
            WHERE tx.txn_type IN ('BUYIN','REENTRY','ADDON')), 0) AS gross_entries,
        COALESCE(SUM(tx.amount) FILTER (WHERE tx.txn_type = 'PAYOUT'), 0)  AS total_payouts,
        COALESCE(SUM(tx.amount) FILTER (WHERE tx.txn_type = 'REFUND'), 0)  AS total_refunds,
        fn_prize_pool(t.tournament_id)                                     AS prize_pool,
        COALESCE(SUM(tx.amount) FILTER (
            WHERE tx.txn_type IN ('BUYIN','REENTRY','ADDON')), 0)
            - fn_prize_pool(t.tournament_id)                               AS house_rake,
        COUNT(DISTINCT tx.txn_id)                                          AS txn_count
  FROM  tournament t
  LEFT  JOIN registration r ON r.tournament_id = t.tournament_id
  LEFT  JOIN tournament_transaction tx ON tx.registration_id = r.registration_id
 GROUP BY t.tournament_id, t.title;

-- ---------------------------------------------------------------------
-- 7. MATERIALIZED VIEW - season leaderboard.
--    Materialised because it aggregates across every entry of a season
--    and is read on each dashboard load but changes only when a
--    tournament finishes. Refreshed by sp_calculate_payouts.
-- ---------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_season_leaderboard;
CREATE MATERIALIZED VIEW mv_season_leaderboard AS
SELECT  s.season_id,
        s.season_name,
        p.player_id,
        p.screen_name,
        p.country,
        COUNT(DISTINCT r.tournament_id)                    AS events_played,
        SUM(r.points_awarded)                              AS season_points,
        SUM(r.prize_won)                                   AS season_winnings,
        COUNT(*) FILTER (WHERE r.finish_rank = 1)          AS wins,
        COUNT(*) FILTER (WHERE r.finish_rank <= 9
                           AND r.finish_rank IS NOT NULL)  AS final_tables,
        RANK() OVER (PARTITION BY s.season_id
                     ORDER BY SUM(r.points_awarded) DESC)  AS season_rank
  FROM  season s
  JOIN  tournament  t ON t.season_id = s.season_id
  JOIN  registration r ON r.tournament_id = t.tournament_id
  JOIN  player p ON p.player_id = r.player_id
 GROUP BY s.season_id, s.season_name, p.player_id, p.screen_name, p.country;

-- a UNIQUE index is required for REFRESH ... CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_season_leaderboard
    ON mv_season_leaderboard (season_id, player_id);

COMMENT ON MATERIALIZED VIEW mv_season_leaderboard IS
    'Precomputed season standings. Refreshed when a tournament completes.';
