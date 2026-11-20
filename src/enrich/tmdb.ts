import type { Config } from '../config.js';
import { all, run, tx, type Db } from '../db/db.js';
import { HttpError, mapLimit } from '../clients/http.js';
import type { TmdbClient, TmdbDetails } from '../clients/tmdb.js';
import { setJobState } from '../db/db.js';
import { log } from '../log.js';

export interface EnrichResult { queued: number; ok: number; missing: number; errors: number; aborted?: string }

/**
 * Fetches TMDB details for titles that need them: never fetched, failed last time,
 * or older than ENRICH_STALE_DAYS. Titles currently on the service go first.
 */
export async function enrichTitles(db: Db, cfg: Config, tmdb: TmdbClient, opts: { limit?: number; now?: Date } = {}): Promise<EnrichResult> {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - cfg.ENRICH_STALE_DAYS * 86_400_000).toISOString();
  const queue = all<{ id: number; tmdb_type: 'movie' | 'tv'; tmdb_id: number }>(db, `
    SELECT t.id, t.tmdb_type, t.tmdb_id
    FROM titles t
    LEFT JOIN availability a ON a.title_id = t.id AND a.removed_at IS NULL
    WHERE t.tmdb_id IS NOT NULL AND t.tmdb_type IS NOT NULL
      AND (t.tmdb_status IN ('pending', 'error') OR (t.tmdb_status IN ('ok', 'missing') AND t.tmdb_fetched_at < ?))
    GROUP BY t.id
    ORDER BY (count(a.id) > 0) DESC, (t.tmdb_status = 'pending') DESC, t.id
    LIMIT ?`, [staleBefore, opts.limit ?? 1_000_000]);

  const result: EnrichResult = { queued: queue.length, ok: 0, missing: 0, errors: 0 };
  if (!queue.length) return result;
  log.info('enrich: starting', { queued: queue.length });

  let abort: string | undefined;
  await mapLimit(queue, cfg.TMDB_CONCURRENCY, async (t) => {
    if (abort) return;
    const at = new Date().toISOString();
    try {
      const d = await tmdb.details(t.tmdb_type, t.tmdb_id);
      if (d === null) {
        run(db, `UPDATE titles SET tmdb_status = 'missing', tmdb_fetched_at = ?, tmdb_error = NULL WHERE id = ?`, [at, t.id]);
        result.missing += 1;
      } else {
        saveDetails(db, t.id, d, at);
        result.ok += 1;
      }
    } catch (err) {
      result.errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      run(db, `UPDATE titles SET tmdb_status = 'error', tmdb_fetched_at = ?, tmdb_error = ? WHERE id = ?`, [at, msg.slice(0, 300), t.id]);
      if (err instanceof HttpError && err.isAuth) abort = `TMDB rejected the token (HTTP ${err.status}); check TMDB_READ_TOKEN`;
    }
  });

  if (abort) {
    result.aborted = abort;
    log.error('enrich: aborted', { reason: abort });
  }
  setJobState(db, 'enrich', { ...result, at: now.toISOString() });
  log.info('enrich: done', { ...result });
  return result;
}

function saveDetails(db: Db, titleId: number, d: TmdbDetails, at: string) {
  tx(db, () => {
    run(db, `UPDATE titles SET tmdb_status = 'ok', tmdb_fetched_at = ?, tmdb_error = NULL,
               tmdb_title = ?, original_language = ?, overview = ?, poster_path = ?, backdrop_path = ?, release_date = ?,
               vote_average = ?, vote_count = ?, popularity = ?, runtime = ?, seasons = ?
             WHERE id = ?`,
    [at, d.tmdbTitle, d.originalLanguage, d.overview, d.posterPath, d.backdropPath, d.releaseDate,
      d.voteAverage, d.voteCount, d.popularity, d.runtime, d.seasons, titleId]);

    run(db, 'DELETE FROM title_genres WHERE title_id = ?', [titleId]);
    const g = db.prepare('INSERT INTO genres (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name');
    const tg = db.prepare('INSERT OR IGNORE INTO title_genres (title_id, genre_id) VALUES (?, ?)');
    for (const genre of d.genres) { g.run(genre.id, genre.name); tg.run(titleId, genre.id); }

    run(db, 'DELETE FROM title_keywords WHERE title_id = ?', [titleId]);
    const k = db.prepare('INSERT INTO keywords (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name');
    const tk = db.prepare('INSERT OR IGNORE INTO title_keywords (title_id, keyword_id) VALUES (?, ?)');
    for (const kw of d.keywords) { k.run(kw.id, kw.name); tk.run(titleId, kw.id); }
  });
}
