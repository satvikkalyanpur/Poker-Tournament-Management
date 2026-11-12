'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const LINKS = [
  { group: 'Analysis', items: [
    { href: '/dashboard',   label: 'Dashboard' },
    { href: '/tournaments', label: 'Tournaments' },
    { href: '/players',     label: 'Players' },
    { href: '/hands',       label: 'Hand history' },
    { href: '/search',      label: 'Semantic search' },
  ]},
  { group: 'Operations', items: [
    { href: '/admin', label: 'Admin console', perm: 'audit:read' },
  ]},
];

export default function Nav({ user }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  const isPrivileged = user.role === 'ADMIN' || user.role === 'DIRECTOR';

  return (
    <aside className="sidebar">
      <div className="brand"><span className="chip" /> PokerLytics</div>

      {LINKS.map((g) => {
        const items = g.items.filter((i) => !i.perm || isPrivileged);
        if (!items.length) return null;
        return (
          <div className="nav-group" key={g.group}>
            <div className="nav-label">{g.group}</div>
            {items.map((i) => (
              <Link key={i.href} href={i.href}
                className={`nav-link ${pathname === i.href || pathname.startsWith(i.href + '/') ? 'active' : ''}`}>
                {i.label}
              </Link>
            ))}
          </div>
        );
      })}

      <div style={{ marginTop: 'auto', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
        <div className="faint" style={{ marginBottom: '.1rem' }}>{user.email}</div>
        <div style={{ marginBottom: '.5rem' }}>
          <span className={`badge ${user.role === 'ADMIN' ? 'gold' : user.role === 'DIRECTOR' ? 'blue' : 'green'}`}>
            {user.role}
          </span>
        </div>
        <button className="ghost small" onClick={logout}>Sign out</button>
      </div>
    </aside>
  );
}
