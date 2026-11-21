// Runs every service's syncs, plus the two TMDB lists that aren't services:
// new to rent or buy, and coming soon.
import type { Config } from '../config.js';
import { all, get, getJobState, run, setJobState, tx, type Db } from '../db/db.js';
import { mapLimit } from '../clients/http.js';
import type { TmdbClient } from '../clients/tmdb.js';
import type { WatchmodeClient, WatchmodeTitle } from '../clients/watchmode.js';
import { DIGITAL_ID, enabledServices, MOVIE_TYPES, SERIES_TYPES, tmdbOnlyId, type Service, type Slice } from '../services.js';
import { lastRun, runSliceSync, upsertTitles, type SliceTarget, type SyncRunRow, type Trigger } from './catalog.js';
import { log } from '../log.js';

const DAY = 86_400_000;
/** Series slices run weekly; a little under 7 days so a late daily run doesn't push it a day. */
const SERIES_EVERY_MS = 6.5 * DAY;
const SOURCES_STALE_MS = 30 * DAY;
const MAX_DISCOVER_PAGES = 500;                 // TMDB stops at page 500
export const DIGITAL_WINDOW_DAYS = 60;          // "new to rent or buy" looks back this far
export const UPCOMING_DAYS = 45;                // "coming soon" looks ahead this far

export interface ServicesResult { runs: SyncRunRow[]; upcoming: number | null; skipped: string[] }

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Watchmode source id per service, found by name once a month (the Netflix id is fixed). */
export async function watchmodeSourceIds(db: Db, cfg: Config, watchmode: WatchmodeClient, services: Service[], now = new Date()) {
  const cached = getJobState<Record<string, number>>(db, 'watchmode_sources');
  const fresh = cached && now.getTime() - Date.parse(cached.updated_at) < SOURCES_STALE_MS;
  let map: Record<string, number> = fresh ? cached.value : {};
  const needed = services.filter((s) => s.source === 'watchmode' && s.key !== 'netflix');
  if (needed.some((s) => !(s.key in map))) {
    try {
      const list = (await watchmode.sources(cfg.REGION)).filter((s) => !s.type || s.type === 'sub');
      map = {};
      for (const s of needed) { const hit = list.find((x) => s.watchmodeNames.test(x.name.trim())); if (hit) map[s.key] = hit.id; }
      setJobState(db, 'watchmode_sources', map, now.toISOString());
    } catch (err) {
      log.warn('sync: could not list Watchmode sources', { error: String(err) });
      if (cached) map = cached.value;
    }
  }
  return { ...map, netflix: cfg.NETFLIX_SOURCE_ID } as Record<string, number>;
}

/** Existing rows for TMDB ids, so a title on Netflix and Prime stays one title. */
function knownByTmdb(db: Db, type: 'movie' | 'tv', ids: number[]) {
  const out = new Map<number, WatchmodeTitle>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of all<{ watchmode_id: number; title: string; year: number | null; watchmode_type: string; imdb_id: string | null; tmdb_id: number }>(db,
      `SELECT watchmode_id, title, year, watchmode_type, imdb_id, tmdb_id FROM titles WHERE tmdb_type = ? AND tmdb_id IN (${chunk.map(() => '?').join(',')})
       ORDER BY watchmode_id > 0 DESC, id`, [type, ...chunk])) {
      if (!out.has(r.tmdb_id)) out.set(r.tmdb_id, { id: r.watchmode_id, title: r.title, year: r.year, type: r.watchmode_type, imdb_id: r.imdb_id, tmdb_id: r.tmdb_id, tmdb_type: type });
    }
  }
  return out;
}

/** Turns TMDB results into title rows: existing ones as they are, new ones with a stand-in id. */
export function asTitles(db: Db, type: 'movie' | 'tv', items: { id: number; title: string; date: string | null }[]): WatchmodeTitle[] {
  const known = knownByTmdb(db, type, [...new Set(items.map((i) => i.id))]);
  const out = new Map<number, WatchmodeTitle>();
  for (const i of items) {
    const t = known.get(i.id) ?? { id: tmdbOnlyId(type, i.id), title: i.title, year: i.date ? Number(i.date.slice(0, 4)) || null : null,
      type: type === 'movie' ? 'movie' : 'tv_series', imdb_id: null, tmdb_id: i.id, tmdb_type: type };
    out.set(t.id, t);
  }
  return [...out.values()];
}

/**
 * Every result of a TMDB discover query. TMDB serves at most 500 pages, so a
 * bigger list is split into date ranges, halved until each fits.
 */
