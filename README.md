# PokerLytics

### Poker Tournament Management and Analysis System

**DBMS Experiential Learning — Level 3 Mini-Project**
PES University · Department of Computer Science and Engineering · Aug–Dec 2026

[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791)](https://www.postgresql.org/)
[![pgvector](https://img.shields.io/badge/pgvector-0.6-4B8BBE)](https://github.com/pgvector/pgvector)
[![Next.js](https://img.shields.io/badge/Next.js-14.2-000000)](https://nextjs.org/)
[![Tests](https://img.shields.io/badge/tests-51%20db%20%2B%2057%20api-2f9e6b)](docs/TEST_CASES.md)

---

## What this is

A tournament management and analysis system for live poker, built so that
**the database is the application** rather than merely its storage.

Running a poker tournament is a demanding data problem: hundreds of entries
across dozens of tables, players moving as the field shrinks, an accurate
chip count for every survivor, a record of who eliminated whom, and a prize
pool that must reconcile exactly with the money taken at the desk. A single
arithmetic error is a financial problem, not an inconvenience.

Three properties make it hard, and all three are database problems:

- **Operations must be atomic.** Registering a player takes money, creates
  an entry, allocates a seat and issues chips. Half of that is worse than
  none of it.
- **Integrity rules span tables.** One live player per seat. Chips won
  equal chips lost. Payouts cannot exceed the pool.
- **The most valuable data is unstructured.** "Show me the spots where a
  short stack shoved into a raiser" is a question about *meaning*. Keyword
  search cannot answer it — the corpus says "jammed".

PokerLytics addresses all three with PostgreSQL for the structured core and
pgvector for the semantic layer, in one database and one transaction scope.

---

## Highlights

| | |
|---|---|
| **19 tables** | 106 constraints, 25 foreign keys, 63 indexes |
| **7 stored procedures** | Every multi-table operation is atomic |
| **10 triggers** | Cross-table rules a `CHECK` cannot express |
| **7 views + 1 materialised** | Including a security view for the player role |
| **256-d vector search** | HNSW cosine index, semantic / lexical / hybrid modes |
| **RBAC in the database** | 4 roles, column grants, row-level security |
| **51 + 57 tests** | Database integrity and API integration, all passing |
| **~12,400 simulated rows** | Tournaments played hand by hand, not random filler |

---

## Quick start

```bash
psql -U postgres -c "CREATE DATABASE pokerdb;"
psql -U postgres -d pokerdb -c "CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;"

npm install
cp .env.example .env.local        # edit PGPASSWORD and SESSION_SECRET
npm run db:setup                  # 19 tables, 63 indexes, 106 constraints
npm run db:seed                   # ~12,400 rows of simulated tournaments
npm run build && npm start
```

Open <http://localhost:3000> and sign in as `admin@pokerlytics.dev` with
the password from `SEED_PASSWORD` (default `Passw0rd!`).

**Full instructions, including installing pgvector on every platform, are
in [HowToRun.md](HowToRun.md).**

---

## Screenshots

| Dashboard | Semantic search |
|---|---|
| ![Dashboard](docs/screenshots/02-dashboard.png) | ![Search](docs/screenshots/07-semantic-search.png) |

| Tournament detail | Admin console |
|---|---|
| ![Tournament](docs/screenshots/04-tournament-detail.png) | ![Admin](docs/screenshots/09-admin-rbac.png) |

---

## The semantic search, in one example

Search **"a short stack shoved all in and got called"**:

| Mode | Top result |
|---|---|
| **Semantic** | *"…StackMachine **jammed** the rest of their short stack in…"* |
| **Lexical** | *(the same hand is invisible — it never uses the word "shoved")* |

That gap is the entire argument for the vector layer, and the application
shows both modes side by side so it can be demonstrated rather than
asserted.

---

## Architecture

```
React 18 pages  ──▶  Next.js API routes  ──▶  lib/ (pool, auth, embedding)
                          guard(perm)              withTransaction + SET LOCAL ROLE
                                                         │
                                                         ▼
                        PostgreSQL 16 + pgvector 0.6
                        19 tables · 7 procedures · 10 triggers
                        63 indexes · 4 roles · row-level security
```

Business logic lives in the database, so every rule holds for any client —
including `psql`. See [SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md).

---

## Documentation

| Document | Contents |
|---|---|
| **[PROJECT_DOCUMENTATION.md](docs/PROJECT_DOCUMENTATION.md)** | The main report — problem, objectives, scope, design, implementation, results |
| [RELATIONAL_SCHEMA.md](docs/RELATIONAL_SCHEMA.md) | ER-to-relational conversion, functional dependencies, normal form proofs |
| [DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md) | All 147 columns — *generated from the live schema* |
| [TECHNOLOGY_JUSTIFICATION.md](docs/TECHNOLOGY_JUSTIFICATION.md) | Why PostgreSQL, why pgvector, what was rejected |
| [VECTOR_DATA_MODEL.md](docs/VECTOR_DATA_MODEL.md) | Embeddings, index parameters, similarity metric, retrieval |
| [SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md) | Layers, request lifecycle, role strategy |
| [TEST_CASES.md](docs/TEST_CASES.md) | 51 database cases + 57 API assertions, with real results |
| [INDIVIDUAL_CONTRIBUTIONS.md](docs/INDIVIDUAL_CONTRIBUTIONS.md) | Team split and viva preparation |
| [GITHUB_SETUP.md](docs/GITHUB_SETUP.md) | Publishing the repository |
| [er-diagram.drawio](docs/er-diagram.drawio) | Editable ER diagram (open at app.diagrams.net) |

---

## Repository layout

```
db/
  01_schema.sql              19 tables, 11 enums, 106 constraints
  02_indexes.sql             B-tree, partial, covering, GIN, HNSW
  03_functions_triggers.sql  14 functions, 10 triggers
  04_views.sql               7 views + materialised leaderboard
  05_procedures.sql          7 stored procedures
  06_roles_rbac.sql          roles, grants, row-level security
  queries/                   the runnable query set (rubric items 6–8)

app/                         Next.js App Router — 9 pages, 17 API routes
lib/                         db, auth, embedding, api guard
scripts/                     setup, seed, tests, data dictionary, screenshots
docs/                        the full report and diagrams
```

---

## Advanced database features

Requirement 7 asks for four. Nine are implemented:

1. **Transactions** — `sp_register_player` writes four tables atomically
2. **Views** — seven, including a security view and a materialised leaderboard
3. **Stored procedures and functions** — 7 + 14
4. **Triggers** — 10 bindings enforcing cross-table rules
5. **Indexing** — 63 indexes: composite, partial, covering, expression, GIN, HNSW
6. **Full-text search** — generated `tsvector` with a GIN index
7. **Vector similarity search** — pgvector, HNSW, cosine
8. **Row-level security** — a player reads only their own entries
9. **Generated columns** — `net_result`, `search_tsv`

---

## Verification

```bash
npm run db:test              # 51 database integrity cases
node scripts/smoke-test.mjs  # 57 API assertions (server must be running)
```

Both suites pass. Most database cases are **negative** tests — they assert
that the database *refuses* invalid data, which is the part that usually
goes untested.

---

## Licence and originality

Coursework submission. Designed and implemented by the team named in
[INDIVIDUAL_CONTRIBUTIONS.md](docs/INDIVIDUAL_CONTRIBUTIONS.md). No existing
poker-management project, tutorial or repository was copied; references
consulted for technique are credited in that document.
