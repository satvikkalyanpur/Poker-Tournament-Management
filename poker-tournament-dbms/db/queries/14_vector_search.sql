-- =====================================================================
--  File   : queries/14_vector_search.sql
--  Rubric : item 9 - Vector database feature + READ / UPDATE / DELETE
--
--  The vector layer is pgvector inside the same PostgreSQL instance.
--  That co-location is the whole argument for this design: a semantic
--  search can be filtered by a SQL predicate and joined to relational
--  rows in ONE query, with ONE transaction and ONE consistency model.
--  A separate vector service (Pinecone, Chroma) would force the
--  application to fetch ids from one system and hydrate them from
--  another, with no way to keep the two in step transactionally.
--
--  Mutating statements are wrapped in a transaction and rolled back.
-- =====================================================================

\echo '=== 1. INSPECTING THE VECTOR STORE ==='
\echo ''
\echo '--- Q1. What is actually stored'
SELECT COUNT(*)                                   AS embedded_hands,
       MIN(vector_dims(embedding))                AS dims,
       MAX(vector_dims(embedding))                AS dims_check,
       ROUND(AVG(vector_norm(embedding))::NUMERIC, 6) AS avg_l2_norm,
       COUNT(DISTINCT model_name)                 AS models_used,
       MAX(model_name)                            AS model
  FROM hand_summary;
\echo '    avg_l2_norm = 1.000000 confirms every vector is L2-normalised,'
\echo '    which is what makes cosine distance equivalent to a dot product.'

\echo ''
\echo '--- Q2. A sample stored row (vector truncated for readability)'
SELECT summary_id,
       hand_id,
       LEFT(summary_text, 90) || '...'        AS narrative,
       token_count,
       metadata->>'pot_bucket'                AS pot_bucket,
       metadata->>'street_reached'            AS street,
       LEFT(embedding::TEXT, 60) || ' ...]'   AS embedding_preview
  FROM hand_summary
 ORDER BY summary_id
 LIMIT 3;

\echo ''
\echo '=== 2. READ: SIMILARITY SEARCH ==='
\echo ''
\echo '--- Q3. "More like this": nearest neighbours of a chosen hand.'
\echo '        <=> is cosine distance; similarity = 1 - distance.'
WITH probe AS (
    SELECT hand_id, embedding, summary_text
      FROM hand_summary
     ORDER BY hand_id
     LIMIT 1
)
SELECT hs.hand_id,
       ROUND((1 - (hs.embedding <=> probe.embedding))::NUMERIC, 4) AS similarity,
       LEFT(hs.summary_text, 95) AS narrative
  FROM hand_summary hs, probe
 WHERE hs.hand_id <> probe.hand_id
 ORDER BY hs.embedding <=> probe.embedding
 LIMIT 8;

