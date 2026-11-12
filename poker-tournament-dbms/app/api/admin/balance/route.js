/**
 * POST /api/admin/balance — run sp_balance_tables.
 */
import { guard, json, fail } from '@/lib/api';
import { withTransaction, queryRows } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const POST = guard('table:balance', async (req, { dbRole }) => {
  const body = await req.json().catch(() => null);
  const id = Number(body?.tournamentId);
  if (!Number.isInteger(id)) return fail('tournamentId is required.');

  await withTransaction(
    (client) => client.query('CALL sp_balance_tables($1,$2)',
      [id, Number(body?.minPlayers ?? 4)]),
    { role: dbRole },
  );

  const tables = await queryRows(
    `SELECT pt.table_no, pt.status, COUNT(sa.seat_id)::int AS seated
       FROM poker_table pt
       LEFT JOIN seat_assignment sa
              ON sa.table_id = pt.table_id AND sa.vacated_at IS NULL
      WHERE pt.tournament_id = $1
      GROUP BY pt.table_id, pt.table_no, pt.status
      ORDER BY pt.table_no`, [id]);

  return json({ tournamentId: id, tables });
});
