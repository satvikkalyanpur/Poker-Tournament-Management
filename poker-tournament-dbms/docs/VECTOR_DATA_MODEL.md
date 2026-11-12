# Vector data model and retrieval strategy

> Requirement 4: *"For NoSQL/vector components, students must document the
> data model, collections/documents, indexes, embeddings, metadata, and
> retrieval strategy."*
>
> Requirement 8: *"Students should explain: what data is converted into
> embeddings; which embedding approach/model is used; how vectors are
> stored; similarity metric used; how relevant results are retrieved."*

This document answers each of those points in order.

---

## 1. The data model

The vector component is **one document per hand**, stored in the
`hand_summary` table inside the same PostgreSQL database as every
relational row.

```sql
CREATE TABLE hand_summary (
    summary_id   BIGSERIAL     PRIMARY KEY,
    hand_id      BIGINT        NOT NULL,          -- FK → hand, CASCADE
    summary_text TEXT          NOT NULL,          -- the document
    embedding    VECTOR(256)   NOT NULL,          -- the vector
    model_name   VARCHAR(60)   NOT NULL,          -- which model produced it
    metadata     JSONB         NOT NULL,          -- filter facets
    search_tsv   TSVECTOR GENERATED ALWAYS AS
                 (to_tsvector('english', summary_text)) STORED,
    token_count  INTEGER       NOT NULL,
    created_at   TIMESTAMPTZ   NOT NULL,
    updated_at   TIMESTAMPTZ   NOT NULL,

    CONSTRAINT uq_summary_hand UNIQUE (hand_id),  -- strictly 1:1 with hand
    CONSTRAINT ck_summary_len  CHECK (char_length(summary_text) BETWEEN 10 AND 4000)
);
```

In vector-database vocabulary: the **collection** is the table, a
**document** is a row, the **vector** is `embedding`, the **payload** is
`metadata`, and the **id** is `hand_id`.

### Why it is a table rather than a separate store

Because it is 1:1 with `hand`, declaring it as a table buys a foreign key
with `ON DELETE CASCADE`. Deleting a hand removes its embedding in the same
transaction — the relational store and the vector store cannot drift apart.
No external vector service can offer that guarantee.

---

## 2. What is converted into embeddings

The natural-language narrative of each hand. For example:

> *"Action folded to NutPhantom68 in the big blind, who came in for a
> raise. StackMachine jammed the rest of their short stack in. The board
> ran out 2h 2d 5h 9s 7h. Both hands went to showdown and NutPhantom68
> scooped a pot of 89866 chips."*

Narratives are generated from structured hand facts — the position, the
action pattern, the board, the pot, the outcome — so every hand is
described in a consistent register. That consistency is what makes
similarity meaningful: two hands are close in vector space when the
*situations* are alike, not merely when the prose style matches.

**What is deliberately not embedded:** player names, chip counts and pot
sizes are present in the text but carry little semantic weight after
tokenisation, and the structured versions of those facts are already
available as SQL predicates. Numbers are the relational layer's job.

---

## 3. The embedding approach

Implemented in [`lib/embedding.js`](../lib/embedding.js). A
**256-dimension lexical feature-hashing embedding with domain concept
expansion**, L2-normalised.

### The pipeline

```
"StackMachine jammed the rest of their short stack in"
        │
        │ 1. normalise, tokenise, drop stop-words
        ▼
["stackmachine","jammed","rest","their","short","stack"]
        │
        │ 2. light suffix stemming
        ▼
["stackmachin","jam","rest","their","short","stack"]
        │
        │ 3. concept expansion through the poker lexicon
        ▼
+ ["c_allin","c_aggressive"]   (from "jammed")
+ ["c_shortstack"]             (from "short")
        │
        │ 4. add bigrams
        ▼
+ ["jam_rest","short_stack", ...]
        │
        │ 5. signed feature hashing into 256 buckets
        │    index = fnv1a(f) mod 256
        │    sign  = fnv1a(f, salt) & 1 ? +1 : -1
        │    weight = (1 + log(tf)) × (1.6 if concept else 1.0)
        ▼
Float64Array(256)
        │
        │ 6. L2-normalise
        ▼
unit vector — cosine similarity is now a plain dot product
```

### Why signed hashing

The **hashing trick** (Weinberger et al., 2009) maps an unbounded feature
space into a fixed number of dimensions without storing a vocabulary. The
random sign is what makes it work: collisions between unrelated features
cancel out in expectation rather than accumulating, so inner products are
preserved approximately.

### Why concept expansion matters

