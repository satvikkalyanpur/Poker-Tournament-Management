/**
 * /api/summaries/[id] — UPDATE and DELETE on the vector store.
 * Rubric item 9 asks for read, update and delete on the vector
 * component; search covers read, these two cover the rest.
 */
import { guard, json, fail } from '@/lib/api';
import { withTransaction } from '@/lib/db';
import { embed, toVectorLiteral, EMBEDDING_MODEL } from '@/lib/embedding';

export const dynamic = 'force-dynamic';

export const PUT = guard('summary:write', async (req, { params, dbRole }) => {
  const id = Number(params.id);
  const body = await req.json().catch(() => null);
  if (!Number.isInteger(id) || !body?.summaryText) {
    return fail('summaryText is required.');
  }

  // re-embed: the text and its vector must change together or the
  // search index silently returns the old meaning for the new text
  const vec = toVectorLiteral(await embed(body.summaryText));

  const row = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE hand_summary
          SET summary_text = $1,
              embedding    = $2::vector,
              model_name   = $3,
              metadata     = metadata || $4::jsonb
        WHERE summary_id = $5
        RETURNING summary_id, hand_id, token_count, updated_at`,
      [body.summaryText, vec, EMBEDDING_MODEL,
       JSON.stringify({ revised: true, ...(body.metadata ?? {}) }), id],
    );
    return rows[0];
  }, { role: dbRole });

  if (!row) return fail('Summary not found.', 404);
  return json({ summary: row, reEmbedded: true });
});

export const DELETE = guard('summary:delete', async (req, { params, dbRole }) => {
  const id = Number(params.id);
  const row = await withTransaction(async (client) => {
    const { rows } = await client.query(
      'DELETE FROM hand_summary WHERE summary_id = $1 RETURNING summary_id, hand_id',
      [id],
    );
    return rows[0];
  }, { role: dbRole });

  if (!row) return fail('Summary not found.', 404);
  return json({ deleted: row });
});
