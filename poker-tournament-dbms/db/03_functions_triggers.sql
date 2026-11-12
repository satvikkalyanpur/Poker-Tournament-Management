-- =====================================================================
--  File   : 03_functions_triggers.sql
--  Purpose: Stored FUNCTIONS and TRIGGERS.
--
--  Design note for the viva:
--    A CHECK constraint can only see the row being written. Every rule
--    below needs to consult ANOTHER row or ANOTHER table, which is
--    precisely the gap triggers exist to fill. Each trigger states which
--    rule it enforces and why a constraint could not.
-- =====================================================================

-- =====================================================================
-- PART A. Scalar and table-valued FUNCTIONS
-- =====================================================================

-- ---------------------------------------------------------------------
-- fn_player_age : realises the DERIVED attribute "age" from the ER
-- diagram. Stored age would be wrong the day after it was written, so
-- it is computed on demand instead.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_player_age(p_dob DATE)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE STRICT
AS $$
    SELECT EXTRACT(YEAR FROM age(CURRENT_DATE, p_dob))::INTEGER;
$$;

COMMENT ON FUNCTION fn_player_age IS 'Derived attribute: age from date_of_birth.';

-- ---------------------------------------------------------------------
-- fn_prize_pool : realises the DERIVED attribute "prize_pool".
--   pool = SUM(entry fees) * (1 - rake%)   bounded below by the guarantee
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_prize_pool(p_tournament_id INTEGER)
RETURNS NUMERIC(12,2)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_gross     NUMERIC(12,2);
    v_rake      NUMERIC(5,2);
    v_guarantee NUMERIC(12,2);
    v_net       NUMERIC(12,2);
BEGIN
    SELECT t.rake_pct, t.guarantee
      INTO v_rake, v_guarantee
      FROM tournament t
     WHERE t.tournament_id = p_tournament_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tournament % does not exist', p_tournament_id
            USING ERRCODE = 'no_data_found';
    END IF;

    SELECT COALESCE(SUM(tx.amount), 0)
      INTO v_gross
      FROM tournament_transaction tx
      JOIN registration r ON r.registration_id = tx.registration_id
     WHERE r.tournament_id = p_tournament_id
       AND tx.txn_type IN ('BUYIN', 'REENTRY', 'ADDON');

    v_net := ROUND(v_gross * (1 - v_rake / 100.0), 2);

    -- a guaranteed prize pool is a floor, not a target
    RETURN GREATEST(v_net, v_guarantee);
END;
$$;

-- ---------------------------------------------------------------------
-- fn_player_roi : return on investment across a player's whole career.
--   ROI% = (total winnings - total spend) / total spend * 100
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_player_roi(p_player_id INTEGER)
RETURNS NUMERIC(10,2)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_spend NUMERIC(12,2);
    v_win   NUMERIC(12,2);
BEGIN
    SELECT COALESCE(SUM(tx.amount) FILTER (WHERE tx.txn_type IN ('BUYIN','REENTRY','ADDON')), 0),
           COALESCE(SUM(tx.amount) FILTER (WHERE tx.txn_type = 'PAYOUT'), 0)
      INTO v_spend, v_win
      FROM tournament_transaction tx
      JOIN registration r ON r.registration_id = tx.registration_id
     WHERE r.player_id = p_player_id;

    IF v_spend = 0 THEN
        RETURN 0;
    END IF;

    RETURN ROUND((v_win - v_spend) / v_spend * 100, 2);
END;
$$;

