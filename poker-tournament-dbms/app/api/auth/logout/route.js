import { NextResponse } from 'next/server';
import { sessionCookie, cookieOptionsFor } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookie.name, '', { ...cookieOptionsFor(req), maxAge: 0 });
  return res;
}
