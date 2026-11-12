'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

const money = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export default function PlayersPage() {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('');
  const [sort, setSort] = useState('earnings');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const p = new URLSearchParams({ sort, page: String(page) });
    if (q) p.set('q', q);
    if (country) p.set('country', country);
    fetch(`/api/players?${p}`).then((r) => r.json()).then(setData);
  }, [q, country, sort, page]);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Players</h1>
          <p className="sub">
            Served by the view v_player_profile — age and ROI are computed by stored functions on every read.
          </p>
        </div>
      </div>

      <div className="toolbar">
        <div className="grow">
          <label htmlFor="q">Search</label>
          <input id="q" value={q} placeholder="screen name or real name"
                 onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
        <div style={{ minWidth: 140 }}>
          <label htmlFor="c">Country</label>
          <select id="c" value={country} onChange={(e) => { setCountry(e.target.value); setPage(1); }}>
            <option value="">All</option>
            {data?.countries?.map((c) => (
              <option key={c.country} value={c.country}>{c.country} ({c.n})</option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 150 }}>
          <label htmlFor="s">Sort by</label>
          <select id="s" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="earnings">Earnings</option>
            <option value="points">Ranking points</option>
            <option value="cashes">Cashes</option>
            <option value="roi">ROI</option>
            <option value="name">Name</option>
          </select>
        </div>
      </div>

      {!data ? <p className="muted">Loading…</p> : (
        <div className="card">
          <div className="hint">{data.total} players</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Screen name</th><th>Real name</th><th></th><th className="num">Age</th>
                  <th className="num">Entries</th><th className="num">Cashes</th>
                  <th className="num">Cash rate</th><th className="num">Titles</th>
                  <th className="num">Earnings</th><th className="num">ROI</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.players.map((p) => (
                  <tr key={p.player_id}>
                    <td className="nowrap">{p.screen_name}</td>
                    <td className="nowrap faint">{p.full_name}</td>
                    <td><span className="badge">{p.country}</span></td>
                    <td className="num">{p.age}</td>
                    <td className="num">{p.total_entries}</td>
                    <td className="num">{p.times_cashed}</td>
                    <td className="num">{p.cash_rate_pct ?? 0}%</td>
                    <td className="num">{p.titles}</td>
                    <td className="num">{money(p.lifetime_earnings)}</td>
                    <td className="num" style={{ color: p.roi_pct >= 0 ? 'var(--accent)' : 'var(--red)' }}>
                      {p.roi_pct > 0 ? '+' : ''}{p.roi_pct}%
                    </td>
                    <td><Link href={`/players/${p.player_id}`}>profile</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: '.5rem', marginTop: '.8rem' }}>
            <button className="ghost small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <button className="ghost small" disabled={data.page * data.pageSize >= data.total}
                    onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </div>
      )}
    </>
  );
}
