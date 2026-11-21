import type { Config } from '../config.js';
import { all, get, run, setJobState, tx, type Db } from '../db/db.js';
import { HttpError, mapLimit } from '../clients/http.js';
import type { TmdbClient } from '../clients/tmdb.js';
import type { ArrClient } from '../clients/arr.js';
import { STANDUP } from '../catalog/themes.js';
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

interface Wanted { media_type: 'movie' | 'tv'; tmdb_id: number; title: string | null; added_at: string | null; source: 'radarr' | 'sonarr' | 'seerr'; have_season?: number | null; monitored?: number[] }

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
        if (id) add({ media_type: 'tv', tmdb_id: id, title: s.title, added_at: s.added, source: 'sonarr', have_season: s.haveSeason ?? null, monitored: s.monitoredSeasons ?? [] });
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
      const sonarr = w.source === 'sonarr';
      run(db, `INSERT INTO library_items (media_type, tmdb_id, title, added_at, source, have_season, monitored_json) VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (media_type, tmdb_id) DO UPDATE SET
                 title = COALESCE(excluded.title, library_items.title),
                 added_at = COALESCE(excluded.added_at, library_items.added_at), source = excluded.source,
                 have_season = excluded.have_season, monitored_json = excluded.monitored_json`,
      [w.media_type, w.tmdb_id, w.title, w.added_at, w.source, sonarr ? w.have_season ?? null : null, sonarr ? JSON.stringify(w.monitored ?? []) : null]);
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
        run(db, 'UPDATE library_items SET title = COALESCE(title, ?), recs_at = ?, recs_status = ?, category = ? WHERE media_type = ? AND tmdb_id = ?',
          [r?.title ?? null, iso, r ? 'ok' : 'missing', r ? refineByRecs(db, item.media_type, item.tmdb_id, r, categorize(item.media_type, { ...r, special: isWatchmodeSpecial(db, item.media_type, item.tmdb_id) })) : null, item.media_type, item.tmdb_id]);
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

/** ...and older ones: released or aired in the last 10 years, unless rated 7.5 or higher. */
export const REC_RECENT = `(min(COALESCE(tk.last_air_date, tk.release_date, '0000'), date('now')) >= date('now', '-3650 days') OR tk.vote_average >= 7.5)`;

const isWatchmodeSpecial = (db: Db, type: string, id: number) =>
  !!get<{ n: number }>(db, `SELECT 1 n FROM titles WHERE tmdb_type = ? AND tmdb_id = ? AND watchmode_type = 'tv_special' LIMIT 1`, [type, id]);

/**
 * TMDB recommends specials alongside specials. Among a movie's recommendations
 * that are on Netflix, 50%+ specials makes it a stand-up special, under 30%
 * makes a title-pattern guess a regular movie. Keyword matches are kept as they are.
 */
function refineByRecs(db: Db, type: 'movie' | 'tv', id: number, r: { keywords: string[] }, guess: 'standup' | 'movie' | 'series') {
  if (type !== 'movie') return guess;
  const kws = new Set(r.keywords.map((k) => k.toLowerCase()));
  if (STANDUP.some((k) => kws.has(k))) return guess;
  const m = get<{ n: number; specials: number }>(db, `
    SELECT count(*) n, coalesce(sum(t.watchmode_type = 'tv_special'), 0) specials
    FROM library_recs lr JOIN titles t ON t.tmdb_type = lr.rec_type AND t.tmdb_id = lr.rec_id
    WHERE lr.seed_type = 'movie' AND lr.seed_id = ?`, [id])!;
  if (m.n < 4) return guess;
  const share = m.specials / m.n;
  if (share >= 0.5) return 'standup';
  if (guess === 'standup' && share < 0.3) return 'movie';
  return guess;
}

/** Stand-up specials, other movies and series, so "Because you have" rows can be mixed. */
function categorize(type: 'movie' | 'tv', r: { title: string | null; genres: string[]; keywords: string[]; runtime: number | null; special?: boolean }): 'standup' | 'movie' | 'series' {
  if (type === 'tv') return 'series';
  if (r.special && r.genres.includes('Comedy')) return 'standup';
  const kws = new Set(r.keywords.map((k) => k.toLowerCase()));
  if (STANDUP.some((k) => kws.has(k))) return 'standup';
  if (/stand[- ]?up/i.test(r.title ?? '')) return 'standup';
  // Specials TMDB hasn't keyworded: a comedy up to 100 minutes named "Comedian: Title".
  if (r.genres.includes('Comedy') && (r.runtime ?? 999) <= 100 && /^[^:]{3,40}: /.test(r.title ?? '')) return 'standup';
  return 'movie';
}

