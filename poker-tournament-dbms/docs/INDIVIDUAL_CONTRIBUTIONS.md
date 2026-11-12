# Individual contributions

> Requirement 2: *"Each team member must have clearly defined
> responsibilities and contribute to both database and application
> development."*
>
> Requirement 15: *"Commits should demonstrate individual contributions of
> team members."*
>
> Rubric item 14: *Originality, individual contribution, Modification/Viva (4 marks)*

**Fill in the two names below before submitting.** The split is designed so
each member owns database work *and* application work, which is what the
requirement asks for — a split along "one does SQL, one does React" would
not satisfy it.

---

## Team

| | Name | SRN | Primary ownership |
|---|---|---|---|
| Member A | *(your name)* | *(your SRN)* | Core schema, transactions, floor operations |
| Member B | *(partner name)* | *(partner SRN)* | Vector layer, analytics, access control |

---

## Responsibility split

### Member A — schema, transactions, operations

**Database**
- ER model and the relational conversion (`docs/RELATIONAL_SCHEMA.md`)
- `db/01_schema.sql` — 19 tables, enumerated types, all 106 constraints
- `db/02_indexes.sql` — index strategy, including the partial indexes that
  enforce seat occupancy
- `db/05_procedures.sql` — `sp_register_player`, `sp_eliminate_player`,
  `sp_balance_tables`, `sp_record_hand`, `sp_refund_entry`
- Triggers for seat validation, action validation and the entrant counter
- `scripts/seed.mjs` — the tournament simulation

**Application**
- `lib/db.js` — pool, `withTransaction`, SQLSTATE→HTTP mapping
- `/api/tournaments`, `/api/tournaments/[id]`, `/api/registrations`,
  `/api/hands`, `/api/admin/balance`
- Pages: tournament list, tournament detail (standings, structure, money,
  tables, hands tabs), hand history
- Floor-operation controls that call the stored procedures

### Member B — vector layer, analytics, security

**Database**
- `db/03_functions_triggers.sql` — `fn_prize_pool`, `fn_player_roi`,
  `fn_player_age`, `fn_tournament_standings`, `fn_search_hands_semantic`
- `db/04_views.sql` — six views plus the materialised season leaderboard
- `db/06_roles_rbac.sql` — four database roles, grants, column-level
  privileges, row-level security policies
- `hand_summary` design: `VECTOR(256)`, HNSW index, JSONB metadata, GIN
  full-text index
- `sp_calculate_payouts` and the earnings/audit triggers
- `db/queries/12_nested_correlated_recursive.sql` and
  `14_vector_search.sql`

**Application**
- `lib/embedding.js` — the 256-dimension embedding model and concept lexicon
- `lib/auth.js` — bcrypt hashing, HMAC sessions, permission matrix
- `lib/api.js` — the `guard()` wrapper
- `/api/auth/*`, `/api/search`, `/api/players*`, `/api/analytics`,
  `/api/summaries/[id]`, `/api/admin/{payouts,refund,audit,rbac}`
- Pages: dashboard, player list and profile, semantic search, admin console

### Shared

- Problem statement, scope and objectives
- `docs/PROJECT_DOCUMENTATION.md`
- The two test suites (`run-tests.mjs`, `smoke-test.mjs`)
- `README.md` and `HowToRun.md`
- Demo rehearsal

---

## Making the split visible in Git history

The rubric asks for commits that *demonstrate* individual contribution, so
the history has to show it. Practical rules:

1. **Each member commits from their own machine with their own identity.**

   ```bash
   git config user.name  "Your Name"
   git config user.email "your.email@example.com"
   ```

   Both e-mail addresses should be registered on the respective GitHub
   accounts, or the commits will not be attributed.

2. **Commit in small, topical units** rather than one "final project" push.

   ```
   feat(db): add blind_level and payout_tier weak entities
   feat(db): enforce single live occupant per seat with partial index
   feat(proc): sp_register_player — atomic entry, payment, seat, snapshot
   feat(vector): hand_summary table with HNSW cosine index
   feat(api): three-mode search endpoint (semantic / lexical / hybrid)
   fix(trigger): allow vacating a seat at a broken table
   test(db): 51-case integrity suite
   docs: relational schema and conversion rules
   ```

3. **Verify the split before submitting:**

   ```bash
   git shortlog -sne            # commits per author
   git log --author="Your Name" --oneline | wc -l
   ```

   A roughly even count is the evidence the rubric is looking for.

4. **Use branches and pull requests** for larger pieces of work, so the
   history shows review as well as authorship:

   ```bash
   git checkout -b feature/vector-search
   # … work, commit …
   git push -u origin feature/vector-search
   # open a PR, have the other member review and merge
   ```

---

## Viva preparation

Each member should be able to answer on the *whole* project, not just their
half. These are the questions most likely to come up, with the file to
revise.

### Likely questions on the database design

| Question | Where the answer is |
|---|---|
| Why is `REGISTRATION` the pivot instead of `PLAYER`? | `RELATIONAL_SCHEMA.md`, Part 1 — re-entry would be unrepresentable |
| Which entities are weak, and why? | Four weak entities; identity depends on the owner |
| Show a partial key. | `blind_level.level_no`, `payout_tier.rank_from` |
| How did you convert the multivalued attribute? | `player_phone` as its own relation, Rule 4 |
| Why is `age` not stored? | Derived; would be wrong tomorrow. `fn_player_age()` |
| Which normal form, and prove it. | BCNF; `RELATIONAL_SCHEMA.md`, Part 2 |
| Where did you denormalise, and why? | `entrants_count`, so a `CHECK` can enforce the cap |
| Why a self-referencing foreign key? | Knockout chains; powers the recursive CTE |

### Likely questions on the implementation

| Question | Where the answer is |
|---|---|
| Show a transaction that would corrupt data if it were not atomic. | `sp_register_player` — four tables |
| Why a trigger instead of a `CHECK`? | A `CHECK` sees one row; `tr_validate_seat` needs `poker_table.max_seats` |
| Show a recursive query and explain the anchor. | `12_nested_correlated_recursive.sql` Q10 |
| What is the difference between a nested and a correlated subquery? | Correlated references an outer column, so it runs per outer row — Q1 vs Q5 |
| Why HNSW rather than IVFFlat? | Incremental insertion; new hands searchable immediately |
| Why cosine rather than Euclidean? | Length-invariant; on unit vectors they rank identically |
| How do you know the index is used? | Tests T49–T51 parse `EXPLAIN` output |
| Prove role-based access control is in the database. | `SET LOCAL ROLE poker_player; SELECT password_hash FROM app_user;` → permission denied |

### A live demonstration worth rehearsing

Open `psql` during the viva and run:

```sql
SET ROLE poker_player;
SELECT email, password_hash FROM app_user LIMIT 1;
-- ERROR:  permission denied for table app_user
RESET ROLE;
```

That single exchange proves requirement 12 more convincingly than any
screenshot of the UI.

---

## Originality statement

This project was designed and implemented by the team named above. The
problem statement, ER model, relational schema, stored procedures,
embedding model, application code and documentation are the team's own work.

External references consulted for technique (not code):

- PostgreSQL 16 documentation — window functions, recursive CTEs, row-level
  security
- pgvector documentation — HNSW parameters, distance operators
- Weinberger et al. (2009), *Feature Hashing for Large Scale Multitask
  Learning* — the signed hashing trick used in `lib/embedding.js`
- Cormack et al. (2009), *Reciprocal Rank Fusion* — the hybrid search
  fusion formula, `k = 60`

No existing poker-management project, tutorial or repository was copied.
