# Technology justification

> Requirement 18: *"Database technology must be selected based on the
> problem requirements, and students must justify why SQL, NoSQL, or a
> vector database is appropriate for each type of data."*

The test this document has to pass is not "can we explain what we chose"
but "would a different choice have been worse, and why". Each section below
therefore names the alternative that was rejected.

---

## 1. The data splits cleanly in two

| | Structured half | Unstructured half |
|---|---|---|
| **What it is** | Players, tournaments, entries, seats, chip counts, hands, actions, money | Natural-language narratives of how each hand played out |
| **Shape** | 19 entity types, 25 foreign-key relationships | One free-text document per hand |
| **Typical question** | "What is this player's win rate from the button?" | "Show me spots where a short stack shoved into a raiser" |
| **Answered by** | Joins, aggregation, window functions | Similarity of meaning |
| **Correctness need** | Absolute — this is money | Best-effort ranking |
| **Chosen store** | PostgreSQL relations | pgvector embeddings |

Those two rows — *typical question* and *correctness need* — are the whole
argument. They are different kinds of problem, so they get different tools.

---

## 2. Why PostgreSQL for the structured core

### 2.1 The data is relational in the strict sense

Eighteen entity types connected by twenty-five foreign keys, with almost
every useful query traversing four to six of them. The positional win-rate
query joins `hand_player → registration → player` and groups by a derived
position band. The knockout-chain query walks `registration` against itself
recursively.

This is the shape relational algebra was designed for.

### 2.2 It carries money, so it needs ACID

`sp_register_player` writes to four tables:

```
registration           (the entry)
tournament_transaction (the payment)
seat_assignment        (the seat)
chip_count_log         (the starting stack)
```

If the payment is recorded and the seat is not, a player has paid to stand
up. If the seat is allocated and the payment is not, the house is short.
Neither is acceptable, so the four writes must be one atomic unit — which
is what a transaction is.

The same applies to payouts, where `sp_calculate_payouts` writes prizes and
points to every paid entry, creates payout transactions, releases seats,
closes the tournament and refreshes a materialised view. Test T29 confirms
that a failure mid-procedure leaves no partial rows.

### 2.3 The integrity rules are set-level

- "One live occupant per seat" — a uniqueness rule over a filtered subset.
- "Chips won equal chips lost" — a sum across sibling rows.
- "Payouts cannot exceed the pool" — an aggregate comparison.
- "Entries cannot exceed the cap" — a count against a limit.

A relational engine expresses all four declaratively. A document store
would push every one of them into application code, where they hold only
as long as every code path remembers them.

### 2.4 Why PostgreSQL rather than MySQL

MySQL was the other permitted SQL option and would have handled the
relational half competently — InnoDB gives full ACID, foreign keys and row
locking. PostgreSQL was chosen because this project uses six features that
MySQL either lacks or implements weakly, **all of which are actually used**:

| Feature | Used for | MySQL 8 position |
|---|---|---|
| `pgvector` | The entire semantic layer | No native vector type; would need an external service |
| `WITH RECURSIVE` + full CTE support | Knockout chains, blind clock | Supported, but with weaker optimisation |
| Partial indexes (`WHERE`) | Live-seat and active-entry rules | **Not supported** — the seating rule would move to application code |
| Generated columns + `tsvector` | `net_result`, `search_tsv` | Generated columns yes; no native full-text ranking of this quality |
| Row-level security | Per-player data isolation | **Not supported** |
| `FILTER`, `GROUPING SETS`, `LATERAL` | Analytics throughout | Partial or absent |

The decisive one is **partial indexes**. The rule "a seat has at most one
*current* occupant" is naturally expressed as:

```sql
CREATE UNIQUE INDEX ON seat_assignment (table_id, seat_no)
WHERE vacated_at IS NULL;
```

Without that, the choice is between a plain `UNIQUE (table_id, seat_no)` —
which would forbid a seat from ever being reused and destroy the seating
history — or enforcing it in application code, where a second client
bypasses it. Neither is acceptable for a rule this central.

---

## 3. Why a vector database for the narratives

### 3.1 Keyword search genuinely fails here

The corpus describes the same action many ways: "shoved", "jammed", "moved
all in", "committed the rest of their stack". A user searching for
*"short stack shoved"* wants all of them.

`LIKE '%shove%'` finds only the literal word. PostgreSQL full-text search
is better — it stems and ranks — but still matches **words**, not meaning.
The embedding approach maps all four phrasings near each other in vector
space because they share the expanded concept token `c_allin`.

This is demonstrable, not theoretical: the application exposes
**semantic**, **lexical** and **hybrid** modes side by side so the
difference can be shown live during the demo.

### 3.2 Why pgvector rather than Pinecone, Chroma or Qdrant