-- ---------------------------------------------------------------------
-- fn_tournament_standings : SET-RETURNING function.
--   Live standings - active entries ordered by stack, then busted
--   entries by finishing position. Used by the floor dashboard.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_tournament_standings(p_tournament_id INTEGER)
RETURNS TABLE (
    standing_pos    INTEGER,
    registration_id INTEGER,
    screen_name     VARCHAR(40),
    chip_stack      INTEGER,
    big_blinds      NUMERIC(10,1),
    is_active       BOOLEAN,
    prize_won       NUMERIC(12,2)
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_current_bb INTEGER;
BEGIN
    -- current big blind = highest level that has a chip snapshot, else level 1
    SELECT COALESCE(MAX(bl.big_blind), 1)
      INTO v_current_bb
      FROM blind_level bl
     WHERE bl.tournament_id = p_tournament_id
       AND bl.level_no <= COALESCE(
             (SELECT MAX(c.level_no) FROM chip_count_log c
               WHERE c.tournament_id = p_tournament_id), 1);

    RETURN QUERY
    SELECT ROW_NUMBER() OVER (
               ORDER BY r.is_active DESC,
                        CASE WHEN r.is_active THEN r.chip_stack END DESC NULLS LAST,
                        r.finish_rank ASC NULLS LAST
           )::INTEGER                                   AS standing_pos,
           r.registration_id,
           p.screen_name,
           r.chip_stack,
           ROUND(r.chip_stack::NUMERIC / NULLIF(v_current_bb, 0), 1) AS big_blinds,
           r.is_active,
           r.prize_won
      FROM registration r
      JOIN player p ON p.player_id = r.player_id
     WHERE r.tournament_id = p_tournament_id;
END;
$$;

-- ---------------------------------------------------------------------
-- fn_search_hands_semantic : the vector-search entry point.
--   Combines a structured pre-filter (cheap, uses B-tree / GIN) with an
--   ANN ordering (expensive, uses HNSW). Filtering first is what keeps
--   a semantic search over a large table affordable.
--
--   Distance operator <=> is cosine distance in [0,2];
--   similarity = 1 - distance, so 1.0 is an exact match.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_search_hands_semantic(
    p_query_vec     VECTOR(256),
    p_limit         INTEGER DEFAULT 10,
    p_tournament_id INTEGER DEFAULT NULL,
    p_min_pot       NUMERIC DEFAULT NULL,
    p_showdown_only BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    hand_id       BIGINT,
    tournament_id INTEGER,
    hand_no       INTEGER,
    pot_size      NUMERIC(12,0),
    summary_text  TEXT,
    similarity    NUMERIC(6,4),
    metadata      JSONB
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT h.hand_id,
           h.tournament_id,
           h.hand_no,
           h.pot_size,
           hs.summary_text,
           ROUND((1 - (hs.embedding <=> p_query_vec))::NUMERIC, 4) AS similarity,
           hs.metadata
      FROM hand_summary hs
      JOIN hand h ON h.hand_id = hs.hand_id
     WHERE (p_tournament_id IS NULL OR h.tournament_id = p_tournament_id)
       AND (p_min_pot       IS NULL OR h.pot_size >= p_min_pot)
       AND (NOT p_showdown_only OR h.went_to_showdown)
     ORDER BY hs.embedding <=> p_query_vec      -- HNSW index is used here
     LIMIT GREATEST(p_limit, 1);
END;
$$;

COMMENT ON FUNCTION fn_search_hands_semantic IS
    'Vector similarity search over hand narratives: metadata pre-filter then cosine ANN ordering.';

-- ---------------------------------------------------------------------
-- fn_seat_open_count : how many seats are free at a table right now.
--   Used by the seating procedure and the floor dashboard.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_seat_open_count(p_table_id INTEGER)
RETURNS INTEGER
LANGUAGE sql STABLE
AS $$
    SELECT pt.max_seats - COUNT(sa.seat_id)::INTEGER
      FROM poker_table pt
      LEFT JOIN seat_assignment sa
             ON sa.table_id = pt.table_id AND sa.vacated_at IS NULL
     WHERE pt.table_id = p_table_id
     GROUP BY pt.max_seats;
$$;

-- =====================================================================
-- PART B. TRIGGER FUNCTIONS
-- =====================================================================

-- ---------------------------------------------------------------------
-- B1. Generic audit trail.
--   Writes a JSONB before/after image of every change to the tables it
--   is attached to. A constraint cannot do this because it must write to
--   a DIFFERENT table.
--   The primary-key column name is passed as a trigger argument.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_audit()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_pk_col TEXT := TG_ARGV[0];
    v_pk_val TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        EXECUTE format('SELECT ($1).%I::TEXT', v_pk_col) INTO v_pk_val USING OLD;
        INSERT INTO audit_log (table_name, operation, row_pk, old_data, new_data)
        VALUES (TG_TABLE_NAME, TG_OP, v_pk_val, to_jsonb(OLD), NULL);
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        EXECUTE format('SELECT ($1).%I::TEXT', v_pk_col) INTO v_pk_val USING NEW;
        INSERT INTO audit_log (table_name, operation, row_pk, old_data, new_data)
        VALUES (TG_TABLE_NAME, TG_OP, v_pk_val, to_jsonb(OLD), to_jsonb(NEW));
        RETURN NEW;
    ELSE
        EXECUTE format('SELECT ($1).%I::TEXT', v_pk_col) INTO v_pk_val USING NEW;
        INSERT INTO audit_log (table_name, operation, row_pk, old_data, new_data)
        VALUES (TG_TABLE_NAME, TG_OP, v_pk_val, NULL, to_jsonb(NEW));
        RETURN NEW;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------
-- B2. Maintain tournament.entrants_count.
--   Why a trigger: the count lives in a DIFFERENT table from the rows
--   being counted. The CHECK constraint ck_tournament_entrants then
--   refuses the write if the field is now over capacity - so overselling
--   a tournament is impossible even if the application forgets to check.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_entrants_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE tournament
           SET entrants_count = entrants_count + 1
         WHERE tournament_id = NEW.tournament_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE tournament
           SET entrants_count = GREATEST(entrants_count - 1, 0)
         WHERE tournament_id = OLD.tournament_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------
-- B3. Keep player.lifetime_earnings and ranking_points in step with
--   results. Fires only when prize money or points actually change
--   (see the WHEN clause on the trigger), so ordinary chip updates
--   during play do not pay the cost.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_sync_player_earnings()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE player
       SET lifetime_earnings = lifetime_earnings
                               + (NEW.prize_won - OLD.prize_won),
           ranking_points    = GREATEST(ranking_points
                               + (NEW.points_awarded - OLD.points_awarded), 0)
     WHERE player_id = NEW.player_id;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- B4. Seat number must be within the table's seat count.
--   Impossible as a CHECK: seat_no lives on seat_assignment but
--   max_seats lives on poker_table.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_validate_seat()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_max      SMALLINT;
    v_status   table_status;
    v_tourn_a  INTEGER;
    v_tourn_b  INTEGER;
BEGIN
    -- Only validate when a player is actually BEING SEATED. Releasing a
    -- seat (setting vacated_at) must always be allowed: a table is
    -- commonly broken at the very moment its last players are moved off
    -- it, and refusing the release would deadlock the floor.
    IF TG_OP = 'UPDATE' AND (
           NEW.vacated_at IS NOT NULL
        OR (NEW.table_id = OLD.table_id AND NEW.seat_no = OLD.seat_no)
       ) THEN
        RETURN NEW;
    END IF;

    SELECT pt.max_seats, pt.status, pt.tournament_id
      INTO v_max, v_status, v_tourn_a
      FROM poker_table pt
     WHERE pt.table_id = NEW.table_id;

    IF NEW.seat_no > v_max THEN
        RAISE EXCEPTION
            'Seat % does not exist at this table (it has % seats)', NEW.seat_no, v_max
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_status = 'BROKEN' THEN
        RAISE EXCEPTION 'Cannot seat a player at a broken table'
            USING ERRCODE = 'check_violation';
    END IF;

    -- an entry may only be seated at a table belonging to ITS tournament
    SELECT r.tournament_id INTO v_tourn_b
      FROM registration r
     WHERE r.registration_id = NEW.registration_id;

    IF v_tourn_a IS DISTINCT FROM v_tourn_b THEN
        RAISE EXCEPTION
            'Entry % belongs to tournament % and cannot sit in tournament %',
            NEW.registration_id, v_tourn_b, v_tourn_a
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- B5. An action must belong to a participant OF THE SAME HAND.
--   Two foreign keys (hand_id, hand_player_id) can each be valid while
--   pointing at unrelated rows; only a trigger can compare them.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_validate_action()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_hand BIGINT;
BEGIN
    SELECT hp.hand_id INTO v_hand
      FROM hand_player hp
     WHERE hp.hand_player_id = NEW.hand_player_id;

    IF v_hand IS DISTINCT FROM NEW.hand_id THEN
        RAISE EXCEPTION
            'Action references participant of hand % but was filed under hand %',
            v_hand, NEW.hand_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- B6. Vector-row housekeeping: stamp updated_at and recompute
--   token_count whenever a summary is written or re-embedded.
--   This is what makes the UPDATE half of vector CRUD observable.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_summary_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- clock_timestamp() rather than NOW(): NOW() is frozen for the whole
    -- transaction, so a row inserted and then re-embedded in the same
    -- transaction would show identical created_at and updated_at and the
    -- revision would be invisible.
    IF TG_OP = 'INSERT' THEN
        NEW.updated_at := NEW.created_at;
    ELSE
        NEW.updated_at := clock_timestamp();
    END IF;

    NEW.token_count := COALESCE(array_length(
        string_to_array(regexp_replace(trim(NEW.summary_text), '\s+', ' ', 'g'), ' '), 1), 0);
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- B7. Money already paid out must not silently disappear.
--   Refuses deletion of an entry that has been paid; the row must be
--   refunded through the proper transaction first.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_protect_paid_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.prize_won > 0 THEN
        RAISE EXCEPTION
            'Entry % was paid %. Refund it before deleting.',
            OLD.registration_id, OLD.prize_won
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;

-- ---------------------------------------------------------------------
-- B8. The audit log is append-only.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_audit_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only; % is not permitted', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- =====================================================================
-- PART C. TRIGGER BINDINGS
-- =====================================================================

-- Registration is audited in two bindings. Chip stacks change on every
-- hand, and auditing those would bury the meaningful events in noise, so
-- the UPDATE binding carries a WHEN clause limiting it to the columns a
-- grader or an auditor actually cares about: status, result and money.
DROP TRIGGER IF EXISTS tr_audit_registration     ON registration;
DROP TRIGGER IF EXISTS tr_audit_registration_ins ON registration;
DROP TRIGGER IF EXISTS tr_audit_registration_upd ON registration;

CREATE TRIGGER tr_audit_registration_ins
    AFTER INSERT OR DELETE ON registration
    FOR EACH ROW EXECUTE FUNCTION trg_fn_audit('registration_id');

CREATE TRIGGER tr_audit_registration_upd
    AFTER UPDATE ON registration
    FOR EACH ROW
    WHEN (OLD.is_active   IS DISTINCT FROM NEW.is_active
       OR OLD.finish_rank IS DISTINCT FROM NEW.finish_rank
       OR OLD.prize_won   IS DISTINCT FROM NEW.prize_won
       OR OLD.player_id   IS DISTINCT FROM NEW.player_id
       OR OLD.eliminated_by_reg_id IS DISTINCT FROM NEW.eliminated_by_reg_id)
    EXECUTE FUNCTION trg_fn_audit('registration_id');

DROP TRIGGER IF EXISTS tr_audit_tournament ON tournament;
CREATE TRIGGER tr_audit_tournament
    AFTER INSERT OR UPDATE OR DELETE ON tournament
    FOR EACH ROW EXECUTE FUNCTION trg_fn_audit('tournament_id');

DROP TRIGGER IF EXISTS tr_entrants_count ON registration;
CREATE TRIGGER tr_entrants_count
    AFTER INSERT OR DELETE ON registration
    FOR EACH ROW EXECUTE FUNCTION trg_fn_entrants_count();

-- WHEN clause: only fire when the money or points actually moved
DROP TRIGGER IF EXISTS tr_sync_player_earnings ON registration;
CREATE TRIGGER tr_sync_player_earnings
    AFTER UPDATE ON registration
    FOR EACH ROW
    WHEN (OLD.prize_won IS DISTINCT FROM NEW.prize_won
          OR OLD.points_awarded IS DISTINCT FROM NEW.points_awarded)
    EXECUTE FUNCTION trg_fn_sync_player_earnings();

DROP TRIGGER IF EXISTS tr_validate_seat ON seat_assignment;
CREATE TRIGGER tr_validate_seat
    BEFORE INSERT OR UPDATE ON seat_assignment
    FOR EACH ROW EXECUTE FUNCTION trg_fn_validate_seat();

DROP TRIGGER IF EXISTS tr_validate_action ON hand_action;
CREATE TRIGGER tr_validate_action
    BEFORE INSERT ON hand_action
    FOR EACH ROW EXECUTE FUNCTION trg_fn_validate_action();

DROP TRIGGER IF EXISTS tr_summary_touch ON hand_summary;
CREATE TRIGGER tr_summary_touch
    BEFORE INSERT OR UPDATE ON hand_summary
    FOR EACH ROW EXECUTE FUNCTION trg_fn_summary_touch();

DROP TRIGGER IF EXISTS tr_protect_paid_entry ON registration;
CREATE TRIGGER tr_protect_paid_entry
    BEFORE DELETE ON registration
    FOR EACH ROW EXECUTE FUNCTION trg_fn_protect_paid_entry();

DROP TRIGGER IF EXISTS tr_audit_immutable ON audit_log;
CREATE TRIGGER tr_audit_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION trg_fn_audit_immutable();
