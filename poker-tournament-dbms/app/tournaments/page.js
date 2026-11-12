'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

const money = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export default function TournamentsPage() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page) });
    if (status) params.set('status', status);
    if (q) params.set('q', q);
    fetch(`/api/tournaments?${params}`).then((r) => r.json()).then(setData);
  }, [status, q, page]);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Tournaments</h1>
          <p className="sub">Filtering and pagination are done in SQL, not in the browser.</p>
        </div>
      </div>

      <div className="toolbar">
        <div className="grow">
          <label htmlFor="q">Search title</label>
          <input id="q" value={q} placeholder="e.g. Deepstack"
                 onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
        <div style={{ minWidth: 170 }}>
          <label htmlFor="st">Status</label>
          <select id="st" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All</option>
            <option value="SCHEDULED">Scheduled</option>
            <option value="RUNNING">Running</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
      </div>

      {!data ? <p className="muted">Loading…</p> : (
        <div className="card">
          <div className="hint">{data.total} tournaments — page {data.page}</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th><th>Venue</th><th>Type</th><th>Format</th><th>Status</th>
                  <th className="num">Buy-in</th><th className="num">Entries</th>
                  <th className="num">Prize pool</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.tournaments.map((t) => (
                  <tr key={t.tournament_id}>
                    <td className="nowrap">{t.title}</td>
                    <td className="nowrap">{t.venue_name}<div className="faint">{t.city}</div></td>
                    <td><span className="badge">{t.game_type}</span></td>
                    <td><span className="badge purple">{t.format}</span></td>
                    <td>
                      <span className={`badge ${t.status === 'COMPLETED' ? 'green'
                        : t.status === 'RUNNING' ? 'gold' : 'blue'}`}>{t.status}</span>
                    </td>
                    <td className="num">{money(t.buy_in)}</td>
                    <td className="num">{t.entrants_count}/{t.max_entries}</td>
                    <td className="num">{money(t.prize_pool)}</td>
                    <td><Link href={`/tournaments/${t.tournament_id}`}>open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: '.5rem', marginTop: '.8rem' }}>
            <button className="ghost small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <button className="ghost small"
                    disabled={data.page * data.pageSize >= data.total}
                    onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </div>
      )}
    </>
  );
}
