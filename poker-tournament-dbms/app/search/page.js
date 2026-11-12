'use client';

import { useState } from 'react';

const EXAMPLES = [
  'a short stack shoved all in and got called',
  'big pot that went to showdown on the river',
  'raised from the button and everyone folded',
  'three-bet before the flop then fired a barrel',
  'the chip leader eliminated a desperate short stack',
];

export default function SearchPage() {
  const [q, setQ] = useState('a short stack shoved all in and got called');
  const [mode, setMode] = useState('semantic');
  const [minPot, setMinPot] = useState('');
  const [showdownOnly, setShowdownOnly] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(e, overrideMode) {
    e?.preventDefault();
    const useMode = overrideMode ?? mode;
    setBusy(true);
    setError('');

    const params = new URLSearchParams({ q, mode: useMode, limit: '10' });
    if (minPot) params.set('minPot', minPot);
    if (showdownOnly) params.set('showdownOnly', 'true');

    const res = await fetch(`/api/search?${params}`);
    const json = await res.json();
    if (res.ok) setData(json);
    else setError(json.error ?? 'Search failed.');
    setBusy(false);
  }

  function switchMode(m) {
    setMode(m);
    if (data) run(null, m);
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Semantic search</h1>
          <p className="sub">
            Free text is embedded into a 256-dimension vector and compared against every stored
            hand narrative by cosine distance, using the HNSW index.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <form onSubmit={run}>
          <div className="field">
            <label htmlFor="q">Describe the kind of hand you are looking for</label>
            <input id="q" value={q} onChange={(e) => setQ(e.target.value)}
                   placeholder="e.g. a short stack shoved and got called" required />
          </div>

          <div className="toolbar" style={{ marginBottom: '.6rem' }}>
            <div style={{ minWidth: 150 }}>
              <label htmlFor="minPot">Minimum pot</label>
              <input id="minPot" type="number" min="0" value={minPot}
                     onChange={(e) => setMinPot(e.target.value)} placeholder="any" />
            </div>
            <div style={{ alignSelf: 'flex-end', paddingBottom: '.45rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem', marginBottom: 0 }}>
                <input type="checkbox" checked={showdownOnly} style={{ width: 'auto' }}
                       onChange={(e) => setShowdownOnly(e.target.checked)} />
                Showdowns only
              </label>
            </div>
            <div style={{ alignSelf: 'flex-end' }}>
              <button type="submit" disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
            </div>
          </div>
        </form>

        <div className="tabs" style={{ marginBottom: '.5rem' }}>
          <button className={`tab ${mode === 'semantic' ? 'active' : ''}`}
                  onClick={() => switchMode('semantic')}>Semantic (vector)</button>
          <button className={`tab ${mode === 'lexical' ? 'active' : ''}`}
                  onClick={() => switchMode('lexical')}>Lexical (full-text)</button>
          <button className={`tab ${mode === 'hybrid' ? 'active' : ''}`}
                  onClick={() => switchMode('hybrid')}>Hybrid (RRF)</button>
        </div>

        <div className="faint">
          {mode === 'semantic' && 'ORDER BY embedding <=> query_vector — matches meaning, so "jammed" matches a search for "shoved".'}
          {mode === 'lexical' && "search_tsv @@ websearch_to_tsquery('english', q) — matches words only."}
          {mode === 'hybrid' && 'Both lists fused with Reciprocal Rank Fusion, score = Σ 1/(60 + rank).'}
        </div>

        <div style={{ marginTop: '.7rem', display: 'flex', gap: '.35rem', flexWrap: 'wrap' }}>
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="ghost small" onClick={() => setQ(ex)}>{ex}</button>
          ))}
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {data && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '.5rem' }}>
            <h3>{data.count} result{data.count === 1 ? '' : 's'}</h3>
            <div className="faint">
              {data.tookMs} ms · {data.metric} · <span className="mono">{data.model}</span>
            </div>
          </div>
          <div className="spacer" style={{ height: '.5rem' }} />

          {data.results.length === 0 && (
            <p className="muted">
              Nothing matched. Lexical search needs the exact words to appear; try semantic mode.
            </p>
          )}

          {data.results.map((r) => (
            <div className="result-item" key={r.hand_id}>
              <div className="meta">
                <span className="score-pill">{r.score}</span>
                <span className="badge">hand #{r.hand_no}</span>
                <span className="badge blue">{r.tournament_title}</span>
                <span className="badge gold">pot {Number(r.pot_size).toLocaleString('en-IN')}</span>
                {r.went_to_showdown && <span className="badge green">showdown</span>}
                {r.semanticRank && <span className="badge purple">vec #{r.semanticRank}</span>}
                {r.lexicalRank && <span className="badge">fts #{r.lexicalRank}</span>}
              </div>
              <div>{r.summary_text}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
