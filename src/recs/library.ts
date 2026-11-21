import type { Config } from '../config.js';
import { all, get, run, setJobState, tx, type Db } from '../db/db.js';
import { HttpError, mapLimit } from '../clients/http.js';
import type { TmdbClient } from '../clients/tmdb.js';
import type { ArrClient } from '../clients/arr.js';
import { log } from '../log.js';

/**
 * "Recommended for you". Your library is every movie Radarr has a file for and
 * every series Sonarr has episodes of (when their API keys are set), plus what
 * Seerr marks available (status 4 or 5). For each
 * library title TMDB gives about 20 recommendations ("people who liked this also
 * liked"); a Netflix title scores higher the more of your titles recommend it,
 * and the higher it ranks in each list.
 */

const REFRESH_DAYS = 60;

export interface LibraryResult {
  library: number; added: number; removed: number; fetched: number; errors: number; aborted?: string;
  sources: Record<'radarr' | 'sonarr' | 'seerr', number | 'off' | 'error'>;
}

export interface LibrarySources { radarr?: ArrClient; sonarr?: ArrClient }

interface Wanted { media_type: 'movie' | 'tv'; tmdb_id: number; title: string | null; added_at: string | null; source: 'radarr' | 'sonarr' | 'seerr' }

/** Everything you have, from each source. A source that fails is reported and its old rows kept. */
async function collect(db: Db, tmdb: TmdbClient, src: LibrarySources) {
  const wanted = new Map<string, Wanted>();
  const sources: LibraryResult['sources'] = { radarr: 'off', sonarr: 'off', seerr: 0 };
  const add = (w: Wanted) => { const k = `${w.media_type}:${w.tmdb_id}`; if (!wanted.has(k)) wanted.set(k, w); };

  if (src.radarr) {
    try {
      const movies = await src.radarr.movies();
      for (const m of movies) if (m.tmdbId) add({ media_type: 'movie', tmdb_id: m.tmdbId, title: m.title, added_at: m.added, source: 'radarr' });
      sources.radarr = movies.length;
    } catch (err) {
      sources.radarr = 'error';
      log.warn('library: Radarr unreachable', { error: (err as Error).message });
    }
  }
  if (src.sonarr) {
    try {
      const series = await src.sonarr.series();
      // Sonarr v4 gives TMDB IDs; older ones only TVDB, which TMDB can translate.
      const known = new Map(all<{ title: string; tmdb_id: number }>(db, `SELECT title, tmdb_id FROM library_items WHERE source = 'sonarr' AND title IS NOT NULL`).map((r) => [r.title, r.tmdb_id]));
      await mapLimit(series, 4, async (s) => {
        let id = s.tmdbId ?? known.get(s.title) ?? null;
        if (!id && s.tvdbId) id = await tmdb.tvByTvdb(s.tvdbId).catch(() => null);
        if (id) add({ media_type: 'tv', tmdb_id: id, title: s.title, added_at: s.added, source: 'sonarr' });
      });
      sources.sonarr = series.length;
    } catch (err) {
      sources.sonarr = 'error';
      log.warn('library: Sonarr unreachable', { error: (err as Error).message });
    }
  }
  const seerr = all<{ media_type: 'movie' | 'tv'; tmdb_id: number; at: string | null }>(db,
    'SELECT media_type, tmdb_id, COALESCE(updated_at, mirrored_at) at FROM seerr_media WHERE status IN (4, 5)');
  for (const m of seerr) add({ media_type: m.media_type, tmdb_id: m.tmdb_id, title: null, added_at: m.at, source: 'seerr' });
  sources.seerr = seerr.length;
  return { wanted, sources };
}

/** Copies the library from the Seerr mirror, then fetches recommendations for titles that need them. */
export async function refreshLibrary(db: Db, cfg: Config, tmdb: TmdbClient, src: LibrarySources = {}, now = new Date()): Promise<LibraryResult> {
  const iso = now.toISOString();
  const { wanted, sources } = await collect(db, tmdb, src);
  const failed = new Set(Object.entries(sources).filter(([, v]) => v === 'error').map(([k]) => k));
  const { added, removed } = tx(db, () => {
    const existing = all<{ media_type: string; tmdb_id: number; source: string | null }>(db, 'SELECT media_type, tmdb_id, source FROM library_items');
    let removed = 0;
    for (const e of existing) {
      const k = `${e.media_type}:${e.tmdb_id}`;
      if (wanted.has(k) || failed.has(e.source ?? 'seerr')) continue;
      run(db, 'DELETE FROM library_items WHERE media_type = ? AND tmdb_id = ?', [e.media_type, e.tmdb_id]);
      removed++;
    }
    let added = 0;
    const have = new Set(existing.map((e) => `${e.media_type}:${e.tmdb_id}`));
    for (const [k, w] of wanted) {
      if (!have.has(k)) added++;
      run(db, `INSERT INTO library_items (media_type, tmdb_id, title, added_at, source) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (media_type, tmdb_id) DO UPDATE SET
                 title = COALESCE(excluded.title, library_items.title),
                 added_at = COALESCE(excluded.added_at, library_items.added_at), source = excluded.source`,
      [w.media_type, w.tmdb_id, w.title, w.added_at, w.source]);
    }
    return { added, removed };
  });

  const stale = new Date(now.getTime() - REFRESH_DAYS * 86_400_000).toISOString();
  const queue = all<{ media_type: 'movie' | 'tv'; tmdb_id: number }>(db, `
    SELECT media_type, tmdb_id FROM library_items
    WHERE recs_at IS NULL OR recs_at < ? OR recs_status = 'error'
    ORDER BY recs_at IS NOT NULL, added_at DESC`, [stale]);

  const result: LibraryResult = { library: 0, added, removed, fetched: 0, errors: 0, sources };
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
        run(db, 'UPDATE library_items SET title = COALESCE(title, ?), recs_at = ?, recs_status = ? WHERE media_type = ? AND tmdb_id = ?',
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

/**
 * Per-title score: the sum over your titles that recommend it, rank 1 = 1.0 down
 * to rank 20 = 0.05, times 1.5 for anything released or aired in the last two years
 * (you asked for new things first).
 */
export const MATCH_SCORE = `((SELECT sum((21.0 - min(r.rank, 20)) / 20) FROM library_recs r WHERE r.rec_type = tk.tmdb_type AND r.rec_id = tk.tmdb_id)
  * CASE WHEN COALESCE(tk.last_air_date, tk.release_date) >= date('now', '-730 days') THEN 1.5 ELSE 1 END)`;

/** Recommendations skip weak titles: TMDB rating 6+ with at least 30 votes. */
export const REC_FLOOR = { minRating: 6, minVotes: 30 } as const;

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