/** Recommended and not already yours (in the library, requested or on its way). Expects tk and sm. */
/** Not in your library or Jellyfin, not in Radarr or Sonarr (even without files), not requested in Seerr. */
export const NOT_MINE = `NOT EXISTS (SELECT 1 FROM library_items li WHERE li.media_type = tk.tmdb_type AND li.tmdb_id = tk.tmdb_id)
  AND NOT EXISTS (SELECT 1 FROM arr_titles at WHERE at.media_type = tk.tmdb_type AND at.tmdb_id = tk.tmdb_id)
  AND NOT EXISTS (SELECT 1 FROM jellyfin_items ji WHERE ji.media_type = tk.tmdb_type AND ji.tmdb_id = tk.tmdb_id)
  AND (sm.status IS NULL OR sm.status NOT IN (2, 3, 4, 5))`;
export const RECOMMENDED = `EXISTS (SELECT 1 FROM library_recs r WHERE r.rec_type = tk.tmdb_type AND r.rec_id = tk.tmdb_id) AND ${NOT_MINE}`;

export const libraryCount = (db: Db) => get<{ n: number }>(db, 'SELECT count(*) n FROM library_items')!.n;

/**
 * Library titles to build "Because you have X" rows from: among your most
 * recently added titles, the ones whose recommendations include the most
 * Netflix titles you don't have. Takes the shown-title filter as SQL.
 */
/** For the CLI: every library title with its category and Netflix matches, best first. */
export function libraryReport(db: Db, eligible: { sql: string; params: (string | number)[] }, from: string) {
  return all<{ title: string; category: string | null; source: string | null; matches: number; specials_pct: number | null }>(db, `
    SELECT s.title, s.category, s.source, (
      SELECT CAST(round(100.0 * avg(t.watchmode_type = 'tv_special')) AS INTEGER)
      FROM library_recs lr JOIN titles t ON t.tmdb_type = lr.rec_type AND t.tmdb_id = lr.rec_id
      WHERE lr.seed_type = s.media_type AND lr.seed_id = s.tmdb_id
    ) specials_pct, (
      SELECT count(DISTINCT tk.id) ${from}
      JOIN library_recs r ON r.rec_type = tk.tmdb_type AND r.rec_id = tk.tmdb_id
      WHERE r.seed_type = s.media_type AND r.seed_id = s.tmdb_id AND ${eligible.sql} AND ${NOT_MINE}
    ) matches
    FROM library_items s WHERE s.title IS NOT NULL ORDER BY matches DESC, s.title`, eligible.params);
}

export function becauseSeeds(db: Db, eligible: { sql: string; params: (string | number)[] }, from: string, count: number, minMatches = 5) {
  const candidates = all<{ media_type: 'movie' | 'tv'; tmdb_id: number; title: string; category: string | null; matches: number }>(db, `
    WITH recent AS (
      SELECT media_type, tmdb_id, title, category FROM library_items WHERE recs_status = 'ok' AND title IS NOT NULL
      ORDER BY added_at DESC LIMIT 400
    )
    SELECT s.media_type, s.tmdb_id, s.title, s.category, (
      SELECT count(DISTINCT tk.id) ${from}
      JOIN library_recs r ON r.rec_type = tk.tmdb_type AND r.rec_id = tk.tmdb_id
      WHERE r.seed_type = s.media_type AND r.seed_id = s.tmdb_id AND ${eligible.sql} AND ${NOT_MINE}
    ) matches
    FROM recent s
    ORDER BY matches DESC, s.title`, eligible.params).filter((s) => s.matches >= minMatches);

  // Mix: the best seed of each kind first (at most one stand-up special), then the
  // next best non-stand-up seeds. Rows then go in order of how much they match.
  const kind = (s: (typeof candidates)[number]) => s.category ?? (s.media_type === 'tv' ? 'series' : 'movie');
  const picked: typeof candidates = [];
  for (const k of ['standup', 'series', 'movie']) {
    const best = candidates.find((s) => kind(s) === k);
    if (best) picked.push(best);
  }
  for (const s of candidates) {
    if (picked.length >= count) break;
    if (!picked.includes(s) && kind(s) !== 'standup') picked.push(s);
  }
  return picked.sort((a, b) => b.matches - a.matches).slice(0, count);
}
