import { NextResponse } from 'next/server';

/**
 * Middleware — makes the current path visible to the root layout.
 *
 * The layout needs to know which page is being rendered so it can send an
 * unauthenticated visitor to /login instead of rendering a page that will
 * only be able to say "Not signed in." A server component cannot read the
 * pathname on its own, so it is forwarded here as a request header.
 *
 * The session itself is NOT validated here. Middleware runs on the Edge
 * runtime, which has no Node crypto, and the HMAC check therefore belongs
 * in the layout and in the API guard — both of which run on Node.
 */
export function middleware(request) {
  const headers = new Headers(request.headers);
  headers.set('x-pathname', request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // every page, but not static assets
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
