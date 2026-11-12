#!/usr/bin/env node
/**
 * scripts/screenshots.mjs — capture application screenshots for the report.
 *
 *   npm start &            # server must be running
 *   node scripts/screenshots.mjs
 *
 * Writes PNGs into docs/screenshots/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from './load-env.mjs';

loadEnv();

/**
 * Playwright is an optional dev dependency — it is only needed to
 * regenerate the screenshots in the report, never to run the app. Resolve
 * it from the project first, then from a global install, and explain the
 * fix rather than crashing with a module-not-found stack trace.
 */
async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch { /* fall through to the global lookup */ }

  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const entry = path.join(globalRoot, 'playwright', 'index.js');
    if (fs.existsSync(entry)) {
      // Playwright ships CommonJS: importing it from ESM puts the exports
      // on `default`, not as named exports, so check both shapes.
      const mod = await import(pathToFileURL(entry).href);
      return mod.chromium ?? mod.default?.chromium;
    }
  } catch { /* ignore */ }

  console.error('\n  Playwright is not installed, so screenshots cannot be captured.');
  console.error('  This does not affect the application itself. To install it:\n');
  console.error('      npm install -D playwright && npx playwright install chromium\n');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Passw0rd!';

const SHOTS = [
  { name: '01-login',           path: '/login',        full: false, auth: false },
  { name: '02-dashboard',       path: '/dashboard',    full: true },
  { name: '03-tournaments',     path: '/tournaments',  full: false },
  { name: '04-tournament-detail', path: null,          full: true, dynamic: 'tournament' },
  { name: '05-players',         path: '/players',      full: false },
  { name: '06-player-profile',  path: null,            full: true, dynamic: 'player' },
  { name: '07-semantic-search', path: '/search',       full: false, action: 'search' },
  { name: '08-hand-history',    path: '/hands',        full: false },
  { name: '09-admin-rbac',      path: '/admin',        full: true },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const chromium = await loadChromium();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // sign in once; the session cookie persists in this context
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(OUT, '01-login.png') });
  console.log('  saved 01-login.png');

  await page.fill('#email', 'admin@pokerlytics.dev');
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard', { timeout: 15000 });
  await page.waitForTimeout(2500); // let the charts settle

  // discover one real tournament and player id
  const tournamentId = await page.evaluate(async () => {
    const r = await fetch('/api/tournaments?pageSize=1');
    const d = await r.json();
    return d.tournaments?.[0]?.tournament_id ?? 1;
  });
  const playerId = await page.evaluate(async () => {
    const r = await fetch('/api/players?pageSize=1&sort=earnings');
    const d = await r.json();
    return d.players?.[0]?.player_id ?? 1;
  });

  for (const shot of SHOTS.slice(1)) {
    let target = shot.path;
    if (shot.dynamic === 'tournament') target = `/tournaments/${tournamentId}`;
    if (shot.dynamic === 'player') target = `/players/${playerId}`;

    await page.goto(`${BASE}${target}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);

    if (shot.action === 'search') {
      await page.click('button[type=submit]');
      await page.waitForTimeout(1800);
    }

    await page.screenshot({
      path: path.join(OUT, `${shot.name}.png`),
      fullPage: !!shot.full,
    });
    console.log(`  saved ${shot.name}.png`);
  }

  await browser.close();
  console.log(`\nScreenshots written to ${OUT}\n`);
}

main().catch((err) => {
  console.error('Screenshot run failed:', err.message);
  console.error('Make sure the server is running: npm run build && npm start');
  process.exit(1);
});
