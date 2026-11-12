'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';

const money = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const AXIS = { stroke: '#6b7786', fontSize: 11 };
const TIP = {
  contentStyle: { background: '#161b23', border: '1px solid #242c38', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#9aa6b6' },
};

export default function PlayerProfile() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/players/${id}`)
      .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e))))
      .then(setData)
      .catch((e) => setError(e.error ?? 'Could not load player.'));
  }, [id]);

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;

  const { profile, results, positional, knockouts, phones, trajectory } = data;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{profile.screen_name}</h1>
          <p className="sub">
            {profile.full_name} · <span className="badge">{profile.country}</span> · age {profile.age}
          </p>
        </div>
        <Link className="btn" href="/players">Back to players</Link>
      </div>

      <div className="grid cols-4" style={{ marginBottom: '1.1rem' }}>
        <div className="card stat">
          <div className="value gold">{money(profile.lifetime_earnings)}</div>
          <div className="label">Lifetime earnings</div>
        </div>
        <div className="card stat">
          <div className="value">{profile.total_entries}</div>
          <div className="label">Entries</div>
        </div>
        <div className="card stat">
          <div className="value accent">{profile.times_cashed}</div>
          <div className="label">Cashes ({profile.cash_rate_pct ?? 0}%)</div>
        </div>
        <div className="card stat">
          <div className="value" style={{ color: profile.roi_pct >= 0 ? 'var(--accent)' : 'var(--red)' }}>
            {profile.roi_pct > 0 ? '+' : ''}{profile.roi_pct}%
          </div>
          <div className="label">Return on investment</div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Win rate by table position</h3>
          <div className="hint">
            Derived from hand_player.seat_no and is_dealer, grouped into position bands
          </div>
          {positional.length === 0 ? <p className="muted">No hands recorded.</p> : (
            <>
              <ResponsiveContainer width="100%" height={210}>
                <BarChart data={positional}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#242c38" vertical={false} />
                  <XAxis dataKey="position_group" {...AXIS} />
                  <YAxis {...AXIS} unit="%" />
                  <Tooltip {...TIP} formatter={(v, n) => (n === 'win_rate_pct' ? `${v}%` : v)} />
                  <Bar dataKey="win_rate_pct" name="Win rate" radius={[3, 3, 0, 0]}>
                    {positional.map((p, i) => (
                      <Cell key={i} fill={p.net_chips >= 0 ? '#2f9e6b' : '#d2544b'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Position</th><th className="num">Hands</th><th className="num">Won</th>
                        <th className="num">Win rate</th><th className="num">Net chips</th></tr>
                  </thead>
                  <tbody>
                    {positional.map((p) => (
                      <tr key={p.position_group}>
                        <td>{p.position_group}</td>
                        <td className="num">{p.hands}</td>
                        <td className="num">{p.won}</td>
                        <td className="num">{p.win_rate_pct}%</td>
                        <td className="num" style={{ color: p.net_chips >= 0 ? 'var(--accent)' : 'var(--red)' }}>
                          {Number(p.net_chips).toLocaleString('en-IN')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <h3>Chip trajectory, best finish</h3>
          <div className="hint">chip_count_log snapshots, one per blind level</div>
          {trajectory.length === 0 ? <p className="muted">No chip snapshots recorded.</p> : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={trajectory}>
                <CartesianGrid strokeDasharray="3 3" stroke="#242c38" />
                <XAxis dataKey="level_no" {...AXIS} label={{ value: 'Level', position: 'insideBottom', offset: -3, fill: '#6b7786', fontSize: 11 }} />
                <YAxis {...AXIS} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} />
                <Tooltip {...TIP} formatter={(v) => Number(v).toLocaleString('en-IN')} />
                <Line type="monotone" dataKey="chip_stack" stroke="#d9a441" strokeWidth={2} dot={{ r: 2 }} name="Chips" />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card">
          <h3>Tournament results</h3>
          <div className="hint">Most recent 25 entries</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Tournament</th><th className="num">Buy-in</th><th className="num">Field</th>
                    <th className="num">Finish</th><th className="num">Prize</th><th></th></tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i}>
                    <td className="nowrap">{r.title}</td>
                    <td className="num">{money(r.buy_in)}</td>
                    <td className="num">{r.entrants_count}</td>
                    <td className="num">
                      {r.finish_rank === 1
                        ? <span className="badge gold">WINNER</span>
                        : (r.finish_rank ?? '—')}
                    </td>
                    <td className="num">{r.prize_won > 0 ? money(r.prize_won) : '—'}</td>
                    <td><Link href={`/tournaments/${r.tournament_id}`}>open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h3>Knockouts delivered</h3>
          <div className="hint">Self-join on registration.eliminated_by_reg_id</div>
          {knockouts.length === 0 ? <p className="muted">No knockouts recorded.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Eliminated</th><th>Tournament</th><th className="num">Their finish</th></tr></thead>
                <tbody>
                  {knockouts.map((k, i) => (
                    <tr key={i}>
                      <td>{k.victim}</td>
                      <td className="nowrap faint">{k.title}</td>
                      <td className="num">{k.finish_rank}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {phones.length > 0 && (
            <>
              <h3 style={{ marginTop: '1rem' }}>Contact numbers</h3>
              <div className="hint">
                player_phone — the multivalued ER attribute, stored as its own relation
              </div>
              {phones.map((p) => (
                <div key={p.phone} className="mono" style={{ fontSize: '.82rem' }}>
                  {p.phone} {p.is_primary && <span className="badge green">primary</span>}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}
