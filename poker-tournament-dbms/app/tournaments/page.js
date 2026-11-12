'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';

const money = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const AXIS = { stroke: '#6b7786', fontSize: 11 };
const TIP = {
  contentStyle: { background: '#161b23', border: '1px solid #242c38', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#9aa6b6' },
};

export default function TournamentDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [tab, setTab] = useState('standings');
  const [role, setRole] = useState(null);

  const load = useCallback(() => {
    fetch(`/api/tournaments/${id}`)
      .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e))))
      .then(setData)
      .catch((e) => setError(e.error ?? 'Could not load tournament.'));
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => setRole(d.user?.role ?? null));
  }, []);

  async function action(path, body, label) {
    setMsg(null);
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      setMsg({ ok: true, text: `${label} completed.` });
      load();
    } else {
      setMsg({ ok: false, text: json.error ?? `${label} failed.` });
    }
  }

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;

  const { tournament: t, levels, payouts, standings, finance, topPots, tables, trajectory } = data;
  const privileged = role === 'ADMIN' || role === 'DIRECTOR';

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.title}</h1>
          <p className="sub">
            {t.venue_name}, {t.city} · {t.game_type} · {t.format} ·{' '}
            <span className={`badge ${t.status === 'COMPLETED' ? 'green' : t.status === 'RUNNING' ? 'gold' : 'blue'}`}>
              {t.status}
            </span>
          </p>
        </div>
        <Link className="btn" href="/tournaments">All tournaments</Link>
      </div>

      {msg && <div className={`alert ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</div>}

      <div className="grid cols-4" style={{ marginBottom: '1.1rem' }}>
        <div className="card stat">
          <div className="value gold">{money(t.prize_pool)}</div>
          <div className="label">Prize pool (derived)</div>
        </div>
        <div className="card stat">
          <div className="value">{t.entrants_count}</div>
          <div className="label">Entries of {t.max_entries}</div>
        </div>
        <div className="card stat">
          <div className="value accent">{t.players_remaining}</div>
          <div className="label">Still playing</div>
        </div>
        <div className="card stat">
          <div className="value">{money(t.buy_in)}</div>
          <div className="label">Buy-in · {t.rake_pct}% rake</div>
        </div>
      </div>

      {privileged && (
        <div className="card" style={{ marginBottom: '1.1rem' }}>
          <h3>Operations</h3>
          <div className="hint">
            Each button issues one CALL to a stored procedure; every write inside it is one transaction.
          </div>
          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
            <button onClick={() => action('/api/admin/balance', { tournamentId: Number(id), minPlayers: 4 }, 'Table balancing')}>
              sp_balance_tables
            </button>
            <button onClick={() => action('/api/admin/payouts', { tournamentId: Number(id) }, 'Payout run')}
                    disabled={t.status === 'COMPLETED'}>
              sp_calculate_payouts
            </button>
          </div>
          {t.status === 'COMPLETED' && (
            <div className="faint" style={{ marginTop: '.5rem' }}>
              Already paid out. Re-running is refused by the procedure itself, not by this page.
            </div>
          )}
        </div>
      )}

      <div className="tabs">
        {['standings', 'structure', 'money', 'tables', 'hands'].map((x) => (
          <button key={x} className={`tab ${tab === x ? 'active' : ''}`} onClick={() => setTab(x)}>
            {x[0].toUpperCase() + x.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'standings' && (
        <div className="grid cols-2">
          <div className="card">
            <h3>Standings</h3>
            <div className="hint">Set-returning function fn_tournament_standings(tournament_id)</div>
            <div className="sql-note">SELECT * FROM fn_tournament_standings({id})</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th className="num">#</th><th>Player</th><th className="num">Chips</th>
                      <th className="num">BB</th><th>State</th><th className="num">Prize</th></tr>
                </thead>
                <tbody>
                  {standings.map((s) => (
                    <tr key={s.registration_id}>
                      <td className="num">{s.standing_pos}</td>
                      <td className="nowrap">{s.screen_name}</td>
                      <td className="num">{Number(s.chip_stack).toLocaleString('en-IN')}</td>
                      <td className="num">{s.big_blinds}</td>
                      <td>
                        <span className={`badge ${s.is_active ? 'green' : ''}`}>
                          {s.is_active ? 'playing' : 'out'}
                        </span>
                      </td>
                      <td className="num">{s.prize_won > 0 ? money(s.prize_won) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h3>Winner&apos;s chip trajectory</h3>
            <div className="hint">chip_count_log, one snapshot per level</div>
            {trajectory.length === 0 ? <p className="muted">No snapshots recorded.</p> : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={trajectory}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#242c38" />
                  <XAxis dataKey="level_no" {...AXIS} />
                  <YAxis {...AXIS} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} />
                  <Tooltip {...TIP} formatter={(v) => Number(v).toLocaleString('en-IN')} />
                  <Line type="monotone" dataKey="chip_stack" stroke="#2f9e6b" strokeWidth={2} dot={{ r: 2 }} name="Chips" />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}

      {tab === 'structure' && (
        <div className="grid cols-2">
          <div className="card">
            <h3>Blind structure</h3>
            <div className="hint">Weak entity blind_level — PK (tournament_id, level_no)</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th className="num">Level</th><th className="num">Small</th><th className="num">Big</th>
                           <th className="num">Ante</th><th className="num">Minutes</th><th></th></tr></thead>
                <tbody>
                  {levels.map((l) => (
                    <tr key={l.level_no}>
                      <td className="num">{l.level_no}</td>
                      <td className="num">{l.small_blind}</td>
                      <td className="num">{l.big_blind}</td>
                      <td className="num">{l.ante}</td>
                      <td className="num">{l.duration_min}</td>
                      <td>{l.is_break && <span className="badge blue">break</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h3>Payout ladder</h3>
            <div className="hint">Weak entity payout_tier — percentages of the derived prize pool</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Places</th><th className="num">% of pool</th><th className="num">Prize each</th></tr></thead>
                <tbody>
                  {payouts.map((p) => (
                    <tr key={p.rank_from}>
                      <td>{p.rank_from === p.rank_to ? p.rank_from : `${p.rank_from}–${p.rank_to}`}</td>
                      <td className="num">{p.pct_of_pool}%</td>
                      <td className="num">{money((t.prize_pool * p.pct_of_pool) / 100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'money' && finance && (
        <div className="card">
          <h3>Financial reconciliation</h3>
          <div className="hint">View v_financial_summary — entries in, prizes out, house rake</div>
          <div className="grid cols-4">
            <div className="stat"><div className="value">{money(finance.gross_entries)}</div><div className="label">Gross entries</div></div>
            <div className="stat"><div className="value gold">{money(finance.prize_pool)}</div><div className="label">Prize pool</div></div>
            <div className="stat"><div className="value accent">{money(finance.total_payouts)}</div><div className="label">Paid out</div></div>
            <div className="stat"><div className="value blue">{money(finance.house_rake)}</div><div className="label">House rake</div></div>
          </div>
          <div className="faint" style={{ marginTop: '.7rem' }}>
            {finance.txn_count} transactions recorded. Gross entries minus the prize pool equals
            the rake, which is the invariant this view exists to make checkable.
          </div>
        </div>
      )}

      {tab === 'tables' && (
        <div className="card">
          <h3>Tables</h3>
          <div className="hint">Live seat occupancy, enforced by a partial unique index</div>
          <div className="grid cols-4">
            {tables.map((tb) => (
              <div className="card" key={tb.table_no} style={{ background: 'var(--bg-input)' }}>
                <div className="stat">
                  <div className="value">{tb.seated}</div>
                  <div className="label">Table {tb.table_no}</div>
                </div>
                <span className={`badge ${tb.status === 'OPEN' ? 'green' : tb.status === 'BROKEN' ? 'red' : 'gold'}`}>
                  {tb.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'hands' && (
        <div className="card">
          <h3>Biggest pots</h3>
          <div className="hint">Served by the descending composite index on (tournament_id, pot_size)</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th className="num">Hand</th><th className="num">Pot</th><th>Board</th>
                         <th>Showdown</th><th>Narrative</th></tr></thead>
              <tbody>
                {topPots.map((h) => (
                  <tr key={h.hand_id}>
                    <td className="num">{h.hand_no}</td>
                    <td className="num">{Number(h.pot_size).toLocaleString('en-IN')}</td>
                    <td className="mono nowrap">{h.board_cards ?? '—'}</td>
                    <td>{h.went_to_showdown ? <span className="badge green">yes</span> : <span className="badge">no</span>}</td>
                    <td style={{ fontSize: '.8rem' }}>{h.summary_text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
