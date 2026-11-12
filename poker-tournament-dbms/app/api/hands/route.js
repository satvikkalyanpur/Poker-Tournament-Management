/**
 * /api/hands
 *   GET  — browse hands (v_hand_detail)
 *   POST — record a hand through the sp_record_hand stored procedure,
 *          then write and embed its narrative, all in one transaction.
 */
import { guard, json, fail, pagination, intParam } from '@/lib/api';
import { queryRows, withTransaction } from '@/lib/db';
import { embed, toVectorLiteral, EMBEDDING_MODEL } from '@/lib/embedding';

export const dynamic = 'force-dynamic';

export const GET = guard('analytics:read', async (req) => {
  const tournamentId = intParam(req, 'tournamentId');
  const minPot = intParam(req, 'minPot');
  const { page, pageSize, offset } = pagination(req, 20);

  const rows = await queryRows(
    `SELECT * FROM v_hand_detail
      WHERE ($1::int IS NULL OR tournament_id = $1)
        AND ($2::numeric IS NULL OR pot_size >= $2)
      ORDER BY pot_size DESC, hand_id DESC
      LIMIT $3 OFFSET $4`,
    [tournamentId, minPot, pageSize, offset],
  );

  const [{ total }] = await queryRows(
    `SELECT COUNT(*)::int AS total FROM hand
      WHERE ($1::int IS NULL OR tournament_id = $1)
        AND ($2::numeric IS NULL OR pot_size >= $2)`,
    [tournamentId, minPot],
  );

  return json({ hands: rows, page, pageSize, total });
});

export const POST = guard('hand:create', async (req, { dbRole }) => {
  const body = await req.json().catch(() => null);
  if (!body) return fail('Expected a JSON body.');

  const { tableId, levelNo, board, pot, showdown = false, players, narrative } = body;
  if (!tableId || !levelNo || !Array.isArray(players) || players.length < 2) {
    return fail('tableId, levelNo and at least two players are required.');
  }

  const net = players.reduce((s, p) => s + (Number(p.chips_after) - Number(p.chips_before)), 0);
  if (net !== 0) {
    return fail(`Chips must balance: net change is ${net}, expected 0.`, 400);
  }

  const result = await withTransaction(async (client) => {
    const { rows: noRows } = await client.query(
      'SELECT COALESCE(MAX(hand_no),0) + 1 AS next FROM hand WHERE table_id = $1',
      [tableId],
    );

    const { rows } = await client.query(
      'CALL sp_record_hand($1,$2,$3,$4,$5,$6,$7::jsonb,NULL)',
      [tableId, levelNo, noRows[0].next, board ?? null, pot ?? 0, showdown,
       JSON.stringify(players)],
    );
    const handId = rows[0].p_hand_id;

    if (narrative) {
      const vec = toVectorLiteral(await embed(narrative));
      await client.query(
        `INSERT INTO hand_summary (hand_id, summary_text, embedding, model_name, metadata)
         VALUES ($1,$2,$3::vector,$4,$5::jsonb)
         ON CONFLICT (hand_id) DO UPDATE
           SET summary_text = EXCLUDED.summary_text,
               embedding    = EXCLUDED.embedding`,
        [handId, narrative, vec, EMBEDDING_MODEL,
         JSON.stringify({ went_to_showdown: showdown, players: players.length, source: 'manual' })],
      );
    }
    return { handId };
  }, { role: dbRole });

  return json(result, 201);
});
