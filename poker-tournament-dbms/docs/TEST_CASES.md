# Test cases and results

Two independent suites. Both are runnable, and the results below are the
actual output, not a transcription.

```bash
npm run db:test                  # database integrity — 51 cases
node scripts/smoke-test.mjs      # application integration — 57 assertions
```

---

## Suite 1 — Database integrity (`npm run db:test`)

**51 cases, 51 passing.**

Each case runs inside a `SAVEPOINT` that is rolled back afterwards, so the
suite can be run repeatedly against the seeded database without changing a
single row.

### Testing philosophy

Most of these are **negative tests**: they assert that the database
*refuses* invalid data. That emphasis is deliberate. A constraint that has
never been violated in testing is an untested constraint, and the common
failure mode in student projects is a schema full of constraints that were
never actually exercised.

Where a case expects rejection, the suite also pins the **SQLSTATE**, so a
constraint firing for the wrong reason counts as a failure. For example,
T09 expects `23514` (check violation) specifically — if the insert were
rejected by a `NOT NULL` (`23502`) instead, the test fails even though the
statement did error.

### Results

| # | Group | Test case | Expected | Result |
|---|-------|-----------|----------|--------|
| T01 | Entity integrity | Duplicate e-mail is rejected | Rejected | PASS |
| T02 | Entity integrity | Duplicate screen name is rejected | Rejected | PASS |
| T03 | Entity integrity | Two blind levels with the same number are rejected | Rejected | PASS |
| T04 | Referential integrity | Entry for a non-existent tournament is rejected | Rejected | PASS |
| T05 | Referential integrity | Entry for a non-existent player is rejected | Rejected | PASS |
| T06 | Referential integrity | Deleting a tournament cascades to its blind levels | Succeeds | PASS |
| T07 | Referential integrity | Deleting a hand cascades to its embedding | Succeeds | PASS |
| T08 | Domain integrity | Under-age player is rejected | Rejected | PASS |
| T09 | Domain integrity | Mixed-case e-mail is rejected | Rejected | PASS |
| T10 | Domain integrity | Password hash shorter than 20 chars is rejected | Rejected | PASS |
| T11 | Domain integrity | Negative buy-in is rejected | Rejected | PASS |
| T12 | Domain integrity | Big blind smaller than small blind is rejected | Rejected | PASS |
| T13 | Domain integrity | An entry cannot eliminate itself | Rejected | PASS |
| T14 | Domain integrity | A FOLD carrying chips is rejected | Rejected | PASS |
| T15 | Domain integrity | Malformed board cards are rejected | Rejected | PASS |
| T16 | Triggers | Seat number beyond the table size is rejected | Rejected | PASS |
| T17 | Triggers | Two live players cannot hold the same seat | Rejected | PASS |
| T18 | Triggers | An action filed under the wrong hand is rejected | Rejected | PASS |
| T19 | Triggers | Paying a prize updates lifetime earnings automatically | Succeeds | PASS |
| T20 | Triggers | Registering bumps the tournament entrant counter | Succeeds | PASS |
| T21 | Triggers | A paid entry cannot be deleted | Rejected | PASS |
| T22 | Triggers | The audit log cannot be modified | Rejected | PASS |
| T23 | Triggers | Changes to an entry are written to the audit log | Succeeds | PASS |
| T24 | Procedures | sp_register_player creates entry, payment, seat and snapshot | Succeeds | PASS |
| T25 | Procedures | Re-entry into a FREEZEOUT event is refused | Rejected | PASS |
| T26 | Procedures | Paying out a tournament twice is refused | Rejected | PASS |
| T27 | Procedures | Paying out while players remain is refused | Rejected | PASS |
| T28 | Procedures | sp_record_hand rejects a hand where chips do not balance | Rejected | PASS |
| T29 | Procedures | A failed procedure leaves no partial rows (atomicity) | Succeeds | PASS |
| T30 | Procedures | sp_eliminate_player moves chips to the eliminator | Succeeds | PASS |
| T31 | Vector | All embeddings are 256-dimensional and unit length | Succeeds | PASS |
| T32 | Vector | A hand is its own nearest neighbour (similarity 1.0) | Succeeds | PASS |
| T33 | Vector | Similarity ordering is monotonic | Succeeds | PASS |
| T34 | Vector | A hand may hold only one embedding | Rejected | PASS |
| T35 | Vector | A summary shorter than 10 characters is rejected | Rejected | PASS |
| T36 | Vector | Updating a summary refreshes token_count via trigger | Succeeds | PASS |
| T37 | Views | Prize pool equals entries minus rake | Succeeds | PASS |
| T38 | Views | No tournament pays out more than its prize pool | Succeeds | PASS |
| T39 | Views | Chips are conserved inside every hand | Succeeds | PASS |
| T40 | Views | Every completed tournament has exactly one winner | Succeeds | PASS |
| T41 | Views | Derived age matches the stored date of birth | Succeeds | PASS |
| T42 | Access control | poker_player cannot read the credentials table | Rejected | PASS |
| T43 | Access control | poker_player cannot read hole cards | Rejected | PASS |
| T44 | Access control | poker_player cannot insert a tournament | Rejected | PASS |
| T45 | Access control | poker_director cannot read the credentials table | Rejected | PASS |
| T46 | Access control | poker_director cannot rewrite career earnings | Rejected | PASS |
| T47 | Access control | poker_director CAN correct a player name (column grant) | Succeeds | PASS |
| T48 | Access control | Row-level security limits a player to their own entries | Succeeds | PASS |
| T49 | Indexes | Partial index serves the live-floor query | Succeeds | PASS |
| T50 | Indexes | HNSW index serves the similarity search | Succeeds | PASS |
| T51 | Indexes | GIN index serves full-text search | Succeeds | PASS |

