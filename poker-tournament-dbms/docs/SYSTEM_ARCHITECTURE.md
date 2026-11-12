# System architecture

---

## 1. Layered view

```
┌─────────────────────────────────────────────────────────────────────┐
│  PRESENTATION — React 18 client components                          │
│                                                                     │
│  /login        /dashboard     /tournaments    /tournaments/[id]     │
│  /players      /players/[id]  /hands          /search      /admin   │
│                                                                     │
│  State: React hooks. Charts: Recharts. Styling: plain CSS tokens.   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  fetch(), JSON over HTTP
                               │  session cookie (HttpOnly, SameSite=Lax)
┌──────────────────────────────▼──────────────────────────────────────┐
│  API — Next.js 14 Route Handlers (server-only)                      │
│                                                                     │
│  /api/auth/{login,logout,me}        /api/search                     │
│  /api/tournaments[/id]              /api/hands                      │
│  /api/players[/id]                  /api/summaries/[id]             │
│  /api/registrations                 /api/analytics                  │
│  /api/admin/{payouts,balance,refund,audit,rbac}                     │
│                                                                     │
│  Every handler wrapped in guard(permission, fn)                     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│  DOMAIN / ACCESS — lib/                                             │
│                                                                     │
│  db.js         pool, query(), withTransaction(fn, {role, playerId}) │
│  auth.js       bcrypt, HMAC sessions, permission matrix, DB_ROLE_FOR│
│  embedding.js  tokenise → concepts → hash → normalise               │
│  api.js        guard(), pagination(), error shaping                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  parameterised SQL only
                               │  SET LOCAL ROLE per transaction
┌──────────────────────────────▼──────────────────────────────────────┐
│  DATA — PostgreSQL 16 + pgvector 0.6                                │
│                                                                     │
│  19 tables        7 views + 1 materialised view                     │
│  7 procedures     14 functions        10 triggers                   │
│  63 indexes       106 constraints                                   │
│  4 roles          row-level security on registration                │
└─────────────────────────────────────────────────────────────────────┘
```

**The load-bearing idea:** business logic lives in the bottom layer. The
API layer is thin — most handlers are a permission check and one call. A
rule enforced in PostgreSQL holds for every client, including `psql`.

---

## 2. Request lifecycle

Tracing `POST /api/admin/payouts` end to end:

```
1. Browser          POST /api/admin/payouts   { tournamentId: 7 }
                    Cookie: pokerlytics_session=<payload>.<hmac>
                              │
2. guard('payout:run', …)     │
     ├─ readSessionToken()    │  verify HMAC with timingSafeEqual
     │                        │  reject expired → 401
     ├─ can(role, perm)       │  PLAYER lacks 'payout:run' → 403
     └─ dbRole = DB_ROLE_FOR[role]   → 'poker_admin'
                              │
3. withTransaction(fn, { role: 'poker_admin' })
     ├─ BEGIN
     ├─ SET LOCAL ROLE poker_admin      ← database-level authorisation
     │                        │
4.   ├─ CALL sp_calculate_payouts($1)
     │     ├─ SELECT … FOR UPDATE        lock the tournament row
     │     ├─ validate ladder ≤ 100 %
     │     ├─ validate exactly one survivor
     │     ├─ fn_prize_pool()            derive the pool
     │     ├─ loop: UPDATE registration  ──┐
     │     │        INSERT transaction     │ triggers fire here:
     │     ├─ UPDATE seat_assignment       │  tr_sync_player_earnings
     │     ├─ UPDATE poker_table           │  tr_audit_registration_upd
     │     └─ REFRESH MATERIALIZED VIEW  ──┘
     │                        │
     └─ COMMIT  (or ROLLBACK on any error)
                              │
5. describeDbError()          │  SQLSTATE → HTTP status
                              │  23514 → 400,  42501 → 403,  23505 → 409
                              ▼
6. Browser          200 { tournamentId: 7, paid: [...] }
```

Steps 2 and 3 are **two independent authorisation layers**. Step 2 protects
the application; step 3 protects the data. If step 2 were removed entirely,
step 3 would still refuse a player's attempt to run a payout.

---

## 3. Where each kind of logic lives

| Concern | Layer | Why there |
|---|---|---|
| Field validation (format, range) | Database `CHECK` | Holds for every client |
| Cross-table rules | Database trigger | Needs to read another table |
| Multi-table operations | Stored procedure | Must be atomic |
| Derived values | Function / generated column | Cannot drift from inputs |
| Access control | Database roles + RLS **and** app guard | Defence in depth |
| Query composition | API layer | Needs request parameters |
| Embedding | `lib/embedding.js` | Single point of change for the model |
| Presentation | React components | — |

---

## 4. Connection and role strategy

One pooled login role, escalated per request:

```js
await withTransaction(async (client) => {
  // ... queries run as poker_director for this transaction only
}, { role: 'poker_director', playerId: 42 });
```

```sql
BEGIN;
SET LOCAL ROLE poker_director;                       -- reverts at COMMIT
SELECT set_config('app.current_player_id','42',true); -- feeds the RLS policy
-- … work …
COMMIT;
```

