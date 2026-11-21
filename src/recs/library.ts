import type { Config } from '../config.js';
import { all, get, run, setJobState, tx, type Db } from '../db/db.js';
import { HttpError, mapLimit } from '../clients/http.js';
import type { TmdbClient } from '../clients/tmdb.js';
import { log } from '../log.js';

/**
 * "Recommended for you". Your library is what Seerr marks available (status 4
 * or 5), which mirrors Plex and so what Sonarr and Radarr fetched. For each
 * library title TMDB gives about 20 recommendations ("people who liked this also
 * liked"); a Netflix title scores higher the more of your titles recommend it,
 * and the higher it ranks in each list.
 */

const REFRESH_DAYS = 60;

export interface LibraryResult { library: number; added: number; removed: number; fetched: number; errors: number; aborted?: string }

/** Copies the library from the Seerr mirror, then fetches recommendations for titles that need them. */
export async function refreshLibrary(db: Db, cfg: Config, tmdb: TmdbClient, now = new Date()): Promise<LibraryResult> {
  const iso = now.toISOString();
  const { added, removed } = tx(db, () => {
    const before = get<{ n: number }>(db, 'SELECT count(*) n FROM library_items')!.n;
    run(db, `DELETE FROM library_items WHERE NOT EXISTS (
      SELECT 1 FROM seerr_media sm WHERE sm.media_type = library_items.media_type AND sm.tmdb_id = library_items.tmdb_id AND sm.status IN (4, 5))`);
    const afterDelete = get<{ n: number }>(db, 'SELECT count(*) n FROM library_items')!.n;
    run(db, `INSERT OR IGNORE INTO library_items (media_type, tmdb_id, added_at)
             SELECT media_type, tmdb_id, COALESCE(updated_at, mirrored_at) FROM seerr_media WHERE status IN (4, 5)`);
    const after = get<{ n: number }>(db, 'SELECT count(*) n FROM library_items')!.n;
    return { added: after - afterDelete, removed: before - afterDelete };
  });

  const stale = new Date(now.getTime() - REFRESH_DAYS * 86_400_000).toISOString();
  const queue = all<{ media_type: 'movie' | 'tv'; tmdb_id: number }>(db, `
    SELECT media_type, tmdb_id FROM library_items
    WHERE recs_at IS NULL OR recs_at < ? OR recs_status = 'error'
    ORDER BY recs_at IS NOT NULL, added_at DESC`, [stale]);

  const result: LibraryResult = { library: 0, added, removed, fetched: 0, errors: 0 };
  let abort: string | undefined;
  await mapLimit(queue, cfg.TMDB_CONCURRENCY, async (item) => {
    if (abort) return;
    try {
      const r = await tmdb.recommendations(item.media_type, item.tmdb_id);
      tx(db, () => {
        run(db, 'DELETE FROM library_recs WHERE seed_type = ? AND seed_id = ?', [item.media_type, item.tmdb_id]);
        if (r) {
          const ins = db.prepare('INSERT OR IGNORE INTO library_recs (seed_type, seed_id, rec_type, rec_id, rank) VALUES (?, ?, ?, ?, ?)');
          for (const rec of r.recs) ins.run(item.media_type, item.tmdb_id, item.media_type, rec.id, rec.rank);
        }
        run(db, 'UPDATE library_items SET title = ?, recs_at = ?, recs_status = ? WHERE media_type = ? AND tmdb_id = ?',
          [r?.title ?? null, iso, r ? 'ok' : 'missing', item.media_type, item.tmdb_id]);
      });
      result.fetched += 1;
    } catch (err) {
      result.errors += 1;
      run(db, `UPDATE library_items SET recs_at = ?, recs_status = 'error' WHERE media_type = ? AND tmdb_id = ?`, [iso, item.media_type, item.tmdb_id]);
      if (err instanceof HttpError && err.isAuth) abort = `TMDB rejected the token (HTTP ${err.status})`;
    }
  });
  if (abort) result.aborted = abort;
  result.library = get<{ n: number }>(db, 'SELECT count(*) n FROM library_items')!.n;
  setJobState(db, 'library', { ...result, at: iso });
  log.info('library: refreshed', { ...result });
  return result;
}

/** Per-title score: the sum over your titles that recommend it, rank 1 = 1.0 down to rank 20 = 0.05. */
export const MATCH_SCORE = `(SELECT sum((21.0 - min(r.rank, 20)) / 20) FROM library_recs r WHERE r.rec_type = tk.tmdb_type AND r.rec_id = tk.tmdb_id)`;

/** Recommended and not already yours (in the library, requested or on its way). Expects tk and sm. */
export const NOT_MINE = `NOT EXISTS (SELECT 1 FROM library_items li WHERE li.media_type = tk.tmdb_type AND li.tmdb_id = tk.tmdb_id)
  AND (sm.status IS NULL OR sm.status NOT IN (2, 3, 4, 5))`;
export const RECOMMENDED = `EXISTS (SELECT 1 FROM library_recs r WHERE r.rec_type = tk.tmdb_type AND r.rec_id = tk.tmdb_id) AND ${NOT_MINE}`;

export const libraryCount = (db: Db) => get<{ n: number }>(db, 'SELECT count(*) n FROM library_items')!.n;

/**
 * Library titles to build "Because you have X" rows from: among your most
 * recently added titles, the ones whose recommendations include the most
 * Netflix titles you don't have. Takes the shown-title filter as SQL.
 */
export function becauseSeeds(db: Db, eligible: { sql: string; params: (string | number)[] }, from: string, count: number, minMatches = 6) {
  return all<{ media_type: 'movie' | 'tv'; tmdb_id: number; title: string; matches: number }>(db, `
    WITH recent AS (
      SELECT media_type, tmdb_id, title FROM library_items WHERE recs_status = 'ok' AND title IS NOT NULL
      ORDER BY added_at DESC LIMIT 60
    )
    SELECT s.media_type, s.tmdb_id, s.title, (
      SELECT count(DISTINCT tk.id) ${from}
      JOIN library_recs r ON r.rec_type = tk.tmdb_type AND r.rec_id = tk.tmdb_id
      WHERE r.seed_type = s.media_type AND r.seed_id = s.tmdb_id AND ${eligible.sql} AND ${NOT_MINE}
    ) matches
    FROM recent s
    ORDER BY matches DESC, s.title
    LIMIT ?`, [...eligible.params, count * 3]).filter((s) => s.matches >= minMatches).slice(0, count);
}
