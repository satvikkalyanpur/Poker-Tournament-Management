import { currentUser, json, fail } from '@/lib/api';
import { PERMISSIONS } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = currentUser();
  if (!user) return fail('Not signed in.', 401);
  return json({ user, permissions: PERMISSIONS[user.role] ?? [] });
}
