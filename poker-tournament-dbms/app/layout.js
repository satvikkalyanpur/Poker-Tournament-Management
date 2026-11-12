import './globals.css';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Nav from '@/components/Nav';
import { currentUser } from '@/lib/api';

export const metadata = {
  title: 'PokerLytics — Tournament Management & Analysis',
  description: 'DBMS Level 3 mini-project: PostgreSQL + pgvector + Next.js',
};

export const dynamic = 'force-dynamic';

/** Pages reachable without a session. */
const PUBLIC_PATHS = ['/login'];

export default function RootLayout({ children }) {
  const user = currentUser();
  const pathname = headers().get('x-pathname') ?? '';

  // Send a signed-out visitor to the sign-in page rather than rendering a
  // page whose every panel will report "Not signed in." This also covers an
  // expired or tampered cookie, because currentUser() verifies the HMAC.
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (!user && !isPublic && !pathname.startsWith('/api')) {
    redirect('/login');
  }

  return (
    <html lang="en">
      <body>
        {user ? (
          <div className="shell">
            <Nav user={user} />
            <main className="main">{children}</main>
          </div>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