### Notes on individual cases

**T06, T07 — cascade behaviour.** T06 proves a deleted tournament takes its
blind levels with it. T07 is the one that matters for the hybrid design: it
proves a deleted hand takes its *embedding* with it, so the relational
store and the vector store cannot drift apart.

**T10 — plaintext passwords fail loudly.** `ck_app_user_hash_len` requires
at least 20 characters. A bcrypt hash is always 60; a plaintext password
like `hunter2` is 7 and is rejected by the database itself.

**T17 — partial unique index.** Two live players cannot hold the same seat.
The index is `UNIQUE (table_id, seat_no) WHERE vacated_at IS NULL`, so a
*vacated* seat may be reused — a plain `UNIQUE` would have destroyed the
seating history.

**T19, T20 — trigger-maintained redundancy.** These prove the two stored
derived values stay correct: registering bumps `entrants_count`, and paying
a prize raises `lifetime_earnings` by exactly the prize amount.

**T25 — format rules.** Re-entry into a `FREEZEOUT` event is refused by
`sp_register_player`. The test builds a fresh open event so the *format*
rule is what fires, rather than the "not accepting entries" rule.

**T29 — atomicity.** A deliberately doomed `sp_register_player` call leaves
the registration count unchanged — no orphan entry, no orphan payment.

**T42–T48 — access control enforced by PostgreSQL.** These connect with
`SET LOCAL ROLE` and verify that the *database* refuses the operation. They
would pass even if the entire web application were bypassed. T47 is the
positive counterpart: a director *can* correct a player's name, because the
column-level grant permits exactly that while forbidding
`lifetime_earnings`.

**T49–T51 — index usage.** These parse the `EXPLAIN` output as JSON and
assert the index name appears. A query that works but silently
sequential-scans is a performance bug these catch.

---

## Suite 2 — Application integration (`node scripts/smoke-test.mjs`)

**57 assertions, 57 passing**, against a running server and a seeded
database.

| Group | What is checked |
|---|---|
| Authentication | Anonymous requests rejected with 401; wrong password rejected; admin and director sign in; `/api/auth/me` returns the session |
| Analytics | `/api/analytics` returns populated totals, leaderboard, recursive-CTE chains, materialised view rows and 256-dimension vector stats |
| Tournaments | List, detail with structure/payouts/standings/finances, status filter, empty search |
| Players | List, profile with derived age and positional breakdown; a malicious `sort` parameter is handled safely |
| Vector search | Semantic, lexical and hybrid modes; scores in range; results ordered; structured pre-filter honoured; empty query rejected; **a paraphrased query still retrieves hands** |
| Hands | Listing; a hand whose chips do not balance is refused with 400 |
| Authorisation | Director cannot delete a tournament or issue a refund; player cannot read the RBAC matrix or create a tournament |
| Audit | Audit entries exist and carry before/after images |
| Pages | All seven pages return HTTP 200 |

### The security assertions worth highlighting

```
pass  wrong password is rejected
pass  unknown sort key falls back safely          ← ?sort=; DROP TABLE player; --
pass  director CANNOT delete a tournament         ← 403
pass  director CANNOT issue a refund              ← 403
pass  player CANNOT read the RBAC matrix          ← 403
pass  player CANNOT create a tournament           ← 403
pass  unbalanced chips are refused                ← 400
```

---

## Data integrity verification after seeding

Beyond the two suites, four invariants are checked against the whole
seeded dataset. All four hold:

| Invariant | Query | Result |
|---|---|---|
| Chips are conserved in every hand | `SUM(chips_after - chips_before) GROUP BY hand_id` | 0 violations |
| Exactly one winner per completed tournament | `COUNT(*) FILTER (WHERE finish_rank = 1)` | 0 violations |
| No tournament pays more than its pool | `SUM(prize_won) vs fn_prize_pool()` | 0 violations |
| Career earnings match the sum of prizes | `player.lifetime_earnings vs SUM(registration.prize_won)` | 0 violations |

These are the checks that prove the seed data is a genuine simulation
rather than random noise — and they are the same invariants a real
tournament director reconciles at the end of an event.

---

## Reproducing these results

```bash
npm install
cp .env.example .env.local        # fill in your PostgreSQL details
npm run db:setup                  # create every object
npm run db:seed                   # generate the dataset
npm run db:test                   # suite 1  → 51/51

npm run build && npm start &      # in another shell
node scripts/smoke-test.mjs       # suite 2  → 57/57
```

The seed generator is deterministic, so the row counts and the figures in
the report reproduce exactly.