export async function discoverAll(tmdb: TmdbClient, type: 'movie' | 'tv', params: Record<string, string>, concurrency: number) {
  const dateKey = type === 'movie' ? 'primary_release_date' : 'first_air_date';
  const results: { id: number; title: string; date: string | null }[] = [];
  const failedPages: number[] = [];
  let pages = 0;
  const crawl = async (p: Record<string, string>, from: string | null, to: string | null): Promise<void> => {
    const q = { ...p, ...(from ? { [`${dateKey}.gte`]: from } : {}), ...(to ? { [`${dateKey}.lte`]: to } : {}) };
    const first = await tmdb.discoverPage(type, q, 1);
    pages += 1;
    if (first.totalPages > MAX_DISCOVER_PAGES) {
      const lo = Date.parse(from ?? '1900-01-01'), hi = Date.parse(to ?? isoDay(new Date(Date.now() + 365 * DAY)));
      if (hi - lo > DAY) {
        const mid = isoDay(new Date(lo + Math.floor((hi - lo) / 2)));
        await crawl(p, from ?? '1900-01-01', mid);
        await crawl(p, isoDay(new Date(Date.parse(mid) + DAY)), to ?? isoDay(new Date(hi)));
        return;
      }
    }
    results.push(...first.results);
    const rest = Array.from({ length: Math.min(first.totalPages, MAX_DISCOVER_PAGES) - 1 }, (_, i) => i + 2);
    await mapLimit(rest, concurrency, async (page) => {
      try { results.push(...(await tmdb.discoverPage(type, q, page)).results); pages += 1; }
      catch { failedPages.push(page); pages += 1; }
    });
  };
  // When a list has to be split, titles with no date fall outside every range and
  // are missed; TMDB's catalogs have very few, and none that are new.
  await crawl(params, null, null);
  return { results, pages, failedPages };
}

function tmdbServiceTarget(db: Db, cfg: Config, tmdb: TmdbClient, s: Service, slice: Exclude<Slice, 'all'>): SliceTarget {
  const type = slice === 'movies' ? 'movie' : 'tv';
  return {
    providerId: s.id, slice, source: 'tmdb', label: `${s.name} ${slice}`,
    tmdbList: async () => {
      const l = await discoverAll(tmdb, type, {
        with_watch_providers: s.tmdbProviders.join('|'), watch_region: cfg.REGION, with_watch_monetization_types: 'flatrate', sort_by: 'popularity.desc',
      }, cfg.TMDB_CONCURRENCY);
      const titles = asTitles(db, type, l.results).filter((t) => (slice === 'movies' ? (MOVIE_TYPES as readonly string[]) : SERIES_TYPES as readonly string[]).includes(t.type));
      return { titles, pages: l.pages, failedPages: l.failedPages };
    },
  };
}

function digitalTarget(db: Db, cfg: Config, tmdb: TmdbClient, now: Date): SliceTarget {
  return {
    providerId: DIGITAL_ID, slice: 'movies', source: 'tmdb', label: 'rent or buy',
    tmdbList: async () => {
      const l = await discoverAll(tmdb, 'movie', {
        region: cfg.REGION, with_release_type: '4', 'release_date.gte': isoDay(new Date(now.getTime() - DIGITAL_WINDOW_DAYS * DAY)),
        'release_date.lte': isoDay(now), sort_by: 'popularity.desc',
      }, cfg.TMDB_CONCURRENCY);
      return { titles: asTitles(db, 'movie', l.results), pages: l.pages, failedPages: l.failedPages };
    },
  };
}

/**
 * Coming soon: movies with a US digital premiere in the next UPCOMING_DAYS
 * (streaming originals and rentals; which one is worked out from TMDB's note
 * when the title is shown), and series premiering on a tracked service's network.
 */
