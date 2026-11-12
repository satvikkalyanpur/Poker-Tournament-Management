-- =====================================================================
--  File   : 02_indexes.sql
--  Purpose: Access-path design - B-tree, composite, partial, covering,
--           expression, GIN full-text and HNSW vector indexes.
--
--  Every index below answers a query that the application actually runs;
--  none is decorative. The query it serves is named above each one.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Foreign-key support indexes
--    PostgreSQL does NOT auto-index the child side of a foreign key.
--    Without these, every parent DELETE or UPDATE does a sequential scan
--    of the child table to enforce the constraint.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_player_user            ON player (user_id);
CREATE INDEX IF NOT EXISTS ix_tournament_venue       ON tournament (venue_id);
CREATE INDEX IF NOT EXISTS ix_tournament_season      ON tournament (season_id);
CREATE INDEX IF NOT EXISTS ix_reg_tournament         ON registration (tournament_id);
CREATE INDEX IF NOT EXISTS ix_reg_player             ON registration (player_id);
CREATE INDEX IF NOT EXISTS ix_reg_eliminator         ON registration (eliminated_by_reg_id);
CREATE INDEX IF NOT EXISTS ix_txn_registration       ON tournament_transaction (registration_id);
CREATE INDEX IF NOT EXISTS ix_table_tournament       ON poker_table (tournament_id);
CREATE INDEX IF NOT EXISTS ix_seat_registration      ON seat_assignment (registration_id);
CREATE INDEX IF NOT EXISTS ix_chip_registration      ON chip_count_log (registration_id);
CREATE INDEX IF NOT EXISTS ix_hand_table             ON hand (table_id);
CREATE INDEX IF NOT EXISTS ix_hp_registration        ON hand_player (registration_id);
CREATE INDEX IF NOT EXISTS ix_action_hand_player     ON hand_action (hand_player_id);

-- ---------------------------------------------------------------------
-- 2. Composite index - serves "replay this hand in order"
--    SELECT ... FROM hand_action WHERE hand_id = $1 ORDER BY action_seq
--    The column order matters: equality column first, sort column second,
--    which lets the planner satisfy both the filter and the ORDER BY
--    from one index with no sort step.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_action_hand_seq
    ON hand_action (hand_id, action_seq);

-- ---------------------------------------------------------------------
-- 3. Composite index - serves the chip-trajectory chart
--    SELECT level_no, chip_stack FROM chip_count_log
--     WHERE registration_id = $1 ORDER BY level_no
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_chip_reg_level
    ON chip_count_log (registration_id, level_no);

-- ---------------------------------------------------------------------
-- 4. Partial index - the live-floor view only ever asks for ACTIVE
--    entries, which are a small minority once a tournament is running.
--    Indexing only those rows keeps the index small and hot in cache.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_reg_active_by_tournament
    ON registration (tournament_id, chip_stack DESC)
    WHERE is_active;

-- ---------------------------------------------------------------------
-- 5. Partial index - leaderboard only cares about entries that cashed
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_reg_cashed
    ON registration (player_id, prize_won DESC)
    WHERE prize_won > 0;

-- ---------------------------------------------------------------------
-- 6. Expression index - case-insensitive player lookup from the search box
--    SELECT ... WHERE lower(screen_name) LIKE lower($1) || '%'
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_player_screen_lower
    ON player (lower(screen_name) varchar_pattern_ops);

-- ---------------------------------------------------------------------
-- 7. Covering index (INCLUDE) - the tournament list page reads title and
--    buy-in straight out of the index, never touching the heap.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_tournament_status_start
    ON tournament (status, start_time DESC)
    INCLUDE (title, buy_in);

-- ---------------------------------------------------------------------
-- 8. Descending index - "biggest pots" analytics page
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_hand_pot_desc
    ON hand (tournament_id, pot_size DESC);

-- ---------------------------------------------------------------------
-- 9. GIN full-text index on the generated tsvector column.
--    Supports LEXICAL search, which the report contrasts against the
--    SEMANTIC (vector) search in section 14 of the query set.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_summary_fts
    ON hand_summary USING GIN (search_tsv);

-- ---------------------------------------------------------------------
-- 10. GIN index on JSONB metadata - supports pre-filtering a vector
--     search by structured facets, e.g.
--     WHERE metadata @> '{"went_to_showdown": true}'
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_summary_metadata
    ON hand_summary USING GIN (metadata jsonb_path_ops);

-- ---------------------------------------------------------------------
-- 11. HNSW vector index for approximate nearest-neighbour search.
--
--     Why HNSW rather than IVFFlat:
--       * IVFFlat must be built AFTER the data is loaded and needs a
--         representative sample to pick centroids; rebuilding is required
--         as the table grows.
--       * HNSW is a graph index built incrementally, so new hands become
--         searchable immediately on INSERT - which matters here because
--         summaries are written while the tournament is still running.
--
--     Operator class vector_cosine_ops matches the <=> (cosine distance)
--     operator used by the application. The index is only used if the
--     query's ORDER BY uses the SAME operator.
--
--     m = 16            : edges per node (graph connectivity)
--     ef_construction=64: candidate list size while building
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_summary_embedding_hnsw
    ON hand_summary USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- ---------------------------------------------------------------------
-- 12. Audit log lookup by table and time
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_audit_table_time
    ON audit_log (table_name, changed_at DESC);

-- Refresh planner statistics so the demo EXPLAIN plans are honest.
ANALYZE;
