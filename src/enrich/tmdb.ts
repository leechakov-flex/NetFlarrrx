import { saveCompanies } from '../catalog/companies.js';
import type { Config } from '../config.js';
import { all, run, tx, type Db } from '../db/db.js';
import { HttpError, mapLimit } from '../clients/http.js';
import type { TmdbClient, TmdbDetails } from '../clients/tmdb.js';
import { setJobState } from '../db/db.js';
import { log } from '../log.js';
import { DIGITAL_ID } from '../services.js';

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
        saveDetails(db, t.id, t.tmdb_type, d, at);
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
  settleAddedDates(db);
  setJobState(db, 'enrich', { ...result, at: now.toISOString() });
  log.info('enrich: done', { ...result });
  return result;
}

/**
 * A weekly slice finds a new series up to a week after it arrived. Once TMDB
 * has its premiere date, and that date falls between the previous sync and the
 * one that found it, use the premiere as the date added. Rows TMDB knows
 * nothing about keep the sync's date. Either way the window is then cleared.
 */
export function settleAddedDates(db: Db) {
  run(db, `
    UPDATE availability SET added_at = (
      SELECT CASE
        WHEN date(COALESCE(t.release_date, '')) > date(availability.added_window_start)
         AND date(COALESCE(t.release_date, '')) < date(availability.added_at)
        THEN t.release_date || 'T12:00:00.000Z' ELSE availability.added_at END
      FROM titles t WHERE t.id = availability.title_id)
    WHERE added_window_start IS NOT NULL AND added_at IS NOT NULL
      AND title_id IN (SELECT id FROM titles WHERE tmdb_status IN ('ok', 'missing', 'no_tmdb_id'))`);
  // Rent or buy: the date added is the digital release itself.
  run(db, `UPDATE availability SET added_at = (SELECT t.digital_date || 'T12:00:00.000Z' FROM titles t WHERE t.id = availability.title_id)
           WHERE provider_id = ? AND title_id IN (SELECT id FROM titles WHERE digital_date IS NOT NULL)
             AND added_at IS NOT (SELECT t.digital_date || 'T12:00:00.000Z' FROM titles t WHERE t.id = availability.title_id)`, [DIGITAL_ID]);
  run(db, `UPDATE availability SET added_window_start = NULL
           WHERE added_window_start IS NOT NULL AND title_id IN (SELECT id FROM titles WHERE tmdb_status IN ('ok', 'missing', 'no_tmdb_id'))`);
}

function saveDetails(db: Db, titleId: number, kind: 'movie' | 'tv', d: TmdbDetails, at: string) {
  tx(db, () => {
    run(db, `UPDATE titles SET tmdb_status = 'ok', tmdb_fetched_at = ?, tmdb_error = NULL,
               tmdb_title = ?, original_language = ?, overview = ?, poster_path = ?, backdrop_path = ?, release_date = ?,
               vote_average = ?, vote_count = ?, popularity = ?, runtime = ?, seasons = ?,
               certification = ?, trailer_key = ?, trailer_name = ?, last_air_date = ?, netflix_original = ?,
               logo_path = ?, textless_poster_path = ?, credits_json = ?, watch_json = ?, recs_json = ?, digital_date = ?, digital_note = ?
             WHERE id = ?`,
    [at, d.tmdbTitle, d.originalLanguage, d.overview, d.posterPath, d.backdropPath, d.releaseDate,
      d.voteAverage, d.voteCount, d.popularity, d.runtime, d.seasons,
      d.certification, d.trailer?.key ?? null, d.trailer?.name ?? null, d.lastAirDate, d.netflixOriginal ? 1 : 0,
      d.logoPath, d.textlessPosterPath, d.credits.length ? JSON.stringify(d.credits) : null, d.watch ? JSON.stringify(d.watch) : null,
      d.recommendations.length ? JSON.stringify(d.recommendations) : null, d.digitalDate, d.digitalNote, titleId]);

    run(db, 'DELETE FROM title_genres WHERE title_id = ?', [titleId]);
    const g = db.prepare('INSERT INTO genres (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name');
    const tg = db.prepare('INSERT OR IGNORE INTO title_genres (title_id, genre_id) VALUES (?, ?)');
    for (const genre of d.genres) { g.run(genre.id, genre.name); tg.run(titleId, genre.id); }

    run(db, 'DELETE FROM title_keywords WHERE title_id = ?', [titleId]);
    const k = db.prepare('INSERT INTO keywords (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name');
    const tk = db.prepare('INSERT OR IGNORE INTO title_keywords (title_id, keyword_id) VALUES (?, ?)');
    for (const kw of d.keywords) { k.run(kw.id, kw.name); tk.run(titleId, kw.id); }

    saveCompanies(db, titleId, kind === 'tv' ? 'network' : 'studio', d.companies);
  });
}
