'use client';
import { useEffect, useState } from 'react';

export default function HandsPage() {
  const [data, setData] = useState(null);
  const [tournaments, setTournaments] = useState([]);
  const [tid, setTid] = useState('');
  const [minPot, setMinPot] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    fetch('/api/tournaments?pageSize=100').then((r) => r.json())
      .then((d) => setTournaments(d.tournaments ?? []));
  }, []);

  useEffect(() => {
    const p = new URLSearchParams({ page: String(page) });
    if (tid) p.set('tournamentId', tid);
    if (minPot) p.set('minPot', minPot);
    fetch(`/api/hands?${p}`).then((r) => r.json()).then(setData);
  }, [tid, minPot, page]);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Hand history</h1>
          <p className="sub">
            From the view v_hand_detail, which folds participants into one row with STRING_AGG.
          </p>
        </div>
      </div>

      <div className="toolbar">
        <div className="grow">
          <label htmlFor="t">Tournament</label>
          <select id="t" value={tid} onChange={(e) => { setTid(e.target.value); setPage(1); }}>
            <option value="">All tournaments</option>
            {tournaments.map((t) => (
              <option key={t.tournament_id} value={t.tournament_id}>{t.title}</option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 150 }}>
          <label htmlFor="mp">Minimum pot</label>
          <input id="mp" type="number" min="0" value={minPot} placeholder="any"
                 onChange={(e) => { setMinPot(e.target.value); setPage(1); }} />
        </div>
      </div>

      {!data ? <p className="muted">Loading…</p> : (
        <div className="card">
          <div className="hint">{data.total} hands, ordered by pot size</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">#</th><th>Tournament</th><th className="num">Table</th>
                  <th className="num">Level</th><th>Blinds</th><th>Board</th>
                  <th className="num">Pot</th><th className="num">Players</th>
                  <th>Participants</th><th>Narrative</th>
                </tr>
              </thead>
              <tbody>
                {data.hands.map((h) => (
                  <tr key={h.hand_id}>
                    <td className="num">{h.hand_no}</td>
                    <td className="nowrap faint">{h.tournament_title}</td>
                    <td className="num">{h.table_no}</td>
                    <td className="num">{h.level_no}</td>
                    <td className="mono nowrap">{h.small_blind}/{h.big_blind}</td>
                    <td className="mono nowrap">{h.board_cards ?? '—'}</td>
                    <td className="num">{Number(h.pot_size).toLocaleString('en-IN')}</td>
                    <td className="num">{h.players_in_hand}</td>
                    <td style={{ maxWidth: 190 }} className="faint">{h.participants}</td>
                    <td style={{ maxWidth: 330, fontSize: '.8rem' }}>{h.summary_text}</td>
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
