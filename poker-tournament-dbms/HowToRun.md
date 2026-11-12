# HowToRun

Complete setup instructions for **PokerLytics — Poker Tournament Management
and Analysis System**, from a clean machine to a running application with
data in it.

Total time: about 10 minutes, most of it waiting for `npm install`.

---

## Contents

1. [What you need](#1-what-you-need)
2. [Install PostgreSQL and pgvector](#2-install-postgresql-and-pgvector)
3. [Create the database](#3-create-the-database)
4. [Get the project](#4-get-the-project)
5. [Configure environment variables](#5-configure-environment-variables)
6. [Build the schema](#6-build-the-schema)
7. [Load the data](#7-load-the-data)
8. [Run the application](#8-run-the-application)
9. [Sign in](#9-sign-in)
10. [Verify everything works](#10-verify-everything-works)
11. [Running the query set](#11-running-the-query-set)
12. [Demo script for the evaluation](#12-demo-script-for-the-evaluation)
13. [Troubleshooting](#13-troubleshooting)
14. [Command reference](#14-command-reference)

---

## 1. What you need

| Software | Minimum | Check with |
|---|---|---|
| **Node.js** | 18.18 or newer (20 LTS recommended) | `node --version` |
| **npm** | 9 or newer | `npm --version` |
| **PostgreSQL** | 14 or newer (16+ recommended) | `psql --version` |
| **pgvector** | 0.5 or newer | see section 2 |
| **Git** | any recent | `git --version` |

> **pgvector is mandatory.** It provides the `VECTOR` type and the HNSW
> index that the semantic-search half of the project is built on. Without
> it, `npm run db:setup` stops at the first file with
> `ERROR: type "vector" does not exist`.
>
> **The quickest way to get it is not to install anything** — see section
> 2.0 for a free hosted PostgreSQL that already has pgvector built in.

---

## 2. Install PostgreSQL and pgvector

### 2.0 The fast route — a free cloud database (no install at all)

**If you want to be running in five minutes, use this.** pgvector is
already installed on every major hosted PostgreSQL service, so there is
nothing to compile.

1. Sign up at <https://neon.com> (free tier, no card). Supabase, Render and
   Aiven all work the same way.
2. Create a project. You get a connection string that looks like
   `postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require`
3. In their SQL editor, run:

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   ```

4. Put the connection string in `.env.local` as a single line — it
   replaces all the `PG*` variables:

   ```ini
   DATABASE_URL=postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require
   SESSION_SECRET=paste_a_long_random_string_here
   ```

5. Skip to [section 6](#6-build-the-schema).

**This is fully supported.** The whole project has been verified against a
non-superuser account of the kind a managed service gives you: all 19
tables, the roles, the row-level security policies and all 51 database
tests pass unchanged.

> **One caveat for your demo.** A cloud database needs working internet in
> the exam room. If that is a risk, use the cloud now to make progress and
> install locally later — the project runs identically against both, and
> switching is a one-line change in `.env.local`.

---

### 2.1 Windows (local install)

**There are no official prebuilt Windows binaries for pgvector.** The
project ships source only, so on Windows it has to be compiled. It takes
about ten minutes and is mechanical, but the exact prompt you use matters —
see the warnings below.

#### Step 1 — Install PostgreSQL

Download the installer from <https://www.postgresql.org/download/windows/>
and run it. Keep the default port **5432** and remember the password you
set for the `postgres` user. Any version from 14 onwards works; these
instructions assume **18** — change the path if yours differs.

#### Step 2 — Install the C++ compiler

pgvector needs a C compiler. Download **Build Tools for Visual Studio 2022**
from <https://visualstudio.microsoft.com/downloads/> (scroll to *Tools for
Visual Studio* → *Build Tools for Visual Studio*). This is the free,
compiler-only package — you do not need the full Visual Studio IDE.

In the installer, tick the **"Desktop development with C++"** workload and
install. It is roughly 2–3 GB.

#### Step 3 — Build and install pgvector

> **Three things go wrong here, so read before typing.**
>
> 1. **Use the right prompt.** Open **"x64 Native Tools Command Prompt for
>    VS 2022"** from the Start menu — *not* PowerShell and *not* plain
>    `cmd`. Only this prompt has `nmake` on its PATH. Use the **x64**
>    version; the x86 one produces a 32-bit DLL that 64-bit PostgreSQL
>    cannot load.
> 2. **Run it as Administrator.** Right-click → *Run as administrator*. The
>    install step writes into `C:\Program Files\`, which fails otherwise.
> 3. **Mind the quote placement.** It is `set "PGROOT=C:\...\18"`, with the
>    quotes around the *whole assignment*. Writing
>    `set PGROOT="C:\...\18"` puts literal quote characters *inside* the
>    value and causes a "cannot find file" error during the build.

In that Administrator x64 Native Tools prompt:

```bat
set "PGROOT=C:\Program Files\PostgreSQL\18"
cd %TEMP%
git clone --branch v0.8.7 https://github.com/pgvector/pgvector.git
cd pgvector
nmake /F Makefile.win
nmake /F Makefile.win install
```

Both `nmake` commands should end with no errors. The second copies
`vector.dll` into your PostgreSQL `lib\` folder and the extension's SQL
files into `share\extension\`.

> **Do not** add `shared_preload_libraries = 'vector'` to
> `postgresql.conf`. Some blog posts suggest it; pgvector does not need it,
> and a typo there stops PostgreSQL from starting at all.

#### Step 4 — Confirm it worked

```bat
psql -U postgres -c "SELECT * FROM pg_available_extensions WHERE name='vector';"
```

One row naming `vector` means success. An empty result means the build
output did not land in the right PostgreSQL installation — check that
`PGROOT` pointed at the same version you are connecting to.

#### If you cannot install Visual Studio

Use Docker instead and skip the compiler entirely. Install Docker Desktop,
then:

```bat
docker run --name pokerdb -e POSTGRES_PASSWORD=postgres -p 5433:5432 -d pgvector/pgvector:pg17
```

This gives you PostgreSQL with pgvector already inside it, on port **5433**
so it does not clash with any local install. Set `PGPORT=5433` and
`PGPASSWORD=postgres` in `.env.local`, then create the database with:

```bat
docker exec -it pokerdb psql -U postgres -c "CREATE DATABASE pokerdb;"
```

### 2.2 macOS

The easiest route installs both at once:

```bash
brew install postgresql@16 pgvector
brew services start postgresql@16

# add psql to PATH if the installer did not
echo 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Alternatively, [Postgres.app](https://postgresapp.com/) ships pgvector
built in and needs no compilation.

### 2.3 Linux (Ubuntu / Debian)

```bash
sudo apt update
sudo apt install -y postgresql-16 postgresql-contrib-16 postgresql-16-pgvector
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

If your distribution has no `postgresql-16-pgvector` package, build it:

```bash
sudo apt install -y build-essential postgresql-server-dev-all git
git clone --branch v0.8.7 https://github.com/pgvector/pgvector.git
cd pgvector && make && sudo make install
```

### 2.4 Confirm pgvector is available

```bash
psql -U postgres -c "SELECT * FROM pg_available_extensions WHERE name='vector';"
```

You should see a row naming `vector` and a version. If the result is empty,
pgvector is not installed where this PostgreSQL instance can find it — go
back to the step for your platform.

---

## 3. Create the database

```bash
psql -U postgres
```

Then, at the `postgres=#` prompt:

```sql
CREATE DATABASE pokerdb;
\c pokerdb
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SELECT extname, extversion FROM pg_extension;
\q
```

The last statement should list `plpgsql`, `vector` and `pgcrypto`.

> On Linux you may need `sudo -u postgres psql` instead of `psql -U postgres`.

---

## 4. Get the project

```bash
git clone https://github.com/<your-username>/poker-tournament-dbms.git
cd poker-tournament-dbms
npm install
```

`npm install` fetches about 75 packages and takes 20–60 seconds.

---

## 5. Configure environment variables

Credentials are never hard-coded. Copy the template and fill it in:

```bash
# macOS / Linux
cp .env.example .env.local

# Windows (PowerShell)
Copy-Item .env.example .env.local
```

Open `.env.local` and set at least `PGPASSWORD` and `SESSION_SECRET`:

```ini
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=your_postgres_password_here
PGDATABASE=pokerdb

# any random string of 32+ characters
SESSION_SECRET=paste_a_long_random_string_here

SEED_PASSWORD=Passw0rd!
SEED_SIZE=medium
EMBEDDING_PROVIDER=local
LOG_SQL=false
```

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> `.env.local` is listed in `.gitignore` and must never be committed.

---

## 6. Build the schema

```bash
npm run db:setup
```

Expected output:

```
Connected to "pokerdb"
PostgreSQL 16.x …

  ok     01_schema.sql                  109 ms
  ok     02_indexes.sql                  78 ms
  ok     03_functions_triggers.sql        4 ms
  ok     04_views.sql                    13 ms
  ok     05_procedures.sql                3 ms
  ok     06_roles_rbac.sql               11 ms
  ok     07_seed_reference.sql            2 ms

  Schema objects created
  ----------------------------------------
    tables ................ 19
    views ................. 7
    materialized views .... 1
    indexes ............... 63
    triggers .............. 10
    functions ............. 14
    procedures ............ 7
    check constraints ..... 47
    foreign keys .......... 25
```

This command is **idempotent** — run it again any time to rebuild the
schema from scratch.

---

## 7. Load the data

```bash
npm run db:seed
```

This is a simulation, not random filler: tournaments are played out hand by
hand, chips move between players, stacks reach zero, players bust in order,
and the payout procedure pays the survivors.

```
Seeding "medium" dataset

  players       [########################] 70/70
  tournaments   [########################] 9/9
  embeddings    [########################] 770/770

  Row counts
  ----------------------------------------
    app_user                      73
    hand                         770
    hand_action                 4152
    hand_summary                 770
    registration                 261
    …
    TOTAL                      12388

  Done in 6.0s

  Demo logins (password from SEED_PASSWORD):
    admin@pokerlytics.dev      ADMIN
    director@pokerlytics.dev   DIRECTOR
    flopraider@players.dev     PLAYER
```

Dataset size is controlled by `SEED_SIZE` in `.env.local`:

| Value | Players | Tournaments | Approx. rows | Time |
|---|---|---|---|---|
| `small` | 30 | 4 | ~4,300 | ~2 s |
| `medium` *(default)* | 70 | 9 | ~12,400 | ~6 s |
| `large` | 160 | 18 | ~40,000 | ~25 s |

To rebuild schema and data in one step: `npm run db:reset`.

---

## 8. Run the application

### Production mode (what to use for the demo)

```bash
npm run build
npm start
```

### Development mode (hot reload while editing)

```bash
npm run dev
```

Either way, open <http://localhost:3000>.

---

## 9. Sign in

| E-mail | Role | What they can do |
|---|---|---|
| `admin@pokerlytics.dev` | ADMIN | Everything: payouts, refunds, audit log, RBAC matrix |
| `director@pokerlytics.dev` | DIRECTOR | Run events, seat players, pay out. **Cannot** delete tournaments, issue refunds, or read the credentials table |
| `flopraider@players.dev` | PLAYER | Read-only. Restricted by row-level security |

The password for all three is whatever `SEED_PASSWORD` was set to —
`Passw0rd!` by default.

The exact player e-mail is printed at the end of `npm run db:seed`. To list
a few:

```bash
psql -U postgres -d pokerdb -c "SELECT email FROM app_user WHERE role='PLAYER' LIMIT 5;"
```

---

## 10. Verify everything works

### Database integrity suite — 51 cases

```bash
npm run db:test
```

```
============================================================
  51 passed, 0 failed, 51 total
============================================================
```

Every case runs inside a savepoint that is rolled back, so running it does
not change your data.

### Application integration suite — 57 assertions

With the server running in another terminal:

```bash
node scripts/smoke-test.mjs
```

```
====================================================
  57 passed, 0 failed
====================================================
```

### Regenerate the documentation artefacts (optional)

```bash
node scripts/gen-data-dictionary.mjs   # rebuild docs/DATA_DICTIONARY.md
node scripts/screenshots.mjs           # rebuild docs/screenshots/ (needs playwright)
```

---

## 11. Running the query set

The query files are the evidence for rubric items 6, 7 and 8. Each is
runnable and self-documenting.

```bash
psql -U postgres -d pokerdb -f db/queries/10_dml_operations.sql
psql -U postgres -d pokerdb -f db/queries/11_joins_aggregates.sql
psql -U postgres -d pokerdb -f db/queries/12_nested_correlated_recursive.sql
psql -U postgres -d pokerdb -f db/queries/13_advanced_cte_window.sql
psql -U postgres -d pokerdb -f db/queries/14_vector_search.sql
```

| File | Demonstrates |
|---|---|
| `10_dml_operations.sql` | INSERT / UPDATE / DELETE / SELECT, upsert, `INSERT…SELECT` |
| `11_joins_aggregates.sql` | All join types, GROUP BY, HAVING, aggregates, set operations |
| `12_nested_correlated_recursive.sql` | Nested, correlated and **recursive** queries |
| `13_advanced_cte_window.sql` | CTEs, window functions, EXPLAIN |
| `14_vector_search.sql` | Similarity search and full vector CRUD |

`10` and `14` wrap their changes in a transaction that is rolled back, so
they are safe to run repeatedly.

---

## 12. Demo script for the evaluation

A 10-minute run-through that touches every rubric item, in order.

**1. Problem and design (1 min)**
Open `docs/er-diagram.png`. Point out the four weak entities, the
multivalued attribute `board_cards`, the derived `prize_pool`, and the
recursive `knocks_out` relationship.

**2. Schema creation (1 min)**

```bash
npm run db:setup
```

Let the object summary print — 19 tables, 63 indexes, 106 constraints.

**3. The data is real (1 min)**
Dashboard → point at the counters. Explain that tournaments were simulated
hand by hand, and that chip conservation is verified.

**4. DML and queries (2 min)**

```bash
psql -U postgres -d pokerdb -f db/queries/12_nested_correlated_recursive.sql
```

Stop on Q10, the elimination tree, and explain why a fixed number of joins
cannot walk it.

**5. Advanced features (2 min)**
Tournament detail page → press **sp_balance_tables**, then
**sp_calculate_payouts** on the live event. Explain that each button is one
`CALL`, and that everything inside it is one transaction.

**6. The vector layer (2 min)**
Semantic search → query *"a short stack shoved all in and got called"*.
Switch to **Lexical** and show that hands saying "jammed" disappear.
Switch to **Hybrid**. This is the clearest demonstration of why the second
paradigm earns its place.

**7. Security, in the database (1 min)**
Admin console → RBAC matrix and row-level security policies. Then, in
`psql`, the clinching demonstration:

```sql
SET ROLE poker_player;
SELECT email, password_hash FROM app_user LIMIT 1;
-- ERROR:  permission denied for table app_user
RESET ROLE;
```

**8. Testing (1 min)**

```bash
npm run db:test
```

51 passing, most of them negative tests.

---

## 13. Troubleshooting

### `type "vector" does not exist`

pgvector is not installed in **this database**. Run:

```sql
\c pokerdb
CREATE EXTENSION vector;
```

If that errors with *could not open extension control file*, pgvector is
not installed in the PostgreSQL instance at all — revisit step 2.

### `password authentication failed for user "postgres"`

`PGPASSWORD` in `.env.local` does not match. Test it directly:

```bash
psql -U postgres -h localhost -d pokerdb -c "SELECT 1;"
```

On Linux, the default `postgres` role may have no password. Either set one:

```bash
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'yourpassword';"
```

or create a role for yourself:

```bash
sudo -u postgres createuser --superuser $USER
sudo -u postgres createdb -O $USER pokerdb
```

then set `PGUSER` to your own username and leave `PGPASSWORD` empty.

### `ECONNREFUSED 127.0.0.1:5432`

PostgreSQL is not running.

```bash
# macOS
brew services start postgresql@16
# Linux
sudo systemctl start postgresql
# Windows
# Services → postgresql-x64-<your version> → Start
```

### `SESSION_SECRET must be set to a random string of at least 16 characters`

You skipped step 5, or `.env.local` is in the wrong directory. It belongs
in the project root, beside `package.json`.

### `relation "tournament" does not exist`

The schema was not built. Run `npm run db:setup`.

### Pages load but every panel is empty

The schema exists but there is no data. Run `npm run db:seed`.

### `EADDRINUSE: address already in use :::3000`

Something else holds port 3000.

```bash
# macOS / Linux
lsof -ti:3000 | xargs kill -9
# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 3000 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }
```

Or use another port: `npx next start -p 3001`.

### Styling looks broken after editing CSS

A stale build directory. Rebuild cleanly:

```bash
rm -rf .next && npm run build && npm start
```

### Seeding fails part way through

Reset and retry; the seeder is not resumable:

```bash
npm run db:reset
```

### `npm run db:test` reports failures

First confirm the data is present (`npm run db:seed`). The suite assumes a
seeded database — several cases need a live tournament with active
entries, which only exists after seeding.

---

## 14. Command reference

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run db:setup` | Create every schema object (idempotent) |
| `npm run db:seed` | Generate the simulated dataset |
| `npm run db:reset` | `db:setup` followed by `db:seed` |
| `npm run db:test` | 51-case database integrity suite |
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build |
| `npm start` | Production server on port 3000 |
| `node scripts/smoke-test.mjs` | 57-assertion API suite (server must be running) |
| `node scripts/gen-data-dictionary.mjs` | Regenerate `docs/DATA_DICTIONARY.md` |
| `node scripts/screenshots.mjs` | Regenerate `docs/screenshots/` |

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PGHOST` | `localhost` | Database host |
| `PGPORT` | `5432` | Database port |
| `PGUSER` | `postgres` | Database user |
| `PGPASSWORD` | *(empty)* | Database password |
| `PGDATABASE` | `pokerdb` | Database name |
| `DATABASE_URL` | — | Full connection string; overrides the `PG*` variables |
| `SESSION_SECRET` | **required** | HMAC key for session cookies, 32+ chars |
| `SEED_PASSWORD` | `Passw0rd!` | Password given to every seeded account |
| `SEED_SIZE` | `medium` | `small` \| `medium` \| `large` |
| `EMBEDDING_PROVIDER` | `local` | `local` \| `openai` |
| `OPENAI_API_KEY` | — | Only needed when `EMBEDDING_PROVIDER=openai` |
| `LOG_SQL` | `false` | Print every SQL statement with timing |

---

## Quick start, all together

```bash
# once
psql -U postgres -c "CREATE DATABASE pokerdb;"
psql -U postgres -d pokerdb -c "CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;"

git clone https://github.com/<your-username>/poker-tournament-dbms.git
cd poker-tournament-dbms
npm install
cp .env.example .env.local        # then edit PGPASSWORD and SESSION_SECRET

npm run db:setup
npm run db:seed
npm run build
npm start
```

Open <http://localhost:3000> and sign in as `admin@pokerlytics.dev` /
`Passw0rd!`.
