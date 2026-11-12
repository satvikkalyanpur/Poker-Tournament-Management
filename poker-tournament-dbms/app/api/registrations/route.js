/**
 * POST /api/registrations — register a player, via sp_register_player.
 * One CALL performs four writes atomically (entry, payment, seat,
 * starting-stack snapshot).
 */
import { guard, json, fail } from '@/lib/api';
import { withTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const POST = guard('registration:create', async (req, { dbRole }) => {
  const body = await req.json().catch(() => null);
  if (!body?.tournamentId || !body?.playerId) {
    return fail('tournamentId and playerId are required.');
  }

  const out = await withTransaction(async (client) => {
    const { rows } = await client.query(
      'CALL sp_register_player($1,$2,$3,$4,NULL)',
      [body.tournamentId, body.playerId, body.method ?? 'CASH', body.entryType ?? 'BUYIN'],
    );
    return rows[0];
  }, { role: dbRole });

  return json({ registrationId: out.p_registration_id }, 201);
});

export const DELETE = guard('registration:update', async (req, { dbRole }) => {
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isInteger(id)) return fail('A registration id is required.');

  // Eliminating is a status change, not a delete: the entry must stay
  // on record because results and money reference it.
  const out = await withTransaction(async (client) => {
    const eliminator = new URL(req.url).searchParams.get('eliminatedBy');
    await client.query('CALL sp_eliminate_player($1,$2)',
      [id, eliminator ? Number(eliminator) : null]);
    const { rows } = await client.query(
      'SELECT registration_id, finish_rank, is_active FROM registration WHERE registration_id=$1',
      [id]);
    return rows[0];
  }, { role: dbRole });

  return json({ registration: out });
});
