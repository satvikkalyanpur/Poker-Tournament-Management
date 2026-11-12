/**
 * lib/api.js — shared helpers for the API route handlers.
 *
 * Centralises session reading, permission checks and error shaping so
 * every route handler stays three or four lines long and no route can
 * forget to authorise itself.
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { readSessionToken, sessionCookie, can, DB_ROLE_FOR } from './auth.js';
import { describeDbError } from './db.js';

/** Read and verify the session from the request cookie. */
export function currentUser() {
  const token = cookies().get(sessionCookie.name)?.value;
  return readSessionToken(token);
}

export function json(data, status = 200) {
  return NextResponse.json(data, { status });
}

export function fail(message, status = 400, extra = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/**
 * Guard a route handler.
 *
 *   export const GET = guard('analytics:read', async (req, { user }) => ...)
 *
 * Returns 401 when unauthenticated, 403 when the role lacks the
 * permission, and converts any thrown database error into a clean
 * response instead of leaking a stack trace to the client.
 */
export function guard(permission, handler) {
  return async (req, ctx = {}) => {
    const user = currentUser();

    if (!user) return fail('Not signed in.', 401);
    if (permission && !can(user.role, permission)) {
      return fail(`Role ${user.role} cannot perform "${permission}".`, 403);
    }

    try {
      return await handler(req, { ...ctx, user, dbRole: DB_ROLE_FOR[user.role] });
    } catch (err) {
      const d = describeDbError(err);
      if (d.status >= 500) console.error('[api]', err);
      return fail(d.message, d.status, { code: d.code, constraint: d.constraint });
    }
  };
}

/** Same as guard() but for routes that are open to anyone signed in. */
export const authed = (handler) => guard(null, handler);

/** Parse ?page= and ?pageSize= with sane bounds. */
export function pagination(req, defaultSize = 25) {
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? defaultSize) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Read an integer query parameter, or null. */
export function intParam(req, name) {
  const raw = new URL(req.url).searchParams.get(name);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}