This is the component that makes the search *semantic* rather than merely
lexical. The lexicon maps surface forms to shared concept tokens:

| Surface forms in the corpus | Concept tokens added |
|---|---|
| shove, shoved, jam, jammed, all-in | `c_allin`, `c_aggressive` |
| fold, folded, check, called | `c_passive` |
| short, shortstack, desperate | `c_shortstack` |
| button, cutoff, hijack | `c_position`, `c_late` |
| busted, eliminated, knocked | `c_bust`, `c_elimination` |

A query saying *"shoved"* and a document saying *"jammed"* share no words —
but both produce `c_allin`, which is weighted 1.6× and therefore dominates
the similarity. This is why the live demo retrieves "jammed" hands for a
"shoved" query, which lexical search cannot do.

### Honest limitations

- It is **not contextual**. "Called" always contributes the same features
  regardless of surrounding words.
- Novel phrasings outside the lexicon degrade to plain lexical matching.
- Negation is invisible: "did not shove" looks like "shove".

A transformer model addresses all three. The trade was made for
reproducibility and zero external dependencies, and it is reversible in one
file — `EMBEDDING_PROVIDER=openai` switches to `text-embedding-3-small`
projected to the same 256 dimensions.

---

## 4. How vectors are stored

| Aspect | Decision |
|---|---|
| Type | `VECTOR(256)` — pgvector's native type, 4 bytes per dimension |
| Dimensions | 256 |
| Normalisation | L2 at write time, so every vector has norm 1.0 (test T31) |
| Storage size | ~1 KB per vector; ~770 vectors in the seeded dataset |
| Model tracking | `model_name` lets vectors from different models coexist |
| Co-location | Same table as the text, same database as every relational row |

### Why 256 dimensions

A compromise between expressiveness and index performance. Too few and
hash collisions degrade similarity; too many and the HNSW graph grows
without adding signal, since the vocabulary here is domain-restricted. 256
also matches the smallest projection `text-embedding-3-small` offers, so
switching providers needs no schema migration.

---

## 5. The index

```sql
CREATE INDEX ix_summary_embedding_hnsw
    ON hand_summary USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
```

| Parameter | Value | Meaning |
|---|---|---|
| `m` | 16 | Edges per node in the proximity graph |
| `ef_construction` | 64 | Candidate list size while building |
| `hnsw.ef_search` | 40 (session) | Candidate list size at query time — raises recall, costs latency |

### HNSW rather than IVFFlat

| | IVFFlat | HNSW |
|---|---|---|
| Build | Needs representative data to pick centroids | Incremental |
| New rows | Degrade recall until rebuilt | Immediately searchable |
| Build time | Faster | Slower |
| Query recall | Lower at equal speed | Higher |
| Memory | Lower | Higher |

The deciding factor is **incremental insertion**. Hand summaries are
written while the tournament is still running, and a hand must be
searchable the moment it is recorded. IVFFlat would require periodic
rebuilds, during which newly recorded hands are effectively invisible.

The operator class must match the query operator: `vector_cosine_ops`
pairs with `<=>`. Using `<->` in the `ORDER BY` would silently skip the
index. Test T50 confirms via `EXPLAIN` that the planner chooses it.

### Supporting indexes

```sql
CREATE INDEX ix_summary_fts      ON hand_summary USING GIN (search_tsv);
CREATE INDEX ix_summary_metadata ON hand_summary USING GIN (metadata jsonb_path_ops);
```

The first serves lexical search; the second serves JSONB facet
pre-filtering such as `metadata @> '{"all_in": true}'`.

---

## 6. Metadata

Every document carries a JSONB payload used to narrow the candidate set
*before* the ANN ordering runs:

```json
{
  "tournament_id": 7,
  "level_no": 9,
  "pot_bucket": "large",
  "went_to_showdown": true,
  "all_in": true,
  "street_reached": "river",
  "players": 3
}
```

| Field | Used for |
|---|---|
| `tournament_id` | Scope a search to one event |
| `pot_bucket` | `small` / `medium` / `large`, relative to the big blind |
| `went_to_showdown` | Filter to hands where cards were shown |
| `all_in` | Filter to all-in confrontations |
| `street_reached` | How far the hand went |
| `players` | Heads-up versus multi-way |

Facets are stored in JSONB rather than as columns because they are a
*search payload* that evolves with retrieval needs, not part of the
normalised model — `went_to_showdown` and `pot_size` already exist as
proper typed columns on `hand`.

---

## 7. Similarity metric

**Cosine similarity**, through pgvector's `<=>` cosine-distance operator.

