'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const DEMO = [
  { email: 'admin@pokerlytics.dev',    role: 'ADMIN',    note: 'full control, audit, refunds' },
  { email: 'director@pokerlytics.dev', role: 'DIRECTOR', note: 'run events, pay out, no user table' },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('admin@pokerlytics.dev');
  const [password, setPassword] = useState('Passw0rd!');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (res.ok) {
      router.push('/dashboard');
      router.refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? 'Sign-in failed.');
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand" style={{ justifyContent: 'center', border: 'none' }}>
          <span className="chip" /> PokerLytics
        </div>
        <p className="center muted" style={{ marginTop: '-.4rem', fontSize: '.85rem' }}>
          Tournament management &amp; analysis
        </p>

        <div className="card">
          <form onSubmit={submit}>
            {error && <div className="alert error">{error}</div>}

            <div className="field">
              <label htmlFor="email">E-mail</label>
              <input id="email" type="email" value={email} autoComplete="username"
                     onChange={(e) => setEmail(e.target.value)} required />
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" type="password" value={password} autoComplete="current-password"
                     onChange={(e) => setPassword(e.target.value)} required />
            </div>

            <button type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <div className="card" style={{ marginTop: '.8rem' }}>
          <h3 style={{ fontSize: '.8rem' }}>Demo accounts</h3>
          <div className="hint">Password is whatever SEED_PASSWORD was set to (default Passw0rd!)</div>
          {DEMO.map((d) => (
            <div key={d.email} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.35rem' }}>
              <button type="button" className="ghost small" onClick={() => setEmail(d.email)}>
                use
              </button>
              <div style={{ minWidth: 0 }}>
                <div className="mono" style={{ fontSize: '.78rem' }}>{d.email}</div>
                <div className="faint">{d.role} — {d.note}</div>
              </div>
            </div>
          ))}
          <div className="faint" style={{ marginTop: '.5rem' }}>
            Any seeded player account (…@players.dev) signs in with the PLAYER role,
            which is read-only and restricted by row-level security.
          </div>
        </div>
      </div>
    </div>
  );
}
