/**
 * POST /api/auth/login — authenticate and issue a session cookie.
 */
import { NextResponse } from 'next/server';
import { authenticate, createSessionToken, sessionCookie } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const { email, password } = body ?? {};
  if (!email || !password) {
    return NextResponse.json({ error: 'E-mail and password are required.' }, { status: 400 });
  }

  const user = await authenticate(email, password);
  if (!user) {
    // identical response for unknown e-mail and wrong password
    return NextResponse.json({ error: 'Invalid e-mail or password.' }, { status: 401 });
  }

  const res = NextResponse.json({
    user: {
      userId: user.user_id,
      email: user.email,
      role: user.role,
      playerId: user.player_id,
      screenName: user.screen_name,
    },
  });
  res.cookies.set(sessionCookie.name, createSessionToken(user), sessionCookie.options);
  return res;
}
