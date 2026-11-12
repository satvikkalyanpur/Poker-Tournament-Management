/**
 * POST /api/admin/payouts — run sp_calculate_payouts for a tournament.
 * The whole payout, including the materialised-view refresh, is one
 * transaction: either every finisher is paid or none is.
 */
import { guard, json, fail } from '@/lib/api';
import { withTransaction, queryRows } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const POST = guard('payout:run', async (req, { dbRole }) => {
  const body = await req.json().catch(() => null);
  const id = Number(body?.tournamentId);
  if (!Number.isInteger(id)) return fail('tournamentId is required.');

  await withTransaction(
    (client) => client.query('CALL sp_calculate_payouts($1)', [id]),
    { role: dbRole },
  );

  const paid = await queryRows(
    `SELECT r.finish_rank, p.screen_name, r.prize_won, r.points_awarded
       FROM registration r JOIN player p ON p.player_id = r.player_id
      WHERE r.tournament_id = $1 AND r.prize_won > 0
      ORDER BY r.finish_rank`,
    [id],
  );

  return json({ tournamentId: id, paid });
});
