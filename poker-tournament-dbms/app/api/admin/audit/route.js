/**
 * GET /api/admin/audit — the trigger-written audit trail.
 */
import { guard, json, pagination } from '@/lib/api';
import { queryRows } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = guard('audit:read', async (req) => {
  const { page, pageSize, offset } = pagination(req, 30);
  const rows = await queryRows(
    `SELECT audit_id, table_name, operation, row_pk, changed_by, changed_at,
            old_data, new_data
       FROM audit_log
      ORDER BY audit_id DESC
      LIMIT $1 OFFSET $2`, [pageSize, offset]);
  const [{ total }] = await queryRows('SELECT COUNT(*)::int AS total FROM audit_log');
  return json({ entries: rows, page, pageSize, total });
});
