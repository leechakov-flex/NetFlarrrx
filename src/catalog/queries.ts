import type { Config } from '../config.js';
import { all, get, type Db } from '../db/db.js';
import { eligibleWhere } from './rules.js';
import { loadThemes, themeWhere, type ThemeRule } from './themes.js';
import { becauseSeeds, libraryCount, MATCH_SCORE, NOT_MINE, RECOMMENDED } from '../recs/library.js';
import type {
  BrowseQuery, BrowseResponse, Genre, HomeResponse, HomeRow, Kind, MetaResponse, SeerrState, ThemeSummary, TitleCard, TitleDetail, TopResponse,
} from '../api/types.js';

export const PAGE_SIZE = 40;
export const ROW_LIMIT = 20;
export const TOP_MIN_VOTES = 200;
const DAY = 86_400_000;

const CARD_COLUMNS = `
  tk.id, tk.kind, COALESCE(tk.tmdb_title, tk.title) AS title, tk.year, tk.poster_path,
  a.added_at, a.back_on_service, tk.vote_average, tk.vote_count, sm.status AS seerr_status`;

const FROM = `
  FROM availability a
  JOIN title_kinds tk ON tk.id = a.title_id
  LEFT JOIN seerr_media sm ON sm.media_type = tk.tmdb_type AND sm.tmdb_id = tk.tmdb_id`;

interface CardRow {
  id: number; kind: Kind; title: string; year: number | null; poster_path: string | null; added_at: string | null;
  back_on_service: number; vote_average: number | null; vote_count: number | null; seerr_status: number | null;
}

export function seerrState(status: number | null | undefined): SeerrState {
  switch (status) {
    case 5: return 'available';
    case 4: return 'partial';
    case 2: return 'requested';
    case 3: return 'processing';
    default: return null;      // 1 unknown, 6 blocklisted, 7 deleted, or not in Seerr
  }
}

const toCard = (r: CardRow): TitleCard => ({
  id: r.id, kind: r.kind, title: r.title, year: r.year, posterPath: r.poster_path, addedAt: r.added_at,
  backOnNetflix: r.back_on_service === 1, voteAverage: r.vote_average, voteCount: r.vote_count, seerr: seerrState(r.seerr_status),
});

// Themes are read once per config (i.e. per process); edit themes.json and restart.
const themeCache = new WeakMap<Config, ThemeRule[]>();
export function themesFor(cfg: Config): ThemeRule[] {
  let t = themeCache.get(cfg);
  if (!t) { t = loadThemes(cfg); themeCache.set(cfg, t); }
  return t;
}
/** A browseable theme. "Because you have" rows aren't: they're reached by `because`. */
export const findTheme = (cfg: Config, slug: string | undefined) =>
  (slug ? themesFor(cfg).find((t) => t.slug === slug && t.special !== 'because') : undefined);

const seedParts = (because: string) => { const [type, id] = because.split(':'); return { type: type as 'movie' | 'tv', id: Number(id) }; };

