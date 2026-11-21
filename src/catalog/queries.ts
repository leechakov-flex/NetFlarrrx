import type { Config } from '../config.js';
import { all, get, type Db } from '../db/db.js';
import { eligibleWhere, providerKeys, scopeFrom, soonService, type Scope } from './rules.js';
import { enabledServices, serviceByKey } from '../services.js';
import { NEW_SEASON_CANDIDATES, newSeason, newSeasonSince } from './newSeasons.js';
import { companyCounts, companyWhere } from './companies.js';
import type { PersonCreditItem, TmdbPerson } from '../clients/tmdb.js';
import { HOME_REPEAT_DEFAULT, MIN_THINNED_ROW, loadThemes, themeWhere, type ThemeRule } from './themes.js';
import { becauseSeeds, libraryReport, libraryCount, MATCH_SCORE, NOT_MINE, RECOMMENDED, REC_FLOOR, REC_RECENT } from '../recs/library.js';
import type {
  BrowseQuery, BrowseResponse, Genre, HomeResponse, HomeRow, Kind, MetaResponse, SeerrState, ServiceKey, ThemeSummary, TitleCard, TitleDetail, TopResponse, PersonResponse,
} from '../api/types.js';

export const PAGE_SIZE = 40;
export const ROW_LIMIT = 20;
export const TOP_MIN_VOTES = 200;
const DAY = 86_400_000;

const CARD_COLUMNS = `
  tk.id, tk.kind, COALESCE(tk.tmdb_title, tk.title) AS title, tk.year, tk.poster_path,
  a.added_at, a.back_on_service, tk.vote_average, tk.vote_count, sm.status AS seerr_status,
  a.providers, a.soon_date, a.soon_service, tk.digital_note, tk.netflix_original, tk.logo_path, tk.textless_poster_path`;

/**
 * While Discover is built, each scope's `a` table is computed once into a temp
 * table instead of in every one of its ~70 queries.
 */
let materialized: { db: Db; tables: Map<string, string> } | null = null;
function withScopes<T>(db: Db, fn: () => T): T {
  if (materialized) return fn();
  materialized = { db, tables: new Map() };
  try { return fn(); } finally {
    for (const t of materialized.tables.values()) db.exec(`DROP TABLE IF EXISTS temp.${t}`);
    materialized = null;
  }
}

/** FROM clause over the scope's availability (`a`), titles (`tk`) and Seerr (`sm`). */
function fromFor(cfg: Config, scope: Scope, now: Date) {
  let s = scopeFrom(cfg, scope, now);
  if (materialized) {
    const key = JSON.stringify([scope.services ?? null, scope.how ?? null, !!scope.servicesOnly]);
    let name = materialized.tables.get(key);
    if (!name) {
      name = `scope_${materialized.tables.size + 1}`;
      materialized.db.prepare(`CREATE TEMP TABLE ${name} AS SELECT * FROM ${s.sql}`).run(...s.params);
      materialized.db.exec(`CREATE INDEX temp.${name}_id ON ${name} (title_id)`);
      materialized.tables.set(key, name);
    }
    s = { sql: `temp.${name} a`, params: [] };
  }
  return {
    sql: `FROM ${s.sql}
  JOIN title_kinds tk ON tk.id = a.title_id
  LEFT JOIN seerr_media sm ON sm.media_type = tk.tmdb_type AND sm.tmdb_id = tk.tmdb_id`,
    params: s.params,
  };
}