```
distance   = 1 - (A · B) / (‖A‖ ‖B‖)     range [0, 2]
similarity = 1 - distance                 range [-1, 1]
```

### Why cosine rather than L2 or inner product

- Narratives vary in length, so vectors vary in magnitude before
  normalisation. Cosine compares **direction**, which is what "about the
  same thing" means. L2 would penalise a long description of the same
  situation.
- Because vectors are L2-normalised at write time, cosine distance, L2
  distance and negative inner product are **monotonically related** — they
  produce identical rankings. Query Q4 in
  [`14_vector_search.sql`](../db/queries/14_vector_search.sql) demonstrates
  this on live data. Cosine is kept because it is the one whose values are
  interpretable: 1.0 is identical, 0.0 is unrelated.

Test T32 confirms a hand is its own nearest neighbour at similarity
1.0000; test T33 confirms the top-10 ordering is monotonic.

---

## 8. Retrieval strategy

### 8.1 Semantic mode

```
user text ──embed()──> query vector
                            │
          structured pre-filter (B-tree + GIN)
          tournament / pot size / showdown / JSONB facets
                            │
          ANN ordering (HNSW, cosine)
                            │
          join to hand + tournament, return top k
```

The **pre-filter first** ordering matters. Narrowing with cheap indexed
predicates before the expensive ANN step is what keeps the query
affordable — and it is precisely the pattern an external vector service
cannot express, because it does not know about `hand.pot_size`.

### 8.2 Lexical mode

```sql
WHERE search_tsv @@ websearch_to_tsquery('english', $1)
ORDER BY ts_rank(search_tsv, websearch_to_tsquery('english', $1)) DESC
```

Present specifically as a **control**. It shows what is lost without
embeddings: a search for "shoved" misses every hand that says "jammed".

### 8.3 Hybrid mode — Reciprocal Rank Fusion

```
score(d) = Σ  1 / (k + rank_i(d))        k = 60
         over each result list i
```

Both searches run, and documents are scored by the reciprocal of their
rank in each list. A hand ranked #1 semantically and #3 lexically scores
`1/61 + 1/63`.

**Why rank-based fusion rather than score blending:** `ts_rank` and cosine
similarity are on unrelated scales with no meaningful common normalisation.
Using ranks sidesteps the problem entirely. `k = 60` is the value from the
original RRF paper (Cormack et al., 2009); it damps the influence of the
very top ranks so one list cannot dominate.

---

## 9. CRUD on the vector store

Requirement 9 of the rubric asks for read, update and delete on the vector
component, not just search.

| Operation | Entry point | Behaviour |
|---|---|---|
| **Create** | `POST /api/hands` with `narrative`; `14_vector_search.sql` Q10 | Hand and embedding written in **one transaction**; HNSW updates incrementally so the row is searchable immediately |
| **Read** | `GET /api/search`; `fn_search_hands_semantic()`; Q3–Q9 | Three modes; metadata pre-filter; joined to relational rows |
| **Update** | `PUT /api/summaries/[id]`; Q12–Q13 | **Re-embeds.** Changing text without the vector would leave the index returning the old meaning for new text |
| **Delete** | `DELETE /api/summaries/[id]`; Q14 | Direct delete; also cascades from `hand` (Q15, test T07) |

### The update rule, stated explicitly

```js
// lib → app/api/summaries/[id]/route.js
const vec = toVectorLiteral(await embed(body.summaryText));
await client.query(
  `UPDATE hand_summary
      SET summary_text = $1,
          embedding    = $2::vector,   -- re-embedded, never left stale
          model_name   = $3,
          metadata     = metadata || $4::jsonb
    WHERE summary_id = $5`, ...);
```

Text and vector are always written together. Trigger `tr_summary_touch`
then recomputes `token_count` and `updated_at`, so those cannot disagree
either (test T36).

---

## 10. Measured behaviour

From the seeded dataset (770 documents):

| Metric | Value |
|---|---|
| Documents | 770 |
| Dimensions | 256 |
| Mean L2 norm | 1.000000 |
| Mean tokens per narrative | ~35 |
| Self-similarity | 1.0000 |
| Typical top-1 similarity for a paraphrased query | 0.40 – 0.45 |
| Query latency (semantic, pre-filtered, k=10) | ~5 ms |

The similarity values deserve a word. They are lower than a transformer
would produce because feature hashing spreads signal across 256 buckets.
What matters for retrieval is not the absolute value but the **ordering**,
and the ordering is correct: a query about short-stack all-ins returns
all-in hands at the top, including ones that never use the queried word.