The decisive argument is **co-location**. This single query is only
possible when vectors and rows share one engine:

```sql
SELECT h.hand_id, t.title, hs.summary_text,
       1 - (hs.embedding <=> $1) AS similarity
  FROM hand_summary hs
  JOIN hand h       ON h.hand_id = hs.hand_id
  JOIN tournament t ON t.tournament_id = h.tournament_id
 WHERE h.went_to_showdown                 -- B-tree
   AND h.pot_size > 5000                  -- B-tree
   AND hs.metadata @> '{"all_in": true}'  -- GIN on JSONB
 ORDER BY hs.embedding <=> $1             -- HNSW
 LIMIT 10;
```

With an external vector service, this becomes:

1. Query the vector service for the top *k* hand ids.
2. Query PostgreSQL to hydrate those ids and apply the relational filters.
3. Discover too few survived the filter, go back to step 1 with a larger *k*.

That is slower, more code, and — critically — **not transactional**. There
is no way to guarantee the two systems agree. If a hand is deleted from
PostgreSQL, the vector service keeps a dangling embedding until some
reconciliation job notices.

Here, `ON DELETE CASCADE` removes the embedding with the hand, atomically.
Test T07 proves it.

| Criterion | pgvector | External service |
|---|---|---|
| Filter + rank in one query | Yes | No — two round trips |
| Transactional consistency with relational rows | Yes | No |
| Orphaned vectors possible | No (`CASCADE`) | Yes |
| Operational components | 1 | 2 |
| Scales past ~10⁸ vectors | Less well | Better |

The last row is the honest counterpoint: at a hundred million vectors a
dedicated service would win on raw ANN throughput. At this project's scale
— hundreds of thousands of hands — co-location is strictly better, and the
design would survive the migration because all vector access is funnelled
through one function, `fn_search_hands_semantic()`.

### 3.3 Why the embedding model is what it is

`lib/embedding.js` implements a 256-dimension **lexical feature-hashing
embedding with domain concept expansion** rather than calling a transformer.

**Arguments for this choice:**

- **Reproducibility.** It is deterministic. The grader running
  `npm run db:reset` gets byte-identical vectors to the ones in this report.
- **No external dependency.** No API key, no rate limit, no network access,
  no multi-gigabyte model download. The project runs offline.
- **The pipeline is identical.** Storage, HNSW index, cosine metric,
  pre-filtering, re-embedding on update — every database-level concept
  being demonstrated is the same regardless of what produces the numbers.

**The honest limitation:** it captures lexical and concept overlap, not
deep contextual meaning. It will not recognise that "he made a hero call"
and "she talked herself into calling with a marginal hand" are related
unless the lexicon connects them. A sentence-transformer would.

**Why that is acceptable:** the model is isolated behind one function. Set
`EMBEDDING_PROVIDER=openai` and `text-embedding-3-small` is used instead,
projected to the same 256 dimensions, with no schema change — the
`model_name` column already exists to distinguish vectors produced by
different models.

---

## 4. Why this is not technology for its own sake

Requirement 18 explicitly warns against including a paradigm "merely for
technology demonstration". The honest test: **remove the vector layer —
does the project still answer its own question?**

It does not. The system's stated purpose is tournament management *and
analysis*. A tournament director can get "who won" and "what did it pay"
from relations alone. But the analytical question a player brings —
"show me the spots where I shoved a short stack and got called" — is a
question about meaning over free text. Without embeddings, the answer is
"grep the narratives and hope they used your word".

Equally, removing the relational half is not an option: the vector store
cannot enforce that chips balance or that payouts reconcile.

Each paradigm covers what the other cannot. That is the definition of a
justified hybrid.

---

## 5. Application stack

| Layer | Choice | Reasoning |
|---|---|---|
| Frontend | Next.js 14 (App Router) + React 18 | Mandated by requirement 9 |
| API | Next.js Route Handlers | Requirement 10 asks for an appropriate backend layer; co-locating it avoids a second deployable |
| DB driver | `pg` with a connection pool | The reference PostgreSQL driver for Node; parameterised queries by default |
| Passwords | `bcryptjs` | Pure JavaScript, so `npm install` needs no compiler toolchain |
| Charts | Recharts | Declarative SVG charts, no canvas dependency |
| Styling | Plain CSS with custom properties | No build-time styling dependency; the whole theme is one file |

Deliberately **not** used:

- **An ORM.** The project is about SQL. An ORM would hide exactly what is
  being assessed, and would not express recursive CTEs, window functions or
  vector operators without raw-SQL escape hatches anyway.
- **A separate backend service.** Next.js route handlers satisfy the
  requirement with one deployable and one dependency tree.
- **A CSS framework.** Tailwind or Bootstrap would add a build step and
  thousands of dependencies to style nine pages.
