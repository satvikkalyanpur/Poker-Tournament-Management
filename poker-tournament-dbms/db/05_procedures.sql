-- =====================================================================
--  File   : 05_procedures.sql
--  Purpose: Stored PROCEDURES - multi-statement business operations that
--           must be ATOMIC.
--
--  Why procedures and not application code:
--    Registering a player writes to four tables. If the application did
--    it with four separate round trips and crashed between the second
--    and the third, the database would be left holding a paid entry
--    with no seat. Inside a procedure the whole operation is one
--    transaction: it either all lands or none of it does.
--
--  PostgreSQL note: a PROCEDURE invoked with CALL runs inside the
--  caller's transaction. Raising an exception rolls the whole unit back.
--  sp_close_tournament additionally demonstrates explicit COMMIT, which
--  only a PROCEDURE (never a FUNCTION) may issue.
-- =====================================================================

-- ---------------------------------------------------------------------
-- SP1. sp_register_player
--      ATOMIC: validate -> create entry -> take payment -> seat player
--              -> snapshot starting stack
--      Any failure (tournament full, duplicate entry, no free seat)
--      rolls back every one of those writes.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_register_player(
    IN  p_tournament_id INTEGER,
    IN  p_player_id     INTEGER,
    IN  p_method        txn_method DEFAULT 'CASH',
    IN  p_entry_type    entry_type DEFAULT 'BUYIN',
    INOUT p_registration_id INTEGER DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_status      tournament_status;
    v_buyin       NUMERIC(10,2);
    v_stack       INTEGER;
    v_format      tournament_format;
    v_entry_no    SMALLINT;
    v_existing    INTEGER;
    v_table_id    INTEGER;
    v_seat_no     SMALLINT;
    v_txn_type    txn_type;
BEGIN
    -- Lock the tournament row so two concurrent registrations cannot
    -- both read "one seat left" and both take it.
    SELECT t.status, t.buy_in, t.starting_stack, t.format
      INTO v_status, v_buyin, v_stack, v_format
      FROM tournament t
     WHERE t.tournament_id = p_tournament_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tournament % not found', p_tournament_id
            USING ERRCODE = 'no_data_found';
    END IF;

    IF v_status NOT IN ('SCHEDULED', 'RUNNING') THEN
        RAISE EXCEPTION 'Tournament % is % and is not accepting entries',
            p_tournament_id, v_status USING ERRCODE = 'check_violation';
    END IF;

    -- how many entries does this player already have here?
    SELECT COUNT(*) INTO v_existing
      FROM registration r
     WHERE r.tournament_id = p_tournament_id
       AND r.player_id     = p_player_id;

    IF v_existing > 0 AND v_format <> 'REENTRY' THEN
        RAISE EXCEPTION
            'Player % is already entered and % is a % event (no re-entry)',
            p_player_id, p_tournament_id, v_format
            USING ERRCODE = 'unique_violation';
    END IF;

    v_entry_no := (v_existing + 1)::SMALLINT;
    v_txn_type := CASE WHEN v_entry_no > 1 THEN 'REENTRY'::txn_type
                       ELSE 'BUYIN'::txn_type END;

    -- 1. the entry  (trigger tr_entrants_count bumps the tournament
    --    counter; the CHECK constraint rejects it if the event is full)
    INSERT INTO registration (tournament_id, player_id, entry_type,
                              entry_no, chip_stack, is_active)
    VALUES (p_tournament_id, p_player_id,
            CASE WHEN v_entry_no > 1 THEN 'REENTRY'::entry_type ELSE p_entry_type END,
            v_entry_no, v_stack, TRUE)
    RETURNING registration_id INTO p_registration_id;

    -- 2. the money
    INSERT INTO tournament_transaction (registration_id, txn_type, amount, method)
    VALUES (p_registration_id, v_txn_type, v_buyin, p_method);

    -- 3. a seat: choose the open table with the FEWEST players so the
    --    floor stays balanced as entries arrive
    SELECT pt.table_id
      INTO v_table_id
      FROM poker_table pt
      LEFT JOIN seat_assignment sa
             ON sa.table_id = pt.table_id AND sa.vacated_at IS NULL
     WHERE pt.tournament_id = p_tournament_id
       AND pt.status IN ('OPEN', 'FINAL')
     GROUP BY pt.table_id, pt.max_seats
    HAVING COUNT(sa.seat_id) < pt.max_seats
     ORDER BY COUNT(sa.seat_id) ASC, pt.table_id ASC
     LIMIT 1;

    IF v_table_id IS NULL THEN
        RAISE EXCEPTION
            'No open seat available in tournament %. Open another table first.',
            p_tournament_id USING ERRCODE = 'check_violation';
    END IF;

    -- lowest free seat number at that table
    SELECT s.n INTO v_seat_no
      FROM generate_series(1, (SELECT max_seats FROM poker_table
                                WHERE table_id = v_table_id)) AS s(n)
     WHERE NOT EXISTS (
            SELECT 1 FROM seat_assignment sa
             WHERE sa.table_id = v_table_id
               AND sa.seat_no  = s.n
               AND sa.vacated_at IS NULL)
     ORDER BY s.n
     LIMIT 1;

    INSERT INTO seat_assignment (table_id, registration_id, seat_no)
    VALUES (v_table_id, p_registration_id, v_seat_no);

    -- 4. starting-stack snapshot at level 1 (if the structure exists)
    IF EXISTS (SELECT 1 FROM blind_level
                WHERE tournament_id = p_tournament_id AND level_no = 1) THEN
        INSERT INTO chip_count_log (registration_id, tournament_id, level_no, chip_stack)
        VALUES (p_registration_id, p_tournament_id, 1, v_stack)
        ON CONFLICT (registration_id, level_no) DO NOTHING;
    END IF;

    RAISE NOTICE 'Entry % created: player % seated at table % seat %',
        p_registration_id, p_player_id, v_table_id, v_seat_no;
END;
$$;

-- ---------------------------------------------------------------------
-- SP2. sp_eliminate_player
--      ATOMIC: bust the entry, award its chips to the eliminator,
--              record who did it, free the seat.
--      finish_rank is derived as (players still alive + 1), so ranks are
--      assigned from the bottom up exactly as they are in a real event.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_eliminate_player(
    IN p_registration_id  INTEGER,
    IN p_eliminator_reg_id INTEGER DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_tournament INTEGER;
    v_chips      INTEGER;
    v_alive      INTEGER;
    v_rank       INTEGER;
BEGIN
    SELECT r.tournament_id, r.chip_stack
      INTO v_tournament, v_chips
      FROM registration r
     WHERE r.registration_id = p_registration_id
       AND r.is_active
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Entry % is not an active entry', p_registration_id
            USING ERRCODE = 'no_data_found';
    END IF;

    IF p_eliminator_reg_id = p_registration_id THEN
        RAISE EXCEPTION 'An entry cannot eliminate itself'
            USING ERRCODE = 'check_violation';
    END IF;

    -- the eliminator must be alive and in the same tournament
    IF p_eliminator_reg_id IS NOT NULL THEN
        PERFORM 1 FROM registration
         WHERE registration_id = p_eliminator_reg_id
           AND tournament_id   = v_tournament
           AND is_active;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'Eliminator % is not an active entry in tournament %',
                p_eliminator_reg_id, v_tournament
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;

    SELECT COUNT(*) INTO v_alive
      FROM registration
     WHERE tournament_id = v_tournament AND is_active;

    v_rank := v_alive;   -- this entry finishes in the place it vacates

    -- chips move to the eliminator
    IF p_eliminator_reg_id IS NOT NULL AND v_chips > 0 THEN
        UPDATE registration
           SET chip_stack = chip_stack + v_chips
         WHERE registration_id = p_eliminator_reg_id;
    END IF;

    UPDATE registration
       SET is_active            = FALSE,
           chip_stack           = 0,
           finish_rank          = v_rank,
           bust_time            = NOW(),
           eliminated_by_reg_id = p_eliminator_reg_id
     WHERE registration_id = p_registration_id;

    -- free the seat
    UPDATE seat_assignment
       SET vacated_at = NOW()
     WHERE registration_id = p_registration_id
       AND vacated_at IS NULL;

    RAISE NOTICE 'Entry % busted in place %', p_registration_id, v_rank;
END;
$$;

-- ---------------------------------------------------------------------
-- SP3. sp_calculate_payouts
--      ATOMIC: derive the prize pool, walk the payout ladder, write the
--              prize and points onto each paid entry, create PAYOUT
--              transactions, mark the tournament complete, refresh the
--              materialised leaderboard.
--
--      The earnings trigger (tr_sync_player_earnings) propagates each
--      prize into player.lifetime_earnings automatically, so career
--      totals can never disagree with event results.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_calculate_payouts(IN p_tournament_id INTEGER)
LANGUAGE plpgsql
AS $$
DECLARE
    v_pool      NUMERIC(12,2);
    v_status    tournament_status;
    v_alive     INTEGER;
    v_total_pct NUMERIC(8,3);
    v_rec       RECORD;
    v_prize     NUMERIC(12,2);
    v_points    INTEGER;
    v_paid      INTEGER := 0;
    v_field     INTEGER;
BEGIN
    SELECT t.status INTO v_status
      FROM tournament t
     WHERE t.tournament_id = p_tournament_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tournament % not found', p_tournament_id
            USING ERRCODE = 'no_data_found';
    END IF;

    IF v_status = 'COMPLETED' THEN
        RAISE EXCEPTION 'Tournament % has already been paid out', p_tournament_id
            USING ERRCODE = 'check_violation';
    END IF;

    -- the payout ladder must not promise more than 100% of the pool
    SELECT COALESCE(SUM(pct_of_pool * (rank_to - rank_from + 1)), 0)
      INTO v_total_pct
      FROM payout_tier
     WHERE tournament_id = p_tournament_id;

    IF v_total_pct > 100.001 THEN
        RAISE EXCEPTION
            'Payout ladder for tournament % totals %%% of the pool',
            p_tournament_id, v_total_pct
            USING ERRCODE = 'check_violation';
    END IF;

    -- the last entry standing is the winner
    SELECT COUNT(*) INTO v_alive
      FROM registration
     WHERE tournament_id = p_tournament_id AND is_active;

    IF v_alive = 1 THEN
        UPDATE registration
           SET is_active   = FALSE,
               finish_rank = 1,
               bust_time   = NOW()
         WHERE tournament_id = p_tournament_id AND is_active;
    ELSIF v_alive > 1 THEN
        RAISE EXCEPTION
            'Cannot pay out tournament %: % entries are still playing',
            p_tournament_id, v_alive USING ERRCODE = 'check_violation';
    END IF;

    v_pool := fn_prize_pool(p_tournament_id);

    SELECT COUNT(*) INTO v_field
      FROM registration WHERE tournament_id = p_tournament_id;

    -- walk every finishing position that falls inside a payout band
    FOR v_rec IN
        SELECT r.registration_id, r.finish_rank, pt.pct_of_pool
          FROM registration r
          JOIN payout_tier pt
            ON pt.tournament_id = r.tournament_id
           AND r.finish_rank BETWEEN pt.rank_from AND pt.rank_to
         WHERE r.tournament_id = p_tournament_id
         ORDER BY r.finish_rank
    LOOP
        v_prize := ROUND(v_pool * v_rec.pct_of_pool / 100.0, 2);

        -- ranking points: square-root decay by finishing position,
        -- scaled by field size, so deep runs in big fields score most
        v_points := GREATEST(
            ROUND(100 * SQRT(GREATEST(v_field, 1)::NUMERIC)
                      / SQRT(v_rec.finish_rank::NUMERIC))::INTEGER, 1);

        UPDATE registration
           SET prize_won      = v_prize,
               points_awarded = v_points
         WHERE registration_id = v_rec.registration_id;

        INSERT INTO tournament_transaction
               (registration_id, txn_type, amount, method)
        VALUES (v_rec.registration_id, 'PAYOUT', v_prize, 'ACCOUNT_CREDIT');

        v_paid := v_paid + 1;
    END LOOP;

    UPDATE tournament SET status = 'COMPLETED'
     WHERE tournament_id = p_tournament_id;

    -- Release every seat BEFORE breaking the tables. Without this a
    -- finished tournament would still show live occupants, because
    -- seat_assignment rows with vacated_at IS NULL mean "seated now".
    UPDATE seat_assignment sa
       SET vacated_at = NOW()
      FROM poker_table pt
     WHERE pt.table_id = sa.table_id
       AND pt.tournament_id = p_tournament_id
       AND sa.vacated_at IS NULL;

    UPDATE poker_table SET status = 'BROKEN'
     WHERE tournament_id = p_tournament_id;

    REFRESH MATERIALIZED VIEW mv_season_leaderboard;

    RAISE NOTICE 'Tournament % complete. Pool %, % entries paid.',
        p_tournament_id, v_pool, v_paid;
END;
$$;

-- ---------------------------------------------------------------------
-- SP4. sp_balance_tables
--      ATOMIC: move players off the shortest table onto the tables with
--              the most empty seats, and break the short table.
--      This is the classic "move a row between two parents without ever
--      being in an invalid state" transaction.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_balance_tables(
    IN p_tournament_id INTEGER,
    IN p_min_players   SMALLINT DEFAULT 4
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_short     RECORD;
    v_mover     RECORD;
    v_dest      INTEGER;
    v_seat      SMALLINT;
    v_moved     INTEGER := 0;
BEGIN
    -- the emptiest live table, if it is below the threshold
    SELECT pt.table_id, COUNT(sa.seat_id) AS occupied
      INTO v_short
      FROM poker_table pt
      LEFT JOIN seat_assignment sa
             ON sa.table_id = pt.table_id AND sa.vacated_at IS NULL
     WHERE pt.tournament_id = p_tournament_id
       AND pt.status = 'OPEN'
     GROUP BY pt.table_id
    HAVING COUNT(sa.seat_id) > 0
       AND COUNT(sa.seat_id) < p_min_players
     ORDER BY COUNT(sa.seat_id) ASC
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE NOTICE 'Tournament %: no table needs breaking', p_tournament_id;
        RETURN;
    END IF;

    FOR v_mover IN
        SELECT sa.seat_id, sa.registration_id
          FROM seat_assignment sa
         WHERE sa.table_id = v_short.table_id
           AND sa.vacated_at IS NULL
    LOOP
        SELECT pt.table_id INTO v_dest
          FROM poker_table pt
          LEFT JOIN seat_assignment sa2
                 ON sa2.table_id = pt.table_id AND sa2.vacated_at IS NULL
         WHERE pt.tournament_id = p_tournament_id
           AND pt.table_id <> v_short.table_id
           AND pt.status = 'OPEN'
         GROUP BY pt.table_id, pt.max_seats
        HAVING COUNT(sa2.seat_id) < pt.max_seats
         ORDER BY COUNT(sa2.seat_id) ASC
         LIMIT 1;

        EXIT WHEN v_dest IS NULL;        -- nowhere to move anybody

        SELECT s.n INTO v_seat
          FROM generate_series(1, (SELECT max_seats FROM poker_table
                                    WHERE table_id = v_dest)) AS s(n)
         WHERE NOT EXISTS (
                SELECT 1 FROM seat_assignment sa3
                 WHERE sa3.table_id = v_dest AND sa3.seat_no = s.n
                   AND sa3.vacated_at IS NULL)
         ORDER BY s.n LIMIT 1;

        -- vacate first, then seat: the partial unique indexes guarantee
        -- the player is never recorded at two tables simultaneously
        UPDATE seat_assignment SET vacated_at = NOW() WHERE seat_id = v_mover.seat_id;

        INSERT INTO seat_assignment (table_id, registration_id, seat_no)
        VALUES (v_dest, v_mover.registration_id, v_seat);

        v_moved := v_moved + 1;
    END LOOP;

    IF v_moved > 0 THEN
        UPDATE poker_table SET status = 'BROKEN' WHERE table_id = v_short.table_id;
    END IF;

    RAISE NOTICE 'Balanced tournament %: % players moved, table % broken',
        p_tournament_id, v_moved, v_short.table_id;
END;
$$;

-- ---------------------------------------------------------------------
-- SP5. sp_record_hand
--      ATOMIC: write a hand, its participants and their actions in one
--              unit, then update every participant's running stack.
--      Called by the seed generator and by the "record hand" form.
--      p_players is JSONB so one CALL can carry a whole hand:
--        [{"registration_id":1,"seat_no":3,"chips_before":20000,
--          "chips_after":24500,"hole_cards":"Ah Kd"}, ...]
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_record_hand(
    IN  p_table_id    INTEGER,
    IN  p_level_no    SMALLINT,
    IN  p_hand_no     INTEGER,
    IN  p_board       VARCHAR(14),
    IN  p_pot         NUMERIC(12,0),
    IN  p_showdown    BOOLEAN,
    IN  p_players     JSONB,
    INOUT p_hand_id   BIGINT DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_tournament INTEGER;
    v_player     JSONB;
    v_hp_id      BIGINT;
    v_sum        INTEGER := 0;
BEGIN
    SELECT tournament_id INTO v_tournament
      FROM poker_table WHERE table_id = p_table_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Table % not found', p_table_id USING ERRCODE = 'no_data_found';
    END IF;

    IF jsonb_array_length(p_players) < 2 THEN
        RAISE EXCEPTION 'A hand needs at least two participants'
            USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO hand (table_id, tournament_id, level_no, hand_no,
                      board_cards, pot_size, went_to_showdown, ended_at)
    VALUES (p_table_id, v_tournament, p_level_no, p_hand_no,
            p_board, p_pot, p_showdown, NOW())
    RETURNING hand_id INTO p_hand_id;

    FOR v_player IN SELECT * FROM jsonb_array_elements(p_players)
    LOOP
        INSERT INTO hand_player (hand_id, registration_id, seat_no, hole_cards,
                                 is_dealer, chips_before, chips_after)
        VALUES (p_hand_id,
                (v_player->>'registration_id')::INTEGER,
                (v_player->>'seat_no')::SMALLINT,
                NULLIF(v_player->>'hole_cards', ''),
                COALESCE((v_player->>'is_dealer')::BOOLEAN, FALSE),
                (v_player->>'chips_before')::INTEGER,
                (v_player->>'chips_after')::INTEGER)
        RETURNING hand_player_id INTO v_hp_id;

        -- keep the entry's running stack in step with the hand result
        UPDATE registration
           SET chip_stack = (v_player->>'chips_after')::INTEGER
         WHERE registration_id = (v_player->>'registration_id')::INTEGER;

        v_sum := v_sum + ((v_player->>'chips_after')::INTEGER
                        - (v_player->>'chips_before')::INTEGER);
    END LOOP;

    -- chip conservation: what one player wins another must lose
    IF v_sum <> 0 THEN
        RAISE EXCEPTION
            'Chip conservation violated in hand %: net change is %, expected 0',
            p_hand_id, v_sum USING ERRCODE = 'check_violation';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------
-- SP6. sp_close_tournament
--      Demonstrates EXPLICIT TRANSACTION CONTROL, which only a
--      PROCEDURE may do. Each tournament is committed on its own so a
--      failure late in a long batch does not discard the earlier work.
--      Must be called from a session with no open transaction.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_close_tournament(IN p_tournament_id INTEGER)
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE tournament
       SET status = 'COMPLETED'
     WHERE tournament_id = p_tournament_id;

    COMMIT;                      -- legal in a PROCEDURE, illegal in a FUNCTION

    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_season_leaderboard;

    COMMIT;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'sp_close_tournament failed for %: %', p_tournament_id, SQLERRM;
    RAISE;
END;
$$;

-- ---------------------------------------------------------------------
-- SP7. sp_refund_entry
--      ATOMIC compensating transaction: reverse a paid entry safely.
--      Exists because trigger tr_protect_paid_entry refuses to let a
--      paid entry be deleted outright.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_refund_entry(
    IN p_registration_id INTEGER,
    IN p_reason          TEXT DEFAULT 'Administrative refund'
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_paid NUMERIC(12,2);
    v_spend NUMERIC(12,2);
BEGIN
    SELECT r.prize_won INTO v_paid
      FROM registration r
     WHERE r.registration_id = p_registration_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Entry % not found', p_registration_id
            USING ERRCODE = 'no_data_found';
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_spend
      FROM tournament_transaction
     WHERE registration_id = p_registration_id
       AND txn_type IN ('BUYIN','REENTRY','ADDON');

    -- claw the prize back (trigger reduces lifetime_earnings in step)
    IF v_paid > 0 THEN
        UPDATE registration
           SET prize_won = 0, points_awarded = 0
         WHERE registration_id = p_registration_id;
    END IF;

    IF v_spend > 0 THEN
        INSERT INTO tournament_transaction
               (registration_id, txn_type, amount, method)
        VALUES (p_registration_id, 'REFUND', v_spend, 'ACCOUNT_CREDIT');
    END IF;

    UPDATE seat_assignment SET vacated_at = NOW()
     WHERE registration_id = p_registration_id AND vacated_at IS NULL;

    INSERT INTO audit_log (table_name, operation, row_pk, new_data)
    VALUES ('registration', 'UPDATE', p_registration_id::TEXT,
            jsonb_build_object('action', 'REFUND', 'amount', v_spend, 'reason', p_reason));

    RAISE NOTICE 'Entry % refunded %', p_registration_id, v_spend;
END;
$$;