`SET LOCAL` is the important detail: it is scoped to the transaction, so a
pooled connection returned to the pool carries no residual privilege from
the previous request. The role name is validated against an allow-list
before interpolation, because role names cannot be bound as parameters.

### The four database roles

| Role | Can | Cannot |
|---|---|---|
| `poker_app` | Log in; assume one of the three below | Nothing directly — owns no objects, inherits nothing |
| `poker_admin` | Everything | — |
| `poker_director` | Run events, seat players, record hands, pay out | Read `app_user`; write `player.lifetime_earnings` |
| `poker_player` | Read safe views and own entries | Read credentials, hole cards, transactions, audit log |

---

## 5. Data flow for semantic search

```
  user types "a short stack shoved all in"
            │
            ▼
  GET /api/search?q=…&mode=semantic&minPot=1000&showdownOnly=true
            │
            ▼
  guard('analytics:read')        ← every role has this
            │
            ▼
  embed(q)  → lib/embedding.js   ← the SAME function used at write time
            │                       (critical: a different function would
            ▼                        place queries in a different space)
  '[0.0915,-0.0915,0,…]'  256-d unit vector
            │
            ▼
  SELECT … FROM hand_summary hs
    JOIN hand h ON …
    JOIN tournament t ON …
   WHERE h.pot_size >= 1000         ← B-tree
     AND h.went_to_showdown         ← B-tree
   ORDER BY hs.embedding <=> $1     ← HNSW
   LIMIT 10
            │
            ▼
  rows: hand + tournament + narrative + similarity
            │
            ▼
  JSON → React renders ranked cards with score pills
```

**The write path uses the same `embed()`.** If indexing and querying used
different feature extraction, the vectors would live in different spaces
and similarity would be meaningless. Keeping both in one module is what
guarantees they match.

---

## 6. Deployment topology

### Development (and the demo)

```
┌────────────────────────────────────────────┐
│  localhost                                 │
│                                            │
│   next start  :3000  ──────┐               │
│                            │ pg pool       │
│   postgres    :5432  ◄─────┘ (max 10)      │
│                                            │
│   .env.local  ← credentials, git-ignored   │
└────────────────────────────────────────────┘
```

### A production shape

```
   Browser
      │ HTTPS
┌─────▼─────────┐      ┌──────────────────┐
│  Next.js      │─────▶│  PostgreSQL 16   │
│  (Vercel/     │  TLS │  + pgvector      │
│   container)  │      │  primary         │
└───────────────┘      └────────┬─────────┘
                                │ streaming replication
                       ┌────────▼─────────┐
                       │  read replica    │  ← analytics workload
                       └──────────────────┘
```

Changes required: `secure: true` on the session cookie (already keyed off
`NODE_ENV`), TLS on the database connection, `poker_app`'s password moved
to a secret manager, and the analytical routes pointed at the replica.

---

## 7. Error handling

Database errors are mapped by SQLSTATE rather than by string matching:

| SQLSTATE | Meaning | HTTP |
|---|---|---|
| `23505` | unique violation | 409 Conflict |
| `23503` | foreign key violation | 409 Conflict |
| `23514` | check violation | 400 Bad Request |
| `23502` | not-null violation | 400 Bad Request |
| `42501` | insufficient privilege | 403 Forbidden |
| `P0002` | no data found | 404 Not Found |

A 5xx logs the full error server-side and returns a generic message, so
internal structure is never leaked to the client.

---

## 8. File map

```
poker-tournament-dbms/
├── app/
│   ├── api/                17 route handlers
│   ├── dashboard/          analytics landing page
│   ├── tournaments/        list + [id] detail with operations
│   ├── players/            list + [id] career profile
│   ├── hands/              hand history browser
│   ├── search/             three-mode semantic search
│   ├── admin/              RBAC matrix, RLS policies, audit trail
│   ├── login/
│   ├── layout.js           session-aware shell
│   └── globals.css         design tokens
├── components/Nav.js
├── lib/
│   ├── db.js               pool, transactions, error mapping
│   ├── auth.js             bcrypt, sessions, permissions
│   ├── embedding.js        the vector model
│   └── api.js              guard(), pagination
├── db/
│   ├── 01_schema.sql       … 07_seed_reference.sql
│   └── queries/            10 … 14, the demonstrable query set
├── scripts/
│   ├── setup-db.mjs        run all DDL
│   ├── seed.mjs            simulate tournaments
│   ├── run-tests.mjs       51 database tests
│   ├── smoke-test.mjs      57 API assertions
│   ├── gen-data-dictionary.mjs
│   └── screenshots.mjs
└── docs/
    ├── PROJECT_DOCUMENTATION.md
    ├── RELATIONAL_SCHEMA.md
    ├── DATA_DICTIONARY.md        (generated)
    ├── TECHNOLOGY_JUSTIFICATION.md
    ├── VECTOR_DATA_MODEL.md
    ├── SYSTEM_ARCHITECTURE.md
    ├── TEST_CASES.md
    ├── INDIVIDUAL_CONTRIBUTIONS.md
    ├── GITHUB_SETUP.md
    ├── er-diagram.{drawio,png,pdf}
    └── screenshots/
```
