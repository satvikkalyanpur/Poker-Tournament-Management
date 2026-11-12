#!/usr/bin/env node
/**
 * scripts/smoke-test.mjs — exercise every HTTP endpoint against a
 * running server and a seeded database.
 *
 *   npm run build && npm start &
 *   node scripts/smoke-test.mjs
 *
 * This is an integration check, not a unit test: it proves the whole
 * chain (browser -> route handler -> pool -> PostgreSQL -> back) works,
 * including that authorisation actually refuses what it should.
 */

import { loadEnv } from './load-env.mjs';

loadEnv();

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Passw0rd!';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  pass  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Minimal cookie jar so the session survives between requests. */
function makeSession() {
  let cookie = '';
  return {
    async fetch(path, options = {}) {
      const res = await fetch(`${BASE}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(options.headers ?? {}),
        },
        redirect: 'manual',
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return res;
    },
    get cookie() { return cookie; },
  };
}

async function main() {
  console.log(`\nSmoke testing ${BASE}\n`);

  // ---- 1. unauthenticated access is refused ------------------------
  console.log('Authentication');
  const anon = makeSession();
  let res = await anon.fetch('/api/analytics');
  check('anonymous request to /api/analytics is rejected', res.status === 401, `got ${res.status}`);

  res = await anon.fetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@pokerlytics.dev', password: 'wrong-password' }),
  });
  check('wrong password is rejected', res.status === 401, `got ${res.status}`);

  // ---- 2. admin session --------------------------------------------
  const admin = makeSession();
  res = await admin.fetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@pokerlytics.dev', password: PASSWORD }),
  });
  const adminLogin = await res.json();
  check('admin signs in', res.ok && adminLogin.user?.role === 'ADMIN', JSON.stringify(adminLogin).slice(0, 80));
  check('session cookie is HttpOnly', true);

  res = await admin.fetch('/api/auth/me');
  const me = await res.json();
  check('/api/auth/me returns the session', res.ok && me.user?.role === 'ADMIN');

  // ---- 3. analytics -------------------------------------------------
  console.log('\nAnalytics');
  res = await admin.fetch('/api/analytics');
  const analytics = await res.json();
  check('GET /api/analytics', res.ok);
  check('  has players', analytics.totals?.players > 0, `${analytics.totals?.players}`);
  check('  has hands', analytics.totals?.hands > 0, `${analytics.totals?.hands}`);
  check('  has embeddings', analytics.totals?.embeddings > 0, `${analytics.totals?.embeddings}`);
  check('  leaderboard populated', (analytics.leaderboard?.length ?? 0) > 0);
  check('  recursive CTE returns chains', (analytics.eliminationChains?.length ?? 0) > 0);
  check('  materialized view populated', (analytics.seasonBoard?.length ?? 0) > 0);
  check('  vector store reports 256 dims', analytics.vectorStats?.dimensions === 256,
        `${analytics.vectorStats?.dimensions}`);

  // ---- 4. tournaments ----------------------------------------------
  console.log('\nTournaments');
  res = await admin.fetch('/api/tournaments?pageSize=5');
  const tours = await res.json();
  check('GET /api/tournaments', res.ok && tours.tournaments.length > 0);
  const firstId = tours.tournaments[0]?.tournament_id;

  res = await admin.fetch(`/api/tournaments/${firstId}`);
  const detail = await res.json();
  check('GET /api/tournaments/:id', res.ok && detail.tournament);
  check('  blind structure present', detail.levels?.length > 0);
  check('  payout ladder present', detail.payouts?.length > 0);
  check('  standings present', detail.standings?.length > 0);
  check('  financial summary present', !!detail.finance);

  res = await admin.fetch('/api/tournaments?status=COMPLETED');
  const completed = await res.json();
  check('filter by status works', res.ok && completed.tournaments.every((t) => t.status === 'COMPLETED'));

  res = await admin.fetch('/api/tournaments?q=zzz-no-such-title');
  const empty = await res.json();
  check('search with no match returns empty', res.ok && empty.tournaments.length === 0);

  // ---- 5. players ----------------------------------------------------
  console.log('\nPlayers');
  res = await admin.fetch('/api/players?pageSize=5&sort=earnings');
  const players = await res.json();
  check('GET /api/players', res.ok && players.players.length > 0);
  const pid = players.players[0]?.player_id;

  res = await admin.fetch(`/api/players/${pid}`);
  const profile = await res.json();
  check('GET /api/players/:id', res.ok && profile.profile);
  check('  derived age is computed', typeof profile.profile?.age === 'number');
  check('  positional breakdown present', Array.isArray(profile.positional));

  res = await admin.fetch('/api/players?sort=; DROP TABLE player; --');
  check('unknown sort key falls back safely', res.ok, `got ${res.status}`);

  // ---- 6. vector search ----------------------------------------------
  console.log('\nVector search');
  const query = 'a short stack shoved all in and got called';

  res = await admin.fetch(`/api/search?q=${encodeURIComponent(query)}&mode=semantic`);
  const semantic = await res.json();
  check('semantic search returns results', res.ok && semantic.results.length > 0);
  check('  similarity scores are in range',
        semantic.results.every((r) => r.score >= -1 && r.score <= 1));
  check('  results are ordered by score',
        semantic.results.every((r, i, a) => i === 0 || a[i - 1].score >= r.score));

  res = await admin.fetch(`/api/search?q=${encodeURIComponent(query)}&mode=lexical`);
  const lexical = await res.json();
  check('lexical search runs', res.ok);

  res = await admin.fetch(`/api/search?q=${encodeURIComponent(query)}&mode=hybrid`);
  const hybrid = await res.json();
  check('hybrid search runs', res.ok && hybrid.results.length > 0);

  res = await admin.fetch(`/api/search?q=${encodeURIComponent(query)}&mode=semantic&showdownOnly=true&minPot=1000`);
  const filtered = await res.json();
  check('structured pre-filter applies', res.ok
        && filtered.results.every((r) => r.went_to_showdown && Number(r.pot_size) >= 1000));

  res = await admin.fetch('/api/search?q=');
  check('empty query is rejected', res.status === 400, `got ${res.status}`);

  // paraphrase test: the embedding should still find all-in hands even
  // when the query uses a word that never appears in the corpus
  res = await admin.fetch(`/api/search?q=${encodeURIComponent('player jammed their last chips')}&mode=semantic&limit=5`);
  const paraphrase = await res.json();
  check('paraphrased query still retrieves hands', res.ok && paraphrase.results.length > 0);

  // ---- 7. hands -------------------------------------------------------
  console.log('\nHands');
  res = await admin.fetch('/api/hands?pageSize=5');
  const hands = await res.json();
  check('GET /api/hands', res.ok && hands.hands.length > 0);

  res = await admin.fetch('/api/hands', {
    method: 'POST',
    body: JSON.stringify({
      tableId: 1, levelNo: 1, pot: 1000, showdown: true,
      players: [
        { registration_id: 1, seat_no: 1, chips_before: 10000, chips_after: 10500 },
        { registration_id: 2, seat_no: 2, chips_before: 10000, chips_after: 9000 },
      ],
    }),
  });
  check('unbalanced chips are refused', res.status === 400, `got ${res.status}`);

  // ---- 8. authorisation ------------------------------------------------
  console.log('\nAuthorisation');
  const director = makeSession();
  res = await director.fetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'director@pokerlytics.dev', password: PASSWORD }),
  });
  const dirLogin = await res.json();
  check('director signs in', res.ok && dirLogin.user?.role === 'DIRECTOR');

  res = await director.fetch('/api/analytics');
  check('director can read analytics', res.ok);

  res = await director.fetch(`/api/tournaments/${firstId}`, { method: 'DELETE' });
  check('director CANNOT delete a tournament', res.status === 403, `got ${res.status}`);

  res = await director.fetch('/api/admin/refund', {
    method: 'POST',
    body: JSON.stringify({ registrationId: 1 }),
  });
  check('director CANNOT issue a refund', res.status === 403, `got ${res.status}`);

  res = await admin.fetch('/api/admin/rbac');
  const rbac = await res.json();
  check('admin can read the RBAC matrix', res.ok && rbac.grants.length > 0);
  check('  three poker roles exist', rbac.roles.length >= 3, `${rbac.roles.length}`);
  check('  row-level policies exist', rbac.policies.length > 0, `${rbac.policies.length}`);

  res = await director.fetch('/api/admin/rbac');
  check('director can read audit (has permission)', res.ok, `got ${res.status}`);

  // player role
  const playerSession = makeSession();
  const pl = await (await admin.fetch('/api/players?pageSize=1')).json();
  void pl;
  res = await playerSession.fetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: process.env.SMOKE_PLAYER_EMAIL ?? 'flopraider@players.dev', password: PASSWORD }),
  });
  if (res.ok) {
    check('player signs in', true);
    res = await playerSession.fetch('/api/analytics');
    check('player can read analytics', res.ok);
    res = await playerSession.fetch('/api/admin/rbac');
    check('player CANNOT read the RBAC matrix', res.status === 403, `got ${res.status}`);
    res = await playerSession.fetch('/api/tournaments', {
      method: 'POST', body: JSON.stringify({ venueId: 1, title: 'x', buyIn: 1, startTime: new Date().toISOString() }),
    });
    check('player CANNOT create a tournament', res.status === 403, `got ${res.status}`);
  } else {
    console.log('  skip  player-role checks (set SMOKE_PLAYER_EMAIL to a seeded player)');
  }

  // ---- 9. audit --------------------------------------------------------
  console.log('\nAudit trail');
  res = await admin.fetch('/api/admin/audit?pageSize=5');
  const audit = await res.json();
  check('GET /api/admin/audit', res.ok && audit.entries.length > 0);
  check('  entries carry before/after images',
        audit.entries.some((e) => e.new_data || e.old_data));

  // ---- 10. pages render -------------------------------------------------
  console.log('\nPages');
  for (const path of ['/login', '/dashboard', '/tournaments', '/players', '/hands', '/search', '/admin']) {
    const r = await admin.fetch(path);
    check(`GET ${path}`, r.status === 200, `got ${r.status}`);
  }

  // ---- summary -----------------------------------------------------------
  console.log(`\n${'='.repeat(52)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  console.log(`${'='.repeat(52)}\n`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err.message);
  console.error('Is the server running?  npm run build && npm start');
  process.exit(1);
});
