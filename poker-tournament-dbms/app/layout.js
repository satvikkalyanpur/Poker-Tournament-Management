import './globals.css';
import Nav from '@/components/Nav';
import { currentUser } from '@/lib/api';

export const metadata = {
  title: 'PokerLytics — Tournament Management & Analysis',
  description: 'DBMS Level 3 mini-project: PostgreSQL + pgvector + Next.js',
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }) {
  const user = currentUser();

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