/** Builds WHERE clauses for browse-style filters on top of the eligibility rule. */
function filters(cfg: Config, q: BrowseQuery, now: Date) {
  const base = eligibleWhere(cfg);
  const where = [base.sql];
  const params: (string | number)[] = [...base.params];
  if (q.kind) { where.push('tk.kind = ?'); params.push(q.kind); }
  const theme = findTheme(cfg, q.theme);
  if (theme) {
    const t = themeWhere(theme, now); where.push(t.sql); params.push(...t.params);
    if (theme.special === 'for-you') where.push(RECOMMENDED);
  }
  if (q.because) {
    const seed = seedParts(q.because);
    where.push(`EXISTS (SELECT 1 FROM library_recs rb WHERE rb.seed_type = ? AND rb.seed_id = ? AND rb.rec_type = tk.tmdb_type AND rb.rec_id = tk.tmdb_id) AND ${NOT_MINE}`);
    params.push(seed.type, seed.id);
  }
  if (q.added) { where.push('a.added_at >= ?'); params.push(new Date(now.getTime() - q.added * DAY).toISOString()); }
  if (q.minRating) { where.push('tk.vote_average >= ?'); params.push(q.minRating); }
  if (q.maxRating !== undefined && q.maxRating < 10) { where.push('tk.vote_average <= ?'); params.push(q.maxRating); }
  if (q.minVotes) { where.push('tk.vote_count >= ?'); params.push(q.minVotes); }
  if (q.hideHave) where.push('(sm.status IS NULL OR sm.status NOT IN (2, 3, 4, 5))');
  if (q.genres?.length) {
    where.push(`EXISTS (SELECT 1 FROM title_genres tg WHERE tg.title_id = tk.id AND tg.genre_id IN (${q.genres.map(() => '?').join(',')}))`);
    params.push(...q.genres);
  }
  if (q.q?.trim()) {
    where.push(`(COALESCE(tk.tmdb_title, tk.title) LIKE ? ESCAPE '\\' OR tk.title LIKE ? ESCAPE '\\')`);
    const like = `%${q.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  return { sql: where.join(' AND '), params };
}

const ORDER: Record<NonNullable<BrowseQuery['sort']>, string> = {
  // Dated arrivals first. Titles already on Netflix when tracking began have no
  // date, so they follow by their latest release or episode (a fair proxy for
  // "recently added"), then popularity. Future dates (pre-announced) count as today.
  added: `a.added_at IS NULL, a.added_at DESC, min(COALESCE(tk.last_air_date, tk.release_date, '0000'), date('now')) DESC, tk.popularity DESC`,
  rating: 'tk.vote_average DESC, tk.vote_count DESC',
  popularity: 'tk.popularity DESC',
  release: `tk.release_date IS NULL, min(tk.release_date, date('now')) DESC, tk.popularity DESC`,
  title: 'COALESCE(tk.tmdb_title, tk.title) COLLATE NOCASE ASC',
  match: `COALESCE(${MATCH_SCORE}, 0) DESC, tk.popularity DESC`,
};

/** For "Because you have X": TMDB's own ranking for that title. */
const becauseOrder = (because: string) => {
  const seed = seedParts(because);
  return { sql: `(SELECT min(rank) FROM library_recs ro WHERE ro.seed_type = ? AND ro.seed_id = ? AND ro.rec_type = tk.tmdb_type AND ro.rec_id = tk.tmdb_id), tk.popularity DESC`, params: [seed.type, seed.id] as (string | number)[] };
};
function orderBy(q: BrowseQuery) {
  if (q.because && (!q.sort || q.sort === 'match')) return becauseOrder(q.because);
  return { sql: ORDER[q.sort ?? 'added'], params: [] as (string | number)[] };
}
const seedTitle = (db: Db, because: string) => {
  const seed = seedParts(because);
  return get<{ title: string | null }>(db, 'SELECT title FROM library_items WHERE media_type = ? AND tmdb_id = ?', [seed.type, seed.id])?.title ?? null;
};

export function browse(db: Db, cfg: Config, q: BrowseQuery, now = new Date()): BrowseResponse {
  const theme = findTheme(cfg, q.theme);
  if (theme && !q.sort) q = { ...q, sort: theme.sort };
  const f = filters(cfg, q, now);
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const total = get<{ n: number }>(db, `SELECT count(*) n ${FROM} WHERE ${f.sql}`, f.params)!.n;
  const o = orderBy(q);
  const rows = all<CardRow>(db,
    `SELECT ${CARD_COLUMNS} ${FROM} WHERE ${f.sql} ORDER BY ${o.sql}, tk.id LIMIT ? OFFSET ?`,
    [...f.params, ...o.params, PAGE_SIZE, (page - 1) * PAGE_SIZE]);
  const meta = theme ? { slug: theme.slug, title: theme.title, sort: theme.sort }
    : q.because ? { slug: 'because', title: `Because you have ${seedTitle(db, q.because) ?? 'this'}`, sort: 'match' as const } : null;
  return { total, page, pageSize: PAGE_SIZE, items: rows.map(toCard), ...(meta ? { theme: meta } : {}) };
}

function row(db: Db, cfg: Config, now: Date, slug: string, title: string, q: BrowseQuery, link: string | null, extraWhere = '', extraParams: (string | number)[] = []): HomeRow {
  const f = filters(cfg, q, now);
  const where = extraWhere ? `${f.sql} AND ${extraWhere}` : f.sql;
  const params = [...f.params, ...extraParams];
  const total = get<{ n: number }>(db, `SELECT count(*) n ${FROM} WHERE ${where}`, params)!.n;
  const o = orderBy(q);
  const items = all<CardRow>(db, `SELECT ${CARD_COLUMNS} ${FROM} WHERE ${where} ORDER BY ${o.sql}, tk.id LIMIT ?`, [...params, ...o.params, ROW_LIMIT]).map(toCard);
  return { slug, title, total, link, items };
}

export function trackingSince(db: Db, cfg: Config): string | null {
  return get<{ t: string }>(db, `SELECT min(started_at) t FROM sync_runs WHERE provider_id = ? AND region = ? AND applied = 1`,
    [cfg.NETFLIX_SOURCE_ID, cfg.REGION])?.t ?? null;
}

export function home(db: Db, cfg: Config, now = new Date()): HomeResponse {
  const since = trackingSince(db, cfg);
  const onHome = themesFor(cfg).filter((t) => t.home);
  const hasLibrary = libraryCount(db) > 0;
  const seeds = hasLibrary ? becauseSeeds(db, filters(cfg, {}, now), FROM, onHome.filter((t) => t.special === 'because').length) : [];
  let nextSeed = 0;
  const rows: HomeRow[] = [];
  for (const t of onHome) {
    if (t.special === 'because') {
      const seed = seeds[nextSeed++];
      if (!seed) continue;
      const because = `${seed.media_type}:${seed.tmdb_id}`;
      rows.push(row(db, cfg, now, `because-${seed.media_type}-${seed.tmdb_id}`, `Because you have ${seed.title}`, { because }, `/browse?because=${because}`));
    } else if (t.special === 'for-you' && !hasLibrary) {
      continue;
    } else {
      rows.push(row(db, cfg, now, t.slug, t.title, { theme: t.slug, sort: t.sort }, `/browse?theme=${t.slug}`));
    }
  }
  return {
    trackingSince: since,
    showTrackingNotice: !since || now.getTime() - Date.parse(since) < 7 * DAY,
    // Empty "new" rows are dropped; the notice explains them during the first week.
    rows: rows.filter((r) => r.items.length > 0),
  };
}

export function top(db: Db, cfg: Config, kind: Kind, limit = 50, minVotes = TOP_MIN_VOTES): TopResponse {
  const f = filters(cfg, { kind, minVotes }, new Date());
  const rows = all<CardRow & { runtime: number | null }>(db,
    `SELECT ${CARD_COLUMNS}, tk.runtime ${FROM} WHERE ${f.sql} AND tk.vote_average IS NOT NULL
     ORDER BY tk.vote_average DESC, tk.vote_count DESC, tk.id LIMIT ?`, [...f.params, limit]);
  return { kind, minVotes, items: rows.map((r, i) => ({ ...toCard(r), rank: i + 1, runtime: r.runtime })) };
}

export function genres(db: Db, cfg: Config, kind?: Kind): Genre[] {
  const f = filters(cfg, { kind }, new Date());
  return all<Genre>(db, `
    SELECT g.id, g.name, count(DISTINCT tk.id) AS count
    ${FROM}
    JOIN title_genres tg ON tg.title_id = tk.id
    JOIN genres g ON g.id = tg.genre_id
    WHERE ${f.sql}
    GROUP BY g.id ORDER BY g.name`, f.params);
}

export function titleDetail(db: Db, cfg: Config, id: number): TitleDetail | null {
  const r = get<CardRow & {
    overview: string | null; backdrop_path: string | null; release_date: string | null; runtime: number | null; seasons: number | null;
    certification: string | null; original_language: string | null; trailer_key: string | null; trailer_name: string | null;
    removed_at: string | null; first_seen_at: string | null; tmdb_id: number | null; tmdb_type: 'movie' | 'tv' | null; seasons_json: string | null;
  }>(db, `
    SELECT ${CARD_COLUMNS}, tk.overview, tk.backdrop_path, tk.release_date, tk.runtime, tk.seasons, tk.certification,
           tk.original_language, tk.trailer_key, tk.trailer_name, a.removed_at, a.first_seen_at, tk.tmdb_id, tk.tmdb_type, sm.seasons_json
    ${FROM}
    WHERE tk.id = ? AND a.provider_id = ? AND a.region = ?`, [id, cfg.NETFLIX_SOURCE_ID, cfg.REGION]);
  if (!r || r.kind === null) return null;
  const g = all<{ id: number; name: string }>(db,
    'SELECT g.id, g.name FROM title_genres tg JOIN genres g ON g.id = tg.genre_id WHERE tg.title_id = ? ORDER BY g.name', [id]);
  return {
    ...toCard(r),
    overview: r.overview, backdropPath: r.backdrop_path, releaseDate: r.release_date, runtime: r.runtime, seasons: r.seasons,
    certification: r.certification, originalLanguage: r.original_language, genres: g,
    trailer: r.trailer_key ? { key: r.trailer_key, name: r.trailer_name } : null,
    onNetflix: r.removed_at === null, firstSeenAt: r.first_seen_at, tmdbId: r.tmdb_id, tmdbType: r.tmdb_type,
    seerrSeasons: r.seasons_json ? JSON.parse(r.seasons_json) : [],
  };
}

export function meta(db: Db, cfg: Config, health: string, now = new Date()): MetaResponse {
  const passcodeRequired = Boolean(cfg.APP_PASSCODE);
  const lastSync = get<{ t: string }>(db, `SELECT max(started_at) t FROM sync_runs WHERE provider_id = ? AND region = ? AND applied = 1`,
    [cfg.NETFLIX_SOURCE_ID, cfg.REGION])?.t ?? null;
  const f = filters(cfg, {}, now);
  const eligible = get<{ n: number }>(db, `SELECT count(*) n ${FROM} WHERE ${f.sql}`, f.params)!.n;
  const w = filters(cfg, { added: 7 }, now);
  const newThisWeek = get<{ n: number }>(db, `SELECT count(*) n ${FROM} WHERE ${w.sql}`, w.params)!.n;
  return { trackingSince: trackingSince(db, cfg), lastSyncAt: lastSync, health, eligible, newThisWeek, languageRule: cfg.LANGUAGE_RULE, passcodeRequired };
}

export function themes(db: Db, cfg: Config, now = new Date()): ThemeSummary[] {
  return themesFor(cfg).filter((t) => t.special !== 'because').map((t) => {
    const f = filters(cfg, { theme: t.slug }, now);
    const count = get<{ n: number }>(db, `SELECT count(*) n ${FROM} WHERE ${f.sql}`, f.params)!.n;
    return { slug: t.slug, title: t.title, kind: t.kind ?? null, sort: t.sort, home: t.home, count };
  });
}

/** For tuning (CLI): totals, how many each signal catches, and sample titles. */
export function themePreview(db: Db, cfg: Config, rule: ThemeRule, sample = 12, now = new Date()) {
  const base = filters(cfg, {}, now);
  const t = themeWhere(rule, now);
  const where = `${base.sql} AND ${t.sql}`;
  const params = [...base.params, ...t.params];
  const counts = get<{ n: number; movies: number; series: number; dated: number }>(db,
    `SELECT count(*) n, coalesce(sum(tk.kind = 'movie'), 0) movies, coalesce(sum(tk.kind = 'series'), 0) series, coalesce(sum(a.added_at IS NOT NULL), 0) dated ${FROM} WHERE ${where}`, params)!;
  // Which signals do the work: count per keyword / genre / type, within the theme.
  const bySignal: { signal: string; titles: number }[] = [];
  for (const kw of rule.signals?.keywords ?? []) {
    bySignal.push({ signal: `keyword: ${kw}`, titles: get<{ n: number }>(db, `SELECT count(*) n ${FROM} WHERE ${where} AND EXISTS (
      SELECT 1 FROM title_keywords x JOIN keywords k ON k.id = x.keyword_id WHERE x.title_id = tk.id AND lower(k.name) = ?)`, [...params, kw.toLowerCase()])!.n });
  }
  for (const g of rule.signals?.genres ?? []) {
    bySignal.push({ signal: `genre: ${g}`, titles: get<{ n: number }>(db, `SELECT count(*) n ${FROM} WHERE ${where} AND EXISTS (
      SELECT 1 FROM title_genres x JOIN genres gg ON gg.id = x.genre_id WHERE x.title_id = tk.id AND lower(gg.name) = ?)`, [...params, g.toLowerCase()])!.n });
  }
  for (const ty of rule.signals?.types ?? []) {
    bySignal.push({ signal: `type: ${ty}`, titles: get<{ n: number }>(db, `SELECT count(*) n ${FROM} WHERE ${where} AND tk.watchmode_type = ?`, [...params, ty])!.n });
  }
  const items = all<{ title: string; year: number | null; kind: string; vote_average: number | null; vote_count: number | null; runtime: number | null; seasons: number | null }>(db,
    `SELECT COALESCE(tk.tmdb_title, tk.title) title, tk.year, tk.kind, tk.vote_average, tk.vote_count, tk.runtime, tk.seasons ${FROM}
     WHERE ${where} ORDER BY ${ORDER[rule.sort]}, tk.id LIMIT ?`, [...params, sample]);
  return { ...counts, bySignal, items };
}

/** For tuning (CLI): keyword names containing some text, with how many shown titles carry each. */
export function keywordSearch(db: Db, cfg: Config, text: string, limit = 40, now = new Date()) {
  const base = filters(cfg, {}, now);
  return all<{ name: string; titles: number }>(db, `
    SELECT k.name, count(DISTINCT tk.id) titles ${FROM}
    JOIN title_keywords x ON x.title_id = tk.id JOIN keywords k ON k.id = x.keyword_id
    WHERE ${base.sql} AND lower(k.name) LIKE ?
    GROUP BY k.id ORDER BY titles DESC, k.name LIMIT ?`, [...base.params, `%${text.toLowerCase()}%`, limit]);
}
