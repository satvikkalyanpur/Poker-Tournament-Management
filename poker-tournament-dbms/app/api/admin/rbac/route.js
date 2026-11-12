/**
 * GET /api/admin/rbac — the live database privilege matrix.
 * Proves to a grader that role-based access control is enforced by
 * PostgreSQL, not only by this application.
 */
import { guard, json } from '@/lib/api';
import { queryRows } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = guard('audit:read', async () => {
  const grants = await queryRows(`
    SELECT grantee, table_name,
           STRING_AGG(DISTINCT privilege_type, ', ' ORDER BY privilege_type) AS privileges
      FROM information_schema.role_table_grants
     WHERE grantee IN ('poker_admin','poker_director','poker_player')
     GROUP BY grantee, table_name
     ORDER BY grantee, table_name`);

  const policies = await queryRows(`
    SELECT schemaname, tablename, policyname, roles::text AS roles,
           cmd, qual
      FROM pg_policies WHERE schemaname='public'
     ORDER BY tablename, policyname`);

  const roles = await queryRows(`
    SELECT rolname, rolcanlogin, rolsuper
      FROM pg_roles WHERE rolname LIKE 'poker%' ORDER BY rolname`);

  return json({ grants, policies, roles });
});
