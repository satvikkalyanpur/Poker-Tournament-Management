/**
 * GET /api/players — searchable, sortable player list from v_player_profile.
 */
import { guard, json, pagination } from '@/lib/api';
import { queryRows } from '@/lib/db';

export const dynamic = 'force-dynamic';

const SORTS = {
  earnings: 'lifetime_earnings DESC',
  points: 'ranking_points DESC',
  cashes: 'times_cashed DESC',
  roi: 'roi_pct DESC',
  name: 'screen_name ASC',
};

export const GET = guard('analytics:read', async (req) => {
  const url = new URL(req.url);
  const q = url.searchParams.get('q');
  const country = url.searchParams.get('country');
  // sort key is resolved through an allow-list, never interpolated raw
  const sort = SORTS[url.searchParams.get('sort')] ?? SORTS.earnings;
  const { page, pageSize, offset } = pagination(req);

  const rows = await queryRows(
    `SELECT * FROM v_player_profile
      WHERE ($1::text IS NULL OR lower(screen_name) LIKE lower($1) || '%'
             OR lower(full_name) LIKE '%' || lower($1) || '%')
        AND ($2::text IS NULL OR country = $2)
      ORDER BY ${sort}
      LIMIT $3 OFFSET $4`,
    [q || null, country || null, pageSize, offset],
  );

  const [{ total }] = await queryRows(
    `SELECT COUNT(*)::int AS total FROM player
      WHERE ($1::text IS NULL OR lower(screen_name) LIKE lower($1) || '%')
        AND ($2::text IS NULL OR country = $2)`,
    [q || null, country || null],
  );

  const countries = await queryRows(
    'SELECT country, COUNT(*)::int AS n FROM player GROUP BY country ORDER BY n DESC',
  );

  return json({ players: rows, countries, page, pageSize, total });
});
