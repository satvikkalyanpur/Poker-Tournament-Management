/**
 * POST /api/admin/refund — compensating transaction via sp_refund_entry.
 */
import { guard, json, fail } from '@/lib/api';
import { withTransaction } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const POST = guard('registration:refund', async (req, { dbRole }) => {
  const body = await req.json().catch(() => null);
  const id = Number(body?.registrationId);
  if (!Number.isInteger(id)) return fail('registrationId is required.');

  await withTransaction(
    (client) => client.query('CALL sp_refund_entry($1,$2)',
      [id, body?.reason ?? 'Administrative refund']),
    { role: dbRole },
  );

  return json({ refunded: id });
});