export async function refreshUpcoming(db: Db, cfg: Config, tmdb: TmdbClient, now = new Date()) {
  const services = enabledServices(cfg.SERVICES);
  const from = isoDay(new Date(now.getTime() + DAY)), to = isoDay(new Date(now.getTime() + UPCOMING_DAYS * DAY));
  const movies = await discoverAll(tmdb, 'movie', { region: cfg.REGION, with_release_type: '4', 'release_date.gte': from, 'release_date.lte': to, sort_by: 'popularity.desc' }, cfg.TMDB_CONCURRENCY);
  const series: { service: string; items: typeof movies.results }[] = [];
  await mapLimit(services, 2, async (s) => {
    const l = await discoverAll(tmdb, 'tv', { with_networks: s.tmdbNetworks.join('|'), 'first_air_date.gte': from, 'first_air_date.lte': to, sort_by: 'popularity.desc' }, cfg.TMDB_CONCURRENCY);
    series.push({ service: s.key, items: l.results });
  });
  const nowIso = now.toISOString();
  return tx(db, () => {
    const rows: { wid: number; date: string; service: string | null }[] = [];
    const mt = asTitles(db, 'movie', movies.results);
    upsertTitles(db, mt.filter((t) => t.id < 0), nowIso);
    const byTmdb = new Map(movies.results.map((m) => [m.id, m.date]));
    for (const t of mt) { const d = byTmdb.get(t.tmdb_id!); if (d) rows.push({ wid: t.id, date: d.slice(0, 10), service: null }); }
    for (const s of series) {
      const st = asTitles(db, 'tv', s.items);
      upsertTitles(db, st.filter((t) => t.id < 0), nowIso);
      const dates = new Map(s.items.map((m) => [m.id, m.date]));
      for (const t of st) { const d = dates.get(t.tmdb_id!); if (d) rows.push({ wid: t.id, date: d.slice(0, 10), service: s.service }); }
    }
    run(db, 'DELETE FROM upcoming');
    const ins = db.prepare(`INSERT INTO upcoming (title_id, date, service) SELECT id, ?, ? FROM titles WHERE watchmode_id = ?
                            ON CONFLICT (title_id) DO UPDATE SET date = min(upcoming.date, excluded.date), service = COALESCE(upcoming.service, excluded.service)`);
    for (const r of rows) ins.run(r.date, r.service, r.wid);
    const n = get<{ n: number }>(db, 'SELECT count(*) n FROM upcoming')!.n;
    setJobState(db, 'upcoming', { at: nowIso, titles: n, failedPages: movies.failedPages.length });
    return n;
  });
}

const seriesDue = (db: Db, cfg: Config, providerId: number, now: Date) => {
  const last = lastRun(db, providerId, cfg.REGION, 'series', `status IN ('complete', 'held')`);
  return !last || now.getTime() - Date.parse(last.started_at) >= SERIES_EVERY_MS;
};

/** One pass over every enabled service, then rent or buy and coming soon. */
export async function syncServices(deps: { db: Db; cfg: Config; watchmode: WatchmodeClient; tmdb: TmdbClient; now?: () => Date }, trigger: Trigger, opts: { forceSeries?: boolean } = {}): Promise<ServicesResult> {
  const { db, cfg, watchmode, tmdb } = deps;
  const now = deps.now?.() ?? new Date();
  const services = enabledServices(cfg.SERVICES);
  const ids = await watchmodeSourceIds(db, cfg, watchmode, services, now);
  const runs: SyncRunRow[] = [];
  const skipped: string[] = [];
  const go = async (t: SliceTarget) => { const r = await runSliceSync({ db, cfg, watchmode, now: deps.now }, trigger, t); runs.push(r); log.info('sync: slice done', { slice: t.label, status: r.status, titles: r.titles_seen, added: r.added }); };
  for (const s of services) {
    const doSeries = opts.forceSeries || seriesDue(db, cfg, s.id, now);
    if (s.source === 'tmdb') {
      await go(tmdbServiceTarget(db, cfg, tmdb, s, 'movies'));
      await go(tmdbServiceTarget(db, cfg, tmdb, s, 'series'));
      continue;
    }
    const sourceId = ids[s.key];
    if (!sourceId) { skipped.push(`${s.name}: not found in Watchmode's source list`); continue; }
    await go({ providerId: s.id, slice: 'movies', source: 'watchmode', watchmodeSourceId: sourceId, label: `${s.name} movies` });
    if (doSeries) await go({ providerId: s.id, slice: 'series', source: 'watchmode', watchmodeSourceId: sourceId, label: `${s.name} series` });
  }
  if (cfg.TRACK_DIGITAL) await go(digitalTarget(db, cfg, tmdb, now));
  let upcoming: number | null = null;
  if (cfg.TRACK_UPCOMING) {
    try { upcoming = await refreshUpcoming(db, cfg, tmdb, now); }
    catch (err) { log.warn('sync: coming soon refresh failed', { error: String(err) }); }
  }
  return { runs, upcoming, skipped };
}

/** Rough Watchmode credits a month at the current schedule, from each slice's last page count. */
export function creditForecast(db: Db, cfg: Config) {
  const rows: { service: string; slice: Slice; pages: number; perMonth: number }[] = [];
  for (const s of enabledServices(cfg.SERVICES).filter((x) => x.source === 'watchmode')) {
    for (const slice of ['movies', 'series'] as const) {
      const r = lastRun(db, s.id, cfg.REGION, slice, 'pages_total IS NOT NULL');
      const pages = r?.pages_total ?? 0;
      rows.push({ service: s.name, slice, pages, perMonth: Math.round(pages * (slice === 'movies' ? 30.4 : 4.35)) });
    }
  }
  return { rows, total: rows.reduce((n, r) => n + r.perMonth, 0) };
}
