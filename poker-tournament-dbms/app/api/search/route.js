/**
 * GET /api/search — the vector-database feature, exposed to the UI.
 *
 * ?q=              free-text query, embedded at request time
 * &mode=semantic   cosine ANN over hand_summary.embedding  (default)
 * &mode=lexical    PostgreSQL full-text search over search_tsv
 * &mode=hybrid     both, fused with Reciprocal Rank Fusion
 * &tournamentId=   optional structured pre-filter
 * &minPot=         optional structured pre-filter
 * &showdownOnly=   optional structured pre-filter
 *
 * The three modes exist so the report can show, with live numbers, what
 * the vector index buys over keyword matching.
 */

import { guard, json, fail, intParam } from '@/lib/api';
import { queryRows } from '@/lib/db';
import { embed, toVectorLiteral, EMBEDDING_MODEL } from '@/lib/embedding';

export const dynamic = 'force-dynamic';

export const GET = guard('analytics:read', async (req) => {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const mode = url.searchParams.get('mode') ?? 'semantic';
  const tournamentId = intParam(req, 'tournamentId');
  const minPot = intParam(req, 'minPot');
  const showdownOnly = url.searchParams.get('showdownOnly') === 'true';
  const limit = Math.min(50, Math.max(1, intParam(req, 'limit') ?? 10));

  if (!q) return fail('A search query is required.');
  if (!['semantic', 'lexical', 'hybrid'].includes(mode)) return fail('Unknown search mode.');

  const started = Date.now();

  // ---- lexical branch -------------------------------------------------
  const runLexical = () =>
    queryRows(
      `SELECT h.hand_id, h.tournament_id, h.hand_no, h.pot_size,
              h.went_to_showdown, hs.summary_text, hs.metadata,
              t.title AS tournament_title,
              ROUND(ts_rank(hs.search_tsv,
                    websearch_to_tsquery('english', $1))::numeric, 4) AS score
         FROM hand_summary hs
         JOIN hand h       ON h.hand_id = hs.hand_id
         JOIN tournament t ON t.tournament_id = h.tournament_id
        WHERE hs.search_tsv @@ websearch_to_tsquery('english', $1)
          AND ($2::int IS NULL OR h.tournament_id = $2)
          AND ($3::numeric IS NULL OR h.pot_size >= $3)
          AND (NOT $4 OR h.went_to_showdown)
        ORDER BY score DESC
        LIMIT $5`,
      [q, tournamentId, minPot, showdownOnly, limit],
    );

  // ---- semantic branch ------------------------------------------------
  const runSemantic = async (n = limit) => {
    const vector = toVectorLiteral(await embed(q));
    return queryRows(
      `SELECT h.hand_id, h.tournament_id, h.hand_no, h.pot_size,
              h.went_to_showdown, hs.summary_text, hs.metadata,
              t.title AS tournament_title,
              ROUND((1 - (hs.embedding <=> $1::vector))::numeric, 4) AS score
         FROM hand_summary hs
         JOIN hand h       ON h.hand_id = hs.hand_id
         JOIN tournament t ON t.tournament_id = h.tournament_id
        WHERE ($2::int IS NULL OR h.tournament_id = $2)
          AND ($3::numeric IS NULL OR h.pot_size >= $3)
          AND (NOT $4 OR h.went_to_showdown)
        ORDER BY hs.embedding <=> $1::vector
        LIMIT $5`,
      [vector, tournamentId, minPot, showdownOnly, n],
    );
  };

  let results;

  if (mode === 'lexical') {
    results = await runLexical();
  } else if (mode === 'semantic') {
    results = await runSemantic();
  } else {
    // Reciprocal Rank Fusion: score = sum over lists of 1/(k + rank).
    // Rank-based fusion avoids having to normalise two scores that are
    // on completely different scales (ts_rank vs cosine similarity).
    const K = 60;
    const [sem, lex] = await Promise.all([runSemantic(limit * 2), runLexical()]);
    const fused = new Map();

    sem.forEach((row, i) => {
      fused.set(row.hand_id, { ...row, rrf: 1 / (K + i + 1), semanticRank: i + 1 });
    });
    lex.forEach((row, i) => {
      const existing = fused.get(row.hand_id);
      if (existing) {
        existing.rrf += 1 / (K + i + 1);
        existing.lexicalRank = i + 1;
      } else {
        fused.set(row.hand_id, { ...row, rrf: 1 / (K + i + 1), lexicalRank: i + 1 });
      }
    });

    results = [...fused.values()]
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, limit)
      .map((r) => ({ ...r, score: Number(r.rrf.toFixed(5)) }));
  }

  return json({
    query: q,
    mode,
    model: mode === 'lexical' ? 'postgresql-fts-english' : EMBEDDING_MODEL,
    metric: mode === 'lexical' ? 'ts_rank' : 'cosine similarity (1 - distance)',
    tookMs: Date.now() - started,
    count: results.length,
    results,
  });
});