interface CardRow {
  id: number; kind: Kind; title: string; year: number | null; poster_path: string | null; added_at: string | null;
  back_on_service: number; vote_average: number | null; vote_count: number | null; seerr_status: number | null;
  providers: string | null; soon_date: string | null; soon_service: string | null; digital_note: string | null; netflix_original: number;
  logo_path: string | null; textless_poster_path: string | null;
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

const cardFor = (cfg: Config) => (r: CardRow): TitleCard => {
  const p = providerKeys(r.providers);
  const available = p.services.length > 0 || p.digital;
  return {
    id: r.id, kind: r.kind, title: r.title, year: r.year, posterPath: r.poster_path, addedAt: r.added_at,
    backOnNetflix: r.back_on_service === 1, voteAverage: r.vote_average, voteCount: r.vote_count, seerr: seerrState(r.seerr_status),
    services: p.services, digital: p.digital,
    soon: !available && r.soon_date ? { date: r.soon_date, service: soonService(cfg, r.soon_service, r.digital_note, r.netflix_original) } : null,
    logoPath: r.logo_path, textlessPosterPath: r.textless_poster_path,
  };
};

/** A row gets Apple-TV-style art when nearly all its cards have a textless poster and a logo. */
export const LOGO_ROW_SHARE = 0.8;
export const rowArt = (items: TitleCard[]): HomeRow['art'] =>
  items.length && items.filter((i) => i.logoPath && i.textlessPosterPath).length / items.length >= LOGO_ROW_SHARE ? 'logo' : 'poster';

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

/** Builds the FROM and WHERE for browse-style filters on top of the eligibility rule. `params` covers both, in order. */
function filters(cfg: Config, q: BrowseQuery, now: Date) {
  const theme = findTheme(cfg, q.theme);
  // Service chips (q.services) without an explicit "how" mean just those services: no rent or buy.
  const from = fromFor(cfg, { services: q.services?.length ? q.services : theme?.services, how: q.how?.length ? q.how : theme?.how, servicesOnly: !!q.services?.length && !q.how?.length }, now);
  const base = eligibleWhere(cfg);
  const where = [base.sql];
  const params: (string | number)[] = [...from.params, ...base.params];
  if (q.kind) { where.push('tk.kind = ?'); params.push(q.kind); }
  if (theme) {
    const t = themeWhere(theme, now); where.push(t.sql); params.push(...t.params);
    if (theme.special === 'for-you') {
      where.push(RECOMMENDED, 'tk.vote_average >= ?', 'tk.vote_count >= ?', REC_RECENT);
      params.push(REC_FLOOR.minRating, REC_FLOOR.minVotes);
    }
  }
  if (q.because) {
    const seed = seedParts(q.because);
    where.push(`EXISTS (SELECT 1 FROM library_recs rb WHERE rb.seed_type = ? AND rb.seed_id = ? AND rb.rec_type = tk.tmdb_type AND rb.rec_id = tk.tmdb_id) AND ${NOT_MINE}`,
      'tk.vote_average >= ?', 'tk.vote_count >= ?', REC_RECENT);
    params.push(seed.type, seed.id, REC_FLOOR.minRating, REC_FLOOR.minVotes);
  }
  if (q.added) { where.push('a.added_at >= ?'); params.push(new Date(now.getTime() - q.added * DAY).toISOString()); }
  if (q.minRating) { where.push('tk.vote_average >= ?'); params.push(q.minRating); }
  if (q.maxRating !== undefined && q.maxRating < 10) { where.push('tk.vote_average <= ?'); params.push(q.maxRating); }
  if (q.minVotes) { where.push('tk.vote_count >= ?'); params.push(q.minVotes); }
  if (q.hideHave) where.push(NOT_MINE);
  const co = companyWhere(q.studios, q.networks);
  if (co) { where.push(co.sql); params.push(...co.params); }
  if (q.genres?.length) {
    where.push(`EXISTS (SELECT 1 FROM title_genres tg WHERE tg.title_id = tk.id AND tg.genre_id IN (${q.genres.map(() => '?').join(',')}))`);
    params.push(...q.genres);
  }
  if (q.q?.trim()) {
    where.push(`(COALESCE(tk.tmdb_title, tk.title) LIKE ? ESCAPE '\\' OR tk.title LIKE ? ESCAPE '\\')`);
    const like = `%${q.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  return { from: from.sql, sql: where.join(' AND '), params };
}

const ORDER: Record<NonNullable<BrowseQuery['sort']>, string> = {
  // Dated arrivals first. Titles already on Netflix when tracking began have no
  // date, so they follow by their latest release or episode (a fair proxy for
  // "recently added"), then popularity. Future dates (pre-announced) count as today.
  // By day, not the exact time: each service syncs at its own minute, and the one that ran
  // last would otherwise lead every row. Within a day, the most popular first.
  added: `a.added_at IS NULL, date(a.added_at) DESC, CASE WHEN a.added_at IS NULL THEN 0 ELSE tk.popularity END DESC, min(COALESCE(tk.last_air_date, tk.release_date, '0000'), date('now')) DESC, tk.popularity DESC`,
  rating: 'tk.vote_average DESC, tk.vote_count DESC',
  popularity: 'tk.popularity DESC',
  release: `tk.release_date IS NULL, min(tk.release_date, date('now')) DESC, tk.popularity DESC`,
  title: 'COALESCE(tk.tmdb_title, tk.title) COLLATE NOCASE ASC',
  match: `COALESCE(${MATCH_SCORE}, 0) DESC, tk.popularity DESC`,
  soon: `a.soon_date IS NULL, a.soon_date ASC, tk.popularity DESC`,
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
  const total = get<{ n: number }>(db, `SELECT count(*) n ${f.from} WHERE ${f.sql}`, f.params)!.n;
  const o = orderBy(q);
  const rows = all<CardRow>(db,
    `SELECT ${CARD_COLUMNS} ${f.from} WHERE ${f.sql} ORDER BY ${o.sql}, tk.id LIMIT ? OFFSET ?`,
    [...f.params, ...o.params, PAGE_SIZE, (page - 1) * PAGE_SIZE]);
  const meta = theme ? { slug: theme.slug, title: theme.title, sort: theme.sort }
    : q.because ? { slug: 'because', title: `Because you have ${seedTitle(db, q.because) ?? 'this'}`, sort: 'match' as const } : null;
  return { total, page, pageSize: PAGE_SIZE, items: rows.map(cardFor(cfg)), ...(meta ? { theme: meta } : {}) };
}

/**
 * One Discover row. `skip` lists titles other rows have already used up: they're
 * left out and the row fills from further down its own ranking. `total` still
 * counts the whole theme (it's what "see all" opens). `thinned` is how many
 * titles the row has left to show once `skip` is applied, or null if nothing was skipped.
 */
function row(db: Db, cfg: Config, now: Date, slug: string, title: string, q: BrowseQuery, link: string | null, skip: number[] = []): { row: HomeRow; left: number | null } {
  const f = filters(cfg, q, now);
  const total = get<{ n: number }>(db, `SELECT count(*) n ${f.from} WHERE ${f.sql}`, f.params)!.n;
  let where = f.sql;
  let params = f.params;
  let left: number | null = null;
  if (skip.length) {
    where = `${f.sql} AND tk.id NOT IN (${skip.map(() => '?').join(',')})`;
    params = [...f.params, ...skip];
    left = get<{ n: number }>(db, `SELECT count(*) n ${f.from} WHERE ${where}`, params)!.n;
  }
  const o = orderBy(q);
  const items = all<CardRow>(db, `SELECT ${CARD_COLUMNS} ${f.from} WHERE ${where} ORDER BY ${o.sql}, tk.id LIMIT ?`, [...params, ...o.params, ROW_LIMIT]).map(cardFor(cfg));
  return { row: { slug, title, total, link, items, art: rowArt(items) }, left: left !== null && left < total ? left : null };
}

export interface CompanyPick { studios?: string[]; networks?: string[] }
const linkSuffix = (only: ServiceKey[], co: CompanyPick = {}) => `${only.length ? `&services=${only.join(',')}` : ''}${co.studios?.length ? `&studios=${co.studios.join(',')}` : ''}${co.networks?.length ? `&networks=${co.networks.join(',')}` : ''}`;

export function trackingSince(db: Db, cfg: Config): string | null {
  return get<{ t: string }>(db, `SELECT min(started_at) t FROM sync_runs WHERE provider_id = ? AND region = ? AND applied = 1`,
    [cfg.NETFLIX_SOURCE_ID, cfg.REGION])?.t ?? null;
}

/** Discover. `only` (the service chips) narrows every row to those services; rows for other services drop out. */
export function home(db: Db, cfg: Config, now = new Date(), only: ServiceKey[] = [], co: CompanyPick = {}): HomeResponse {
  return withScopes(db, () => buildHome(db, cfg, now, only, co));
}

function buildHome(db: Db, cfg: Config, now: Date, only: ServiceKey[], co: CompanyPick): HomeResponse {
  const since = trackingSince(db, cfg);
  const onHome = themesFor(cfg).filter((t) => t.home && (!only.length || !t.services || t.services.some((x) => only.includes(x))));
  const narrow = { ...(only.length ? { services: only } : {}), ...co };
  const hasLibrary = libraryCount(db) > 0;
  const seedFilter = filters(cfg, { ...REC_FLOOR }, now);
  const seeds = hasLibrary ? becauseSeeds(db, { sql: `${seedFilter.sql} AND ${REC_RECENT}`, params: seedFilter.params }, seedFilter.from, onHome.filter((t) => t.special === 'because').length) : [];
  // Each title counts how many rows it has been shown in. A row skips titles already
  // shown as many times as its theme allows (`repeat`, default 1), so the page doesn't
  // repeat the same posters. A row that skipping thins out to a handful is dropped,
  // and its titles stay free for later rows.
  //
  // Rows claim titles in priority order, which is not page order: "because" rows go
  // first, since a row built from one of your titles is the most specific, and the
  // broad "for you" and genre rows take what's left. The page keeps its own order.
  let nextSeed = 0;
  const seedFor = onHome.map((t) => (t.special === 'because' ? seeds[nextSeed++] : undefined));
  const claimOrder = onHome.map((_, i) => i).sort((a, b) => Number(onHome[b]!.special === 'because') - Number(onHome[a]!.special === 'because') || a - b);
  const shown = new Map<number, number>();
  const built: (HomeRow | undefined)[] = onHome.map(() => undefined);
  for (const i of claimOrder) {
    const t = onHome[i]!;
    const cap = t.repeat ?? HOME_REPEAT_DEFAULT;
    let make: ((skip: number[]) => { row: HomeRow; left: number | null }) | undefined;
    if (t.special === 'because') {
      const seed = seedFor[i];
      if (seed) {
        const because = `${seed.media_type}:${seed.tmdb_id}`;
        make = (skip) => row(db, cfg, now, `because-${seed.media_type}-${seed.tmdb_id}`, `Because you have ${seed.title}`, { because, ...narrow }, `/browse?because=${because}${linkSuffix(only, co)}`, skip);
      }
    } else if (!(t.special === 'for-you' && !hasLibrary)) {
      // Discover only shows what's new to you: titles you have, are getting or requested drop
      // out of every row but Coming soon (where seeing your requested premieres is useful).
      const hideHave = t.slug !== 'coming-soon';
      make = (skip) => row(db, cfg, now, t.slug, t.title, { theme: t.slug, sort: t.sort, hideHave, ...co, ...(only.length ? { services: t.services ? t.services.filter((x) => only.includes(x)) : only } : {}) }, `/browse?theme=${t.slug}${hideHave ? '&hide=have' : ''}${linkSuffix(only, co)}`, skip);
    }
    if (!make) continue;
    const r = make([...shown].filter(([, n]) => n >= cap).map(([id]) => id));
    if (r.left !== null && r.left < MIN_THINNED_ROW) continue;
    for (const item of r.row.items) shown.set(item.id, (shown.get(item.id) ?? 0) + 1);
    built[i] = r.row;
  }
  const rows = built.filter((r): r is HomeRow => r !== undefined);
  // Shows you follow in Sonarr that have a new season out (Figma screen 9). Second, after "Just released".
  const seasonsRow = co.studios?.length || co.networks?.length ? null : newSeasonsRow(db, cfg, now, only);
  if (seasonsRow) rows.splice(Math.min(1, rows.length), 0, seasonsRow);
  return {
    trackingSince: since,
    showTrackingNotice: !since || now.getTime() - Date.parse(since) < 7 * DAY,
    // Empty "new" rows are dropped; the notice explains them during the first week.
    rows: rows.filter((r) => r.items.length > 0),
  };
}

function newSeasonsRow(db: Db, cfg: Config, now: Date, only: ServiceKey[]): HomeRow | null {
  const from = fromFor(cfg, { how: ['sub', 'digital', 'soon'], ...(only.length ? { services: only, servicesOnly: true } : {}) }, now);
  const rows = all<CardRow & { seasons: number | null; last_air_date: string | null; have_season: number | null; monitored_json: string | null; seasons_json: string | null }>(db, `
    SELECT ${CARD_COLUMNS}, tk.seasons, tk.last_air_date, li.have_season, li.monitored_json, sm.seasons_json
    ${from.sql} ${NEW_SEASON_CANDIDATES}
    ORDER BY tk.last_air_date DESC LIMIT 40`, [...from.params, newSeasonSince(now)]);
  const items = rows.filter((r) => newSeason({ haveSeason: r.have_season, monitoredJson: r.monitored_json, seasons: r.seasons,
    lastAirDate: r.last_air_date, seerrSeasonsJson: r.seasons_json }, now)).map(cardFor(cfg));
  if (!items.length) return null;
  return { slug: 'new-seasons', title: 'New seasons of your shows', total: items.length, link: null, items, art: rowArt(items) };
}

export function top(db: Db, cfg: Config, kind: Kind, limit = 50, minVotes = TOP_MIN_VOTES): TopResponse {
  const f = filters(cfg, { kind, minVotes }, new Date());
  const rows = all<CardRow & { runtime: number | null }>(db,
    `SELECT ${CARD_COLUMNS}, tk.runtime ${f.from} WHERE ${f.sql} AND tk.vote_average IS NOT NULL
     ORDER BY tk.vote_average DESC, tk.vote_count DESC, tk.id LIMIT ?`, [...f.params, limit]);
  return { kind, minVotes, items: rows.map((r, i) => ({ ...cardFor(cfg)(r), rank: i + 1, runtime: r.runtime })) };
}

export function genres(db: Db, cfg: Config, kind?: Kind): Genre[] {
  const f = filters(cfg, { kind }, new Date());
  return all<Genre>(db, `
    SELECT g.id, g.name, count(DISTINCT tk.id) AS count
    ${f.from}
    JOIN title_genres tg ON tg.title_id = tk.id
    JOIN genres g ON g.id = tg.genre_id
    WHERE ${f.sql}
    GROUP BY g.id ORDER BY g.name`, f.params);
}

export function titleDetail(db: Db, cfg: Config, id: number, now = new Date()): TitleDetail | null {
  // Every way to watch: subscriptions, rent or buy, and coming soon.
  const from = fromFor(cfg, { how: ['sub', 'digital', 'soon'] }, now);
  const r = get<CardRow & {
    overview: string | null; backdrop_path: string | null; release_date: string | null; runtime: number | null; seasons: number | null;
    certification: string | null; original_language: string | null; trailer_key: string | null; trailer_name: string | null;
    first_seen_at: string | null; tmdb_id: number | null; tmdb_type: 'movie' | 'tv' | null; seasons_json: string | null;
    credits_json: string | null; watch_json: string | null; recs_json: string | null;
    last_air_date: string | null; have_season: number | null; monitored_json: string | null;
  }>(db, `
    SELECT ${CARD_COLUMNS}, tk.overview, tk.backdrop_path, tk.release_date, tk.runtime, tk.seasons, tk.certification,
           tk.original_language, tk.trailer_key, tk.trailer_name, a.first_seen_at, tk.tmdb_id, tk.tmdb_type, sm.seasons_json,
           tk.credits_json, tk.watch_json, tk.recs_json, tk.last_air_date, li.have_season, li.monitored_json
    ${from.sql}
    LEFT JOIN library_items li ON li.media_type = tk.tmdb_type AND li.tmdb_id = tk.tmdb_id
    WHERE tk.id = ?`, [...from.params, id]);
  if (!r || r.kind === null) return null;
  const g = all<{ id: number; name: string }>(db,
    'SELECT g.id, g.name FROM title_genres tg JOIN genres g ON g.id = tg.genre_id WHERE tg.title_id = ? ORDER BY g.name', [id]);
  const card = cardFor(cfg)(r);
  const watch = r.watch_json ? JSON.parse(r.watch_json) as { rent: string[]; buy: string[] } : null;
  return {
    ...card,
    overview: r.overview, backdropPath: r.backdrop_path, releaseDate: r.release_date, runtime: r.runtime, seasons: r.seasons,
    certification: r.certification, originalLanguage: r.original_language, genres: g,
    trailer: r.trailer_key ? { key: r.trailer_key, name: r.trailer_name } : null,
    onNetflix: card.services.length > 0 || card.digital, firstSeenAt: r.first_seen_at, tmdbId: r.tmdb_id, tmdbType: r.tmdb_type,
    seerrSeasons: r.seasons_json ? JSON.parse(r.seasons_json) : [],
    cast: r.credits_json ? JSON.parse(r.credits_json) : [],
    related: related(db, cfg, r.recs_json, id, now),
    newSeason: r.tmdb_type === 'tv' ? newSeason({ haveSeason: r.have_season, monitoredJson: r.monitored_json, seasons: r.seasons,
      lastAirDate: r.last_air_date, seerrSeasonsJson: r.seasons_json }, now) : null,
    watch: {
      services: card.services.map((k) => ({ key: k, name: serviceByKey(k)!.name })),
      stores: watch ? [...new Set([...watch.rent, ...watch.buy])].slice(0, 6) : [],
      soon: card.soon,
    },
  };
}

/** "Related": TMDB's recommendations for a title that are on your services (or to rent), in TMDB's order. */
export const RELATED_LIMIT = 12;
function related(db: Db, cfg: Config, recsJson: string | null, selfId: number, now: Date): TitleCard[] {
  const recs = recsJson ? (JSON.parse(recsJson) as { type: 'movie' | 'tv'; id: number }[]) : [];
  if (!recs.length) return [];
  const f = filters(cfg, { how: ['sub', 'digital'] }, now);
  const pairs = recs.map(() => '(tk.tmdb_type = ? AND tk.tmdb_id = ?)').join(' OR ');
  const rows = all<CardRow & { tmdb_type: string; tmdb_id: number }>(db,
    `SELECT ${CARD_COLUMNS}, tk.tmdb_type, tk.tmdb_id ${f.from} WHERE ${f.sql} AND ${NOT_MINE} AND tk.id <> ? AND (${pairs})`,
    [...f.params, selfId, ...recs.flatMap((x) => [x.type, x.id])]);
  const rank = new Map(recs.map((x, i) => [`${x.type}:${x.id}`, i]));
  const seen = new Set<string>();
  return rows.sort((a, b) => rank.get(`${a.tmdb_type}:${a.tmdb_id}`)! - rank.get(`${b.tmdb_type}:${b.tmdb_id}`)!)
    .filter((x) => { const k = `${x.tmdb_type}:${x.tmdb_id}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, RELATED_LIMIT).map(cardFor(cfg));
}

export function meta(db: Db, cfg: Config, health: string, now = new Date()): MetaResponse {
  const passcodeRequired = Boolean(cfg.APP_PASSCODE);
  const lastSync = get<{ t: string }>(db, `SELECT max(started_at) t FROM sync_runs WHERE provider_id = ? AND region = ? AND applied = 1`,
    [cfg.NETFLIX_SOURCE_ID, cfg.REGION])?.t ?? null;
  const f = filters(cfg, {}, now);
  const eligible = get<{ n: number }>(db, `SELECT count(*) n ${f.from} WHERE ${f.sql}`, f.params)!.n;
  const w = filters(cfg, { added: 7 }, now);
  const newThisWeek = get<{ n: number }>(db, `SELECT count(*) n ${w.from} WHERE ${w.sql}`, w.params)!.n;
  return { trackingSince: trackingSince(db, cfg), lastSyncAt: lastSync, health, eligible, newThisWeek, languageRule: cfg.LANGUAGE_RULE, passcodeRequired,
    services: enabledServices(cfg.SERVICES).map((sv) => ({ key: sv.key, name: sv.name })) };
}

export function themes(db: Db, cfg: Config, now = new Date()): ThemeSummary[] {
  return themesFor(cfg).filter((t) => t.special !== 'because').map((t) => {
    const f = filters(cfg, { theme: t.slug }, now);
    const count = get<{ n: number }>(db, `SELECT count(*) n ${f.from} WHERE ${f.sql}`, f.params)!.n;
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
    `SELECT count(*) n, coalesce(sum(tk.kind = 'movie'), 0) movies, coalesce(sum(tk.kind = 'series'), 0) series, coalesce(sum(a.added_at IS NOT NULL), 0) dated ${base.from} WHERE ${where}`, params)!;
  // Which signals do the work: count per keyword / genre / type, within the theme.
  const bySignal: { signal: string; titles: number }[] = [];
  for (const kw of rule.signals?.keywords ?? []) {
    bySignal.push({ signal: `keyword: ${kw}`, titles: get<{ n: number }>(db, `SELECT count(*) n ${base.from} WHERE ${where} AND EXISTS (
      SELECT 1 FROM title_keywords x JOIN keywords k ON k.id = x.keyword_id WHERE x.title_id = tk.id AND lower(k.name) = ?)`, [...params, kw.toLowerCase()])!.n });
  }
  for (const g of rule.signals?.genres ?? []) {
    bySignal.push({ signal: `genre: ${g}`, titles: get<{ n: number }>(db, `SELECT count(*) n ${base.from} WHERE ${where} AND EXISTS (
      SELECT 1 FROM title_genres x JOIN genres gg ON gg.id = x.genre_id WHERE x.title_id = tk.id AND lower(gg.name) = ?)`, [...params, g.toLowerCase()])!.n });
  }
  for (const ty of rule.signals?.types ?? []) {
    bySignal.push({ signal: `type: ${ty}`, titles: get<{ n: number }>(db, `SELECT count(*) n ${base.from} WHERE ${where} AND tk.watchmode_type = ?`, [...params, ty])!.n });
  }
  const items = all<{ title: string; year: number | null; kind: string; vote_average: number | null; vote_count: number | null; runtime: number | null; seasons: number | null }>(db,
    `SELECT COALESCE(tk.tmdb_title, tk.title) title, tk.year, tk.kind, tk.vote_average, tk.vote_count, tk.runtime, tk.seasons ${base.from}
     WHERE ${where} ORDER BY ${ORDER[rule.sort]}, tk.id LIMIT ?`, [...params, sample]);
  return { ...counts, bySignal, items };
}

/** For tuning (CLI): keyword names containing some text, with how many shown titles carry each. */
export function keywordSearch(db: Db, cfg: Config, text: string, limit = 40, now = new Date()) {
  const base = filters(cfg, {}, now);
  return all<{ name: string; titles: number }>(db, `
    SELECT k.name, count(DISTINCT tk.id) titles ${base.from}
    JOIN title_keywords x ON x.title_id = tk.id JOIN keywords k ON k.id = x.keyword_id
    WHERE ${base.sql} AND lower(k.name) LIKE ?
    GROUP BY k.id ORDER BY titles DESC, k.name LIMIT ?`, [...base.params, `%${text.toLowerCase()}%`, limit]);
}

/** For the CLI: library titles, their category and how many recommendable Netflix titles each brings. */
export function libraryOverview(db: Db, cfg: Config, now = new Date()) {
  const f = filters(cfg, { ...REC_FLOOR }, now);
  return libraryReport(db, { sql: `${f.sql} AND ${REC_RECENT}`, params: f.params }, f.from);
}

/** Studios and networks to pick from: those with titles on your services (or rent or buy), most first. Cached 10 minutes. */
let companiesCache: { at: number; value: import('../api/types.js').CompaniesResponse } | null = null;
export const resetCompaniesCache = () => { companiesCache = null; };
export function companies(db: Db, cfg: Config, now = new Date()) {
  if (companiesCache && now.getTime() - companiesCache.at < 10 * 60_000) return companiesCache.value;
  const f = filters(cfg, { how: ['sub', 'digital'] }, now);
  const eligible = { from: f.from, sql: f.sql, params: f.params };
  const value = { studios: companyCounts(db, 'studio', eligible), networks: companyCounts(db, 'network', eligible) };
  companiesCache = { at: now.getTime(), value };
  return value;
}

/** Person page: their credits split into on your services (cards) and elsewhere, best known first. */
export function personPage(db: Db, cfg: Config, p: TmdbPerson, now = new Date()): PersonResponse {
  // One entry per title (an actor-director is credited twice); keep the first role given.
  const seen = new Map<string, PersonCreditItem>();
  for (const c of p.credits) {
    const k = `${c.tmdbType}:${c.tmdbId}`;
    if (!seen.has(k) || (!seen.get(k)!.role && c.role)) seen.set(k, c);
  }
  const credits = [...seen.values()].sort((a, b) => b.voteCount - a.voteCount || b.popularity - a.popularity);
  const rank = new Map(credits.map((c, i) => [`${c.tmdbType}:${c.tmdbId}`, i]));
  const hits = new Map<string, TitleCard & { role: string }>();
  const f = filters(cfg, { how: ['sub', 'digital', 'soon'] }, now);
  for (let i = 0; i < credits.length; i += 300) {
    const chunk = credits.slice(i, i + 300);
    const rows = all<CardRow & { tmdb_type: string; tmdb_id: number }>(db,
      `SELECT ${CARD_COLUMNS}, tk.tmdb_type, tk.tmdb_id ${f.from} WHERE ${f.sql} AND (${chunk.map(() => '(tk.tmdb_type = ? AND tk.tmdb_id = ?)').join(' OR ')})`,
      [...f.params, ...chunk.flatMap((c) => [c.tmdbType, c.tmdbId])]);
    for (const r of rows) {
      const k = `${r.tmdb_type}:${r.tmdb_id}`;
      if (!hits.has(k)) hits.set(k, { ...cardFor(cfg)(r), role: seen.get(k)?.role ?? '' });
    }
  }
  return {
    id: p.id, name: p.name, profilePath: p.profilePath, department: p.department, biography: p.biography,
    onServices: [...hits.entries()].sort(([a], [b]) => rank.get(a)! - rank.get(b)!).map(([, c]) => c),
    elsewhere: credits.filter((c) => !hits.has(`${c.tmdbType}:${c.tmdbId}`)).slice(0, 40)
      .map((c) => ({ tmdbType: c.tmdbType, tmdbId: c.tmdbId, title: c.title, year: c.year, posterPath: c.posterPath, role: c.role })),
  };
}
