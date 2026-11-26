// Search beyond the catalog: TMDB's own search (what Seerr uses), minus anything MonkeySee
// already shows. Finds titles that aren't on your services yet, like films still in or
// not yet in theaters, so they can be requested.
import { all, type Db } from '../db/db.js';
import type { TmdbClient } from '../clients/tmdb.js';
import type { TmdbResult } from '../api/types.js';

const cache = new Map<string, { at: number; value: TmdbResult[] }>();
const TTL = 10 * 60_000;

export async function searchTmdb(db: Db, tmdb: TmdbClient, query: string, now = Date.now()): Promise<TmdbResult[]> {
  const key = query.trim().toLowerCase();
  const hit = cache.get(key);
  let hits = hit && now - hit.at < TTL ? hit.value : null;
  if (!hits) {
    hits = (await tmdb.search(query)).map((r) => ({
      tmdbId: r.id, type: r.type, title: r.title, year: r.date ? Number(r.date.slice(0, 4)) || null : null, date: r.date,
      posterPath: r.posterPath, overview: r.overview, voteAverage: r.voteAverage, voteCount: r.voteCount, popularity: r.popularity,
      state: null,
    }));
    cache.set(key, { at: now, value: hits });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  if (!hits.length) return [];
  const ids = hits.map((h) => h.tmdbId);
  const ph = ids.map(() => '?').join(',');
  const keys = (sql: string, params: number[]) => new Set(all<{ k: string }>(db, sql, params).map((r) => r.k));
  // Drop what the catalog already shows; mark what you've requested or already have.
  const inCatalog = keys(`SELECT tmdb_type || ':' || tmdb_id AS k FROM titles WHERE tmdb_id IN (${ph})`, ids);
  const have = keys(`SELECT media_type || ':' || tmdb_id AS k FROM jellyfin_items WHERE tmdb_id IN (${ph})
                     UNION SELECT media_type || ':' || tmdb_id FROM library_items WHERE tmdb_id IN (${ph})`, [...ids, ...ids]);
  const seerr = new Map(all<{ k: string; status: number }>(db, `SELECT media_type || ':' || tmdb_id AS k, status FROM seerr_media WHERE tmdb_id IN (${ph})`, ids).map((r) => [r.k, r.status]));
  return hits
    .filter((h) => !inCatalog.has(`${h.type}:${h.tmdbId}`))
    .filter((h) => h.posterPath || h.popularity >= 2)     // skip TMDB's long tail of empty stubs
    .slice(0, 18)
    .map((h) => {
      const k = `${h.type}:${h.tmdbId}`;
      const s = seerr.get(k);
      return { ...h, state: have.has(k) || s === 5 ? 'available' as const : s === 4 ? 'partial' as const : s === 2 || s === 3 ? 'requested' as const : null };
    });
}