\echo ''
\echo '--- Q4. The three distance operators compared on the same pair.'
\echo '        <=> cosine, <-> euclidean/L2, <#> negative inner product.'
\echo '        On unit vectors these are monotonically related, so they'
\echo '        rank identically - the cheapest correct one is chosen.'
WITH probe AS (SELECT embedding FROM hand_summary ORDER BY hand_id LIMIT 1)
SELECT hs.hand_id,
       ROUND((hs.embedding <=> probe.embedding)::NUMERIC, 5) AS cosine_distance,
       ROUND((hs.embedding <-> probe.embedding)::NUMERIC, 5) AS l2_distance,
       ROUND((hs.embedding <#> probe.embedding)::NUMERIC, 5) AS neg_inner_product
  FROM hand_summary hs, probe
 ORDER BY hs.embedding <=> probe.embedding
 LIMIT 5;

\echo ''
\echo '--- Q5. HYBRID RETRIEVAL: structured pre-filter + semantic ordering.'
\echo '        The WHERE clause uses ordinary B-tree/GIN indexes to shrink'
\echo '        the candidate set, then HNSW orders what survives. This is'
\echo '        the pattern a standalone vector database cannot express.'
SELECT h.hand_id,
       t.title                       AS tournament,
       h.pot_size,
       hs.metadata->>'pot_bucket'    AS bucket,
       ROUND((1 - (hs.embedding <=> (
            SELECT embedding FROM hand_summary ORDER BY hand_id LIMIT 1
       )))::NUMERIC, 4)              AS similarity,
       LEFT(hs.summary_text, 70)     AS narrative
  FROM hand_summary hs
  JOIN hand h       ON h.hand_id       = hs.hand_id
  JOIN tournament t ON t.tournament_id = h.tournament_id
 WHERE h.went_to_showdown                      -- relational predicate
   AND h.pot_size > 5000                       -- relational predicate
   AND hs.metadata @> '{"all_in": true}'       -- JSONB GIN predicate
 ORDER BY hs.embedding <=> (SELECT embedding FROM hand_summary ORDER BY hand_id LIMIT 1)
 LIMIT 8;

\echo ''
\echo '--- Q6. Through the stored function the application actually calls'
SELECT hand_id, pot_size, similarity, LEFT(summary_text, 70) AS narrative
  FROM fn_search_hands_semantic(
         (SELECT embedding FROM hand_summary ORDER BY hand_id LIMIT 1),
         6,       -- limit
         NULL,    -- any tournament
         1000,    -- minimum pot
         TRUE);   -- showdowns only

\echo ''
\echo '--- Q7. LEXICAL full-text search, for contrast with the vector search.'
\echo '        Full-text matches WORDS; the vector matches MEANING. A hand'
\echo '        described as "jammed" is invisible to a search for "shove"'
\echo '        here, but is retrieved by the embedding above.'
SELECT hand_id,
       ROUND(ts_rank(search_tsv, websearch_to_tsquery('english','all in showdown'))::NUMERIC, 4) AS rank,
       LEFT(summary_text, 80) AS narrative
  FROM hand_summary
 WHERE search_tsv @@ websearch_to_tsquery('english', 'all in showdown')
 ORDER BY rank DESC
 LIMIT 6;

\echo ''
\echo '--- Q8. Aggregation over vectors: the CENTROID of each pot bucket.'
\echo '        Averaging embeddings gives a prototype vector per category,'
\echo '        which can then be used as a query - a crude but real form of'
\echo '        semantic clustering.'
SELECT metadata->>'pot_bucket'                     AS bucket,
       COUNT(*)                                    AS hands,
       ROUND(vector_norm(AVG(embedding))::NUMERIC, 4) AS centroid_norm
  FROM hand_summary
 GROUP BY metadata->>'pot_bucket'
 ORDER BY hands DESC;

\echo ''
\echo '--- Q9. Searching BY a centroid: hands most typical of a big pot'
WITH centroid AS (
    SELECT AVG(embedding)::vector(256) AS v
      FROM hand_summary
     WHERE metadata->>'pot_bucket' = 'large'
)
SELECT hs.hand_id,
       ROUND((1 - (hs.embedding <=> centroid.v))::NUMERIC, 4) AS closeness_to_prototype,
       LEFT(hs.summary_text, 80) AS narrative
  FROM hand_summary hs, centroid
 ORDER BY hs.embedding <=> centroid.v
 LIMIT 6;

\echo ''
\echo '=== 3. CREATE / UPDATE / DELETE ON THE VECTOR STORE ==='
\echo '    (wrapped in a transaction and rolled back at the end)'
BEGIN;

\echo ''
\echo '--- Q10. CREATE: a new hand, then its embedded document.'
\echo '         Every seeded hand already has a summary (1:1), so the demo'
\echo '         creates a fresh hand first - which also proves the'
\echo '         relational and vector rows are written in ONE transaction.'
INSERT INTO hand (table_id, tournament_id, level_no, hand_no, board_cards,
                  pot_size, went_to_showdown)
SELECT pt.table_id, pt.tournament_id, 1,
       COALESCE((SELECT MAX(h2.hand_no) FROM hand h2 WHERE h2.table_id = pt.table_id), 0) + 1,
       'Ah Kd 7c 2s', 48000, TRUE
  FROM poker_table pt
 ORDER BY pt.table_id
 LIMIT 1
RETURNING hand_id, table_id, hand_no;

INSERT INTO hand_summary (hand_id, summary_text, embedding, model_name, metadata)
SELECT (SELECT MAX(hand_id) FROM hand),
       'Demonstration row: the short stack moved all in from the cutoff and the big blind called to showdown.',
       (SELECT AVG(embedding)::vector(256) FROM hand_summary),
       'lexical-hash-256-v1',
       '{"demo": true, "pot_bucket": "large"}'::jsonb
RETURNING summary_id, hand_id, token_count, created_at;

\echo ''
\echo '--- Q11. READ BACK the row just created'
SELECT summary_id, hand_id, token_count,
       metadata->>'demo' AS is_demo,
       vector_dims(embedding) AS dims
  FROM hand_summary
 WHERE metadata @> '{"demo": true}';

\echo ''
\echo '--- Q12. UPDATE: re-embed a document after its text is corrected.'
\echo '         Trigger tr_summary_touch recomputes token_count and'
\echo '         updated_at automatically, so the two can never disagree.'
UPDATE hand_summary
   SET summary_text = 'Corrected narrative: the chip leader three-bet from the button, the short stack jammed, and the hand was won without a showdown.',
       embedding    = (SELECT AVG(embedding)::vector(256)
                         FROM hand_summary WHERE metadata->>'pot_bucket' = 'small'),
       metadata     = metadata || '{"revision": 2}'::jsonb
 WHERE metadata @> '{"demo": true}'
RETURNING summary_id, token_count, metadata->>'revision' AS revision,
          (updated_at > created_at) AS touched_by_trigger;

\echo ''
\echo '--- Q13. UPDATE in bulk: tag every hand whose narrative mentions a shove'
UPDATE hand_summary
   SET metadata = metadata || '{"contains_allin_language": true}'::jsonb
 WHERE search_tsv @@ websearch_to_tsquery('english', 'all in OR shoved OR jammed');

SELECT COUNT(*) AS rows_tagged
  FROM hand_summary
 WHERE metadata @> '{"contains_allin_language": true}';

\echo ''
\echo '--- Q14. DELETE: remove a document from the vector store.'
\echo '         ON DELETE CASCADE from hand means a deleted hand also'
\echo '         removes its embedding, so the two stores cannot drift.'
DELETE FROM hand_summary
 WHERE metadata @> '{"demo": true}'
RETURNING summary_id, hand_id;

\echo ''
\echo '--- Q15. Cascade proof: deleting the HAND removes the embedding too'
WITH victim AS (
    SELECT h.hand_id FROM hand h
      JOIN hand_summary hs ON hs.hand_id = h.hand_id
     ORDER BY h.hand_id DESC LIMIT 1
)
SELECT (SELECT COUNT(*) FROM hand_summary WHERE hand_id = (SELECT hand_id FROM victim))
         AS embedding_before_delete;

DELETE FROM hand WHERE hand_id = (SELECT MAX(hand_id) FROM hand);

SELECT COUNT(*) AS embedding_after_delete
  FROM hand_summary
 WHERE hand_id = (SELECT MAX(hand_id) + 1 FROM hand);

ROLLBACK;

\echo ''
\echo '=== 4. INDEX BEHAVIOUR ==='
\echo ''
\echo '--- Q16. EXPLAIN: the HNSW index serving an ANN ordering.'
\echo '         hnsw.ef_search trades recall against speed at query time:'
\echo '         a larger value explores more of the graph and finds more'
\echo '         true neighbours, at the cost of latency.'
BEGIN;
SET LOCAL hnsw.ef_search = 40;
EXPLAIN (COSTS OFF)
SELECT hand_id
  FROM hand_summary
 ORDER BY embedding <=> (SELECT embedding FROM hand_summary LIMIT 1)
 LIMIT 5;
COMMIT;

\echo ''
\echo '--- Q17. Index inventory for the vector layer'
SELECT indexname,
       CASE WHEN indexdef LIKE '%hnsw%' THEN 'HNSW (approximate NN)'
            WHEN indexdef LIKE '%gin%'  THEN 'GIN (full-text / JSONB)'
            ELSE 'B-tree' END AS kind
  FROM pg_indexes
 WHERE tablename = 'hand_summary'
 ORDER BY indexname;
