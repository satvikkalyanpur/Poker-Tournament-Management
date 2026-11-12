'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from 'recharts';

const money = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const num = (n) => Number(n ?? 0).toLocaleString('en-IN');

const CHART_AXIS = { stroke: '#6b7786', fontSize: 11 };
const TOOLTIP_STYLE = {
  contentStyle: { background: '#161b23', border: '1px solid #242c38', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#9aa6b6' },
};

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/analytics')
      .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e))))
      .then(setData)
      .catch((e) => setError(e.error ?? 'Failed to load analytics.'));
  }, []);

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <p className="muted">Loading analytics…</p>;

  const { totals, leaderboard, seasonBoard, venueStats, aggression,
          recentTournaments, potDistribution, eliminationChains, vectorStats, quartiles } = data;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Dashboard</h1>
          <p className="sub">Live aggregates computed in PostgreSQL — no numbers are cached in the app.</p>
        </div>
      </div>

      {/* headline counters */}
      <div className="grid cols-4" style={{ marginBottom: '1.2rem' }}>
        <div className="card stat">
          <div className="value accent">{num(totals.players)}</div>
          <div className="label">Players</div>
        </div>
        <div className="card stat">
          <div className="value">{num(totals.tournaments)}</div>
          <div className="label">Tournaments</div>
        </div>
        <div className="card stat">
          <div className="value">{num(totals.entries)}</div>
          <div className="label">Entries</div>
        </div>
        <div className="card stat">
          <div className="value blue">{num(totals.hands)}</div>
          <div className="label">Hands dealt</div>
        </div>
        <div className="card stat">
          <div className="value">{num(totals.actions)}</div>
          <div className="label">Betting actions</div>
        </div>
        <div className="card stat">
          <div className="value purple">{num(totals.embeddings)}</div>
          <div className="label">Embedded hands</div>
        </div>
        <div className="card stat">
          <div className="value gold">{money(totals.total_paid)}</div>
          <div className="label">Prize money paid</div>
        </div>
        <div className="card stat">
          <div className="value">{num(totals.still_playing)}</div>
          <div className="label">Still playing</div>
        </div>
      </div>

      <div className="grid cols-2">
        {/* leaderboard */}
        <div className="card">
          <h3>Career leaderboard</h3>
          <div className="hint">v_player_profile + RANK() window function</div>
          <div className="sql-note">RANK() OVER (ORDER BY lifetime_earnings DESC)</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">#</th><th>Player</th><th></th>
                  <th className="num">Earnings</th><th className="num">Cashes</th>
                  <th className="num">Titles</th><th className="num">ROI</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((p) => (
                  <tr key={p.screen_name}>
                    <td className="num">{p.rank}</td>
                    <td className="nowrap">{p.screen_name}</td>
                    <td><span className="badge">{p.country}</span></td>
                    <td className="num">{money(p.lifetime_earnings)}</td>
                    <td className="num">{p.times_cashed}</td>
                    <td className="num">{p.titles}</td>
                    <td className="num" style={{ color: p.roi_pct >= 0 ? 'var(--accent)' : 'var(--red)' }}>
                      {p.roi_pct > 0 ? '+' : ''}{p.roi_pct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* pot size by level */}
        <div className="card">
          <h3>Average pot by blind level</h3>
          <div className="hint">GROUP BY level_no — pots grow as blinds escalate</div>
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={potDistribution}>
              <CartesianGrid strokeDasharray="3 3" stroke="#242c38" vertical={false} />
              <XAxis dataKey="level_no" {...CHART_AXIS} />
              <YAxis {...CHART_AXIS} tickFormatter={(v) => (v >= 1000 ? `${v / 1000}k` : v)} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v) => num(v)} />
              <Bar dataKey="avg_pot" fill="#2f9e6b" radius={[3, 3, 0, 0]} name="Average pot" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* aggression */}
        <div className="card">
          <h3>Most aggressive players</h3>
          <div className="hint">Share of actions that are BET, RAISE or ALL-IN (HAVING ≥ 20 actions)</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Player</th><th className="num">Actions</th><th>Aggression</th><th className="num">Avg think</th></tr>
              </thead>
              <tbody>
                {aggression.map((a) => (
                  <tr key={a.screen_name}>
                    <td className="nowrap">{a.screen_name}</td>
                    <td className="num">{a.actions}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                        <div className="bar-track" style={{ flex: 1 }}>
                          <div className="bar-fill" style={{ width: `${a.aggression_pct}%` }} />
                        </div>
                        <span className="mono" style={{ fontSize: '.75rem' }}>{a.aggression_pct}%</span>
                      </div>
                    </td>
                    <td className="num">{a.avg_think_sec}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* elimination chains — recursive CTE */}
        <div className="card">
          <h3>Knockout chains</h3>
          <div className="hint">WITH RECURSIVE over the self-referencing eliminated_by_reg_id FK</div>
          <div className="sql-note">{`WITH RECURSIVE chain AS (
  SELECT ... WHERE finish_rank = 1
  UNION ALL
  SELECT ... JOIN registration r
    ON r.eliminated_by_reg_id = c.registration_id)`}</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Tournament</th><th>Champion</th><th className="num">Chain size</th><th className="num">Depth</th></tr>
              </thead>
              <tbody>
                {eliminationChains.map((c) => (
                  <tr key={c.title + c.champion}>
                    <td className="nowrap">{c.title}</td>
                    <td>{c.champion}</td>
                    <td className="num">{c.chain_size}</td>
                    <td className="num">{c.chain_depth}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* venues */}
        <div className="card">
          <h3>Venue activity</h3>
          <div className="hint">GROUP BY … HAVING COUNT(entries) &gt; 0</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Venue</th><th>City</th><th className="num">Events</th><th className="num">Entries</th><th className="num">Avg buy-in</th></tr>
              </thead>
              <tbody>
                {venueStats.map((v) => (
                  <tr key={v.venue_name}>
                    <td className="nowrap">{v.venue_name}</td>
                    <td>{v.city}</td>
                    <td className="num">{v.tournaments}</td>
                    <td className="num">{v.entries}</td>
                    <td className="num">{money(v.avg_buy_in)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* quartiles */}
        <div className="card">
          <h3>Earnings quartiles</h3>
          <div className="hint">NTILE(4) OVER (ORDER BY lifetime_earnings DESC)</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={quartiles}>
              <CartesianGrid strokeDasharray="3 3" stroke="#242c38" vertical={false} />
              <XAxis dataKey="quartile" {...CHART_AXIS} tickFormatter={(v) => `Q${v}`} />
              <YAxis {...CHART_AXIS} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v) => money(v)} labelFormatter={(v) => `Quartile ${v}`} />
              <Bar dataKey="avg_earnings" fill="#d9a441" radius={[3, 3, 0, 0]} name="Average earnings" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* season leaderboard — materialized view */}
        <div className="card">
          <h3>Season standings</h3>
          <div className="hint">Read from the MATERIALIZED VIEW mv_season_leaderboard</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Season</th><th className="num">#</th><th>Player</th><th className="num">Points</th><th className="num">Winnings</th></tr>
              </thead>
              <tbody>
                {seasonBoard.map((s, i) => (
                  <tr key={i}>
                    <td className="nowrap faint">{s.season_name}</td>
                    <td className="num">{s.season_rank}</td>
                    <td className="nowrap">{s.screen_name}</td>
                    <td className="num">{num(s.season_points)}</td>
                    <td className="num">{money(s.season_winnings)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* vector store */}
        <div className="card">
          <h3>Vector store</h3>
          <div className="hint">pgvector — hand narratives available for semantic retrieval</div>
          <div className="grid cols-2" style={{ gap: '.6rem' }}>
            <div className="stat"><div className="value purple">{num(vectorStats.documents)}</div><div className="label">Documents</div></div>
            <div className="stat"><div className="value">{vectorStats.dimensions}</div><div className="label">Dimensions</div></div>
            <div className="stat"><div className="value">{vectorStats.avg_norm}</div><div className="label">Avg L2 norm</div></div>
            <div className="stat"><div className="value">{vectorStats.avg_tokens}</div><div className="label">Avg tokens</div></div>
          </div>
          <div className="faint" style={{ marginTop: '.6rem' }}>
            Model <span className="mono">{vectorStats.model}</span>, cosine similarity, HNSW index.
          </div>
          <div style={{ marginTop: '.7rem' }}>
            <Link className="btn" href="/search">Open semantic search</Link>
          </div>
        </div>
      </div>

      <div className="spacer" />

      <div className="card">
        <h3>Recent tournaments</h3>
        <div className="hint">From the view v_tournament_overview (prize_pool is a derived value)</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th><th>City</th><th>Status</th>
                <th className="num">Entries</th><th className="num">Prize pool</th>
                <th className="num">Remaining</th><th></th>
              </tr>
            </thead>
            <tbody>
              {recentTournaments.map((t) => (
                <tr key={t.tournament_id}>
                  <td className="nowrap">{t.title}</td>
                  <td>{t.city}</td>
                  <td>
                    <span className={`badge ${t.status === 'COMPLETED' ? 'green'
                      : t.status === 'RUNNING' ? 'gold' : 'blue'}`}>{t.status}</span>
                  </td>
                  <td className="num">{t.entrants_count}</td>
                  <td className="num">{money(t.prize_pool)}</td>
                  <td className="num">{t.players_remaining}</td>
                  <td><Link href={`/tournaments/${t.tournament_id}`}>view</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
