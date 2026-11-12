/**
 * lib/auth.js — authentication and authorisation.
 *
 * Requirement 11: at least two roles with role-based access control.
 * Requirement 13: passwords and credentials never stored in plain text.
 *
 * Passwords are hashed with bcrypt (cost 10). The plaintext never
 * leaves the request handler and is never logged.
 *
 * Sessions are signed, HttpOnly cookies. The signature is an HMAC over
 * the payload using SESSION_SECRET from the environment, so a client
 * cannot edit their own cookie to become an admin.
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { queryOne, query } from './db.js';

const COOKIE_NAME = 'pokerlytics_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours
const BCRYPT_COST = 10;

/** Application role -> database role. */
export const DB_ROLE_FOR = {
  ADMIN: 'poker_admin',
  DIRECTOR: 'poker_director',
  PLAYER: 'poker_player',
};

/** Route permission matrix, enforced in the API layer. */
export const PERMISSIONS = {
  ADMIN: [
    'tournament:create', 'tournament:update', 'tournament:delete',
    'registration:create', 'registration:update', 'registration:refund',
    'payout:run', 'table:balance', 'hand:create', 'summary:write',
    'summary:delete', 'user:manage', 'audit:read', 'analytics:read',
  ],
  DIRECTOR: [
    'tournament:create', 'tournament:update',
    'registration:create', 'registration:update',
    'payout:run', 'table:balance', 'hand:create', 'summary:write',
    'audit:read', 'analytics:read',
  ],
  PLAYER: ['analytics:read'],
};

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_COST);
}

export function verifyPassword(plain, hash) {
  try {
    return bcrypt.compareSync(plain, hash);
  } catch {
    return false;
  }
}

export function can(role, permission) {
  return (PERMISSIONS[role] ?? []).includes(permission);
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      'SESSION_SECRET must be set to a random string of at least 16 characters. ' +
        'Copy .env.example to .env.local and fill it in.',
    );
  }
  return s;
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

export function createSessionToken(user) {
  const payload = {
    userId: user.user_id,
    email: user.email,
    role: user.role,
    playerId: user.player_id ?? null,
    staffId: user.staff_id ?? null,
    screenName: user.screen_name ?? null,
    exp: Date.now() + SESSION_TTL_MS,
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${sign(b64)}`;
}

export function readSessionToken(token) {
  if (!token || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');

  // timing-safe comparison so the signature cannot be brute-forced
  const expected = sign(b64);
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export const sessionCookie = {
  name: COOKIE_NAME,
  options: {
    httpOnly: true,                                   // not readable from JS
    sameSite: 'lax',                                  // basic CSRF defence
    secure: false,                                    // overridden per request
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  },
};

/**
 * Cookie options for a specific request.
 *
 * The `Secure` flag must track the actual protocol, not NODE_ENV. A
 * production build served over plain http://localhost — which is exactly
 * what `npm run build && npm start` gives you — would otherwise emit a
 * Secure cookie that the browser may refuse to store, leaving the user
 * stuck on "Not signed in." with no visible cause.
 */
export function cookieOptionsFor(request) {
  const forwarded = request?.headers?.get?.('x-forwarded-proto');
  const isHttps =
    forwarded === 'https' || request?.nextUrl?.protocol === 'https:';
  return { ...sessionCookie.options, secure: Boolean(isHttps) };
}

/**
 * Look a user up by e-mail and verify their password.
 * Returns the session payload, or null if the credentials are wrong.
 * The same null is returned for "no such user" and "bad password" so an
 * attacker cannot enumerate valid e-mail addresses.
 */
export async function authenticate(email, password) {
  const user = await queryOne(
    `SELECT u.user_id, u.email, u.password_hash, u.role, u.is_active,
            p.player_id, p.screen_name,
            s.staff_id
       FROM app_user u
       LEFT JOIN player p ON p.user_id = u.user_id
       LEFT JOIN staff  s ON s.user_id = u.user_id
      WHERE u.email = lower($1)`,
    [String(email ?? '').trim()],
  );

  if (!user || !user.is_active) return null;
  if (!verifyPassword(String(password ?? ''), user.password_hash)) return null;

  await query('UPDATE app_user SET last_login_at = NOW() WHERE user_id = $1', [
    user.user_id,
  ]);

  delete user.password_hash; // never travels any further
  return user;
}
