import { describe, it, expect, afterEach } from 'vitest';
import { createApp, type App } from '../app.js';
import { testConfig } from '../config.js';
import { all, get } from '../db/db.js';
import { FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';
import type { WatchmodeTitle } from '../clients/watchmode.js';
import { DIGITAL_ID, serviceByKey, tmdbOnlyId } from '../services.js';
import { creditForecast, discoverAll } from './services.js';
import { runCatalogSync } from './catalog.js';
import type { TmdbClient } from '../clients/tmdb.js';

const DAY = 86_400_000;
let app: App | undefined;
afterEach(() => { app?.close(); app = undefined; });

const catalog = () => realCatalog().filter((_, i) => i % 40 === 0);   // ~180 titles, movies and series
const isSeries = (t: WatchmodeTitle) => t.type === 'tv_series' || t.type === 'tv_miniseries';

function make(services: string, opts: { now?: () => Date; extra?: Record<string, string> } = {}) {
  const wm = new FakeWatchmode(catalog());
  const tmdb = new FakeTmdb();
  const a = createApp(testConfig({ SERVICES: services, ...opts.extra }), { watchmode: wm.fetch, tmdb: tmdb.fetch, seerr: new FakeSeerr([]).fetch });
  app = a;
  return { a, wm, tmdb };
}
const active = (a: App, provider: number) => get<{ n: number }>(a.db, 'SELECT count(*) n FROM availability WHERE provider_id = ? AND removed_at IS NULL', [provider])!.n;
const dated = (a: App, provider: number) => all<{ title_id: number; added_at: string }>(a.db,
  'SELECT title_id, added_at FROM availability WHERE provider_id = ? AND added_at IS NOT NULL', [provider]);

describe('Netflix in slices', () => {
  it('continues from M1 full syncs: movies daily, series weekly, no new baseline', async () => {
    const { a, wm } = make('netflix');
    await runCatalogSync({ db: a.db, cfg: a.cfg, watchmode: a.watchmode }, 'cli');       // the M1 history
    const fresh: WatchmodeTitle[] = [
      { id: 99_000_001, title: 'Brand New Movie', year: 2026, type: 'movie', tmdb_id: 900001, tmdb_type: 'movie', imdb_id: null },
      { id: 99_000_002, title: 'Brand New Show', year: 2026, type: 'tv_series', tmdb_id: 900002, tmdb_type: 'tv', imdb_id: null },
    ];
    wm.catalog.push(...fresh);
    const out = await a.pipeline('cli');
    if (!('sync' in out)) throw new Error('busy');
    expect(out.services.runs.map((r) => [r.slice, r.status, r.baseline])).toEqual([['movies', 'complete', 0], ['series', 'complete', 0]]);
    expect(dated(a, 203).length).toBe(2);
    // Lists only its own types: one credit-page per slice for this small catalog.
    expect(wm.calls.filter((c) => c.includes('types=tv_series'))).toHaveLength(1);

    // A day later only movies run.
    const out2 = await a.pipeline('cli');
    if (!('sync' in out2)) throw new Error('busy');
    expect(out2.services.runs.map((r) => r.slice)).toEqual(['movies']);
    expect(active(a, 203)).toBe(wm.catalog.length);
  });

  it('a weekly series find is dated by its premiere when that falls inside the week', async () => {
    const { a, wm, tmdb } = make('netflix');
    await a.pipeline('cli');                                                              // baseline both slices
    const premiere = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
    wm.catalog.push({ id: 99_000_003, title: 'New Show', year: 2026, type: 'tv_series', tmdb_id: 900003, tmdb_type: 'tv', imdb_id: null });
    tmdb.overrides.set('tv:900003', { first_air_date: premiere });
    const week = new Date(Date.now() + 7 * DAY);
    const cfgNow = () => week;
    const { syncServices } = await import('./services.js');
    await syncServices({ db: a.db, cfg: a.cfg, watchmode: a.watchmode, tmdb: a.tmdb, now: cfgNow }, 'cli');
    await a.enrich();
    const row = get<{ added_at: string; added_window_start: string | null }>(a.db,
      `SELECT a.added_at, a.added_window_start FROM availability a JOIN titles t ON t.id = a.title_id WHERE t.tmdb_id = 900003`)!;
    expect(row.added_at.slice(0, 10)).toBe(premiere);
    expect(row.added_window_start).toBeNull();
  });
});

describe('other services', () => {
  it('finds Watchmode sources by name; a new service starts with a baseline', async () => {
    const { a, wm } = make('netflix,hbomax');
    const max = serviceByKey('hbomax')!;
    wm.otherSources.set(387, catalog().slice(0, 50));
    await a.pipeline('cli');
    expect(active(a, max.id)).toBe(50);
    expect(dated(a, max.id)).toHaveLength(0);
    wm.otherSources.get(387)!.push({ id: 99_000_010, title: 'Max Movie', year: 2026, type: 'movie', tmdb_id: 900010, tmdb_type: 'movie', imdb_id: null });
    await a.pipeline('cli');
    expect(dated(a, max.id)).toHaveLength(1);
    // A title on both services is one title.
    const shared = get<{ n: number }>(a.db, `SELECT count(DISTINCT title_id) n FROM availability WHERE provider_id IN (203, ?)`, [max.id])!.n;
    expect(shared).toBe(get<{ n: number }>(a.db, 'SELECT count(*) n FROM titles')!.n);
    expect(creditForecast(a.db, a.cfg).rows.find((r) => r.service === 'HBO Max' && r.slice === 'movies')!.perMonth).toBe(30);
  });

  it('skips a service Watchmode does not list, and says so', async () => {
    const { a } = make('netflix,peacock');
    const out = await a.pipeline('cli');
    if (!('sync' in out)) throw new Error('busy');
    expect(out.services.skipped).toEqual(['Peacock: not found in Watchmode\'s source list']);
  });

  it('lists Prime Video from TMDB; shared titles join their Netflix row; Watchmode later adopts TMDB-only rows', async () => {
    const { a, wm, tmdb } = make('netflix,prime');
    const onNetflix = wm.catalog.find((t) => t.tmdb_type === 'movie' && t.type === 'movie')!;
    tmdb.discoverBy = (type, p) => p.get('with_watch_providers') === '9'
      ? (type === 'movie' ? [{ id: onNetflix.tmdb_id!, title: onNetflix.title }, { id: 800001, title: 'Prime Only' }] : [{ id: 800002, title: 'Prime Show' }])
      : [];
    await a.pipeline('cli');
    const prime = serviceByKey('prime')!;
    expect(active(a, prime.id)).toBe(3);
    const netflixRow = get<{ id: number }>(a.db, 'SELECT id FROM titles WHERE watchmode_id = ?', [onNetflix.id])!.id;
    expect(get<{ n: number }>(a.db, 'SELECT count(*) n FROM availability WHERE title_id = ?', [netflixRow])!.n).toBe(2);
    const primeOnly = get<{ id: number; watchmode_type: string }>(a.db, 'SELECT id, watchmode_type FROM titles WHERE watchmode_id = ?', [tmdbOnlyId('movie', 800001)])!;
    expect(primeOnly.watchmode_type).toBe('movie');
    expect(get<{ watchmode_type: string }>(a.db, 'SELECT watchmode_type FROM titles WHERE watchmode_id = ?', [tmdbOnlyId('tv', 800002)])!.watchmode_type).toBe('tv_series');

    // Netflix picks up the Prime-only movie: same title row, now with Watchmode's id.
    wm.catalog.push({ id: 99_000_020, title: 'Prime Only', year: 2026, type: 'movie', tmdb_id: 800001, tmdb_type: 'movie', imdb_id: null });
    await a.pipeline('cli');
    expect(get<{ watchmode_id: number }>(a.db, 'SELECT watchmode_id FROM titles WHERE id = ?', [primeOnly.id])!.watchmode_id).toBe(99_000_020);
    expect(get<{ n: number }>(a.db, 'SELECT count(*) n FROM availability WHERE title_id = ?', [primeOnly.id])!.n).toBe(2);
  });
});

describe('rent or buy and coming soon', () => {
  it('rent or buy is dated by the digital release; coming soon keeps the premiere and service', async () => {
    const { a, tmdb } = make('netflix', { extra: { TRACK_DIGITAL: 'true', TRACK_UPCOMING: 'true' } });
    tmdb.discoverBy = (type, p) => {
      if (type === 'movie' && p.get('with_release_type') === '4' && p.get('release_date.lte')! <= new Date().toISOString().slice(0, 10)) return [{ id: 700001, title: 'Rentable' }];
      if (type === 'movie' && p.get('with_release_type') === '4') return [{ id: 700002, title: 'Streams Soon', date: '2030-01-05' }];
      if (type === 'tv' && p.get('with_networks') === '213') return [{ id: 700003, title: 'Netflix Series Soon', date: '2030-01-07' }];
      return [];
    };
    tmdb.overrides.set('movie:700001', { release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2026-08-01T00:00:00.000Z' }, { type: 4, release_date: '2026-11-17T00:00:00.000Z', note: '' }] }] } });
    tmdb.overrides.set('movie:700002', { release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: '2030-01-05T00:00:00.000Z', note: 'Netflix' }] }] } });
    await a.pipeline('cli');
    const rent = all<{ added_at: string }>(a.db, 'SELECT added_at FROM availability WHERE provider_id = ?', [DIGITAL_ID]);
    expect(rent.map((r) => r.added_at.slice(0, 10))).toEqual(['2026-11-17']);
    const soon = all<{ tmdb_id: number; date: string; service: string | null; digital_note: string | null }>(a.db,
      'SELECT t.tmdb_id, u.date, u.service, t.digital_note FROM upcoming u JOIN titles t ON t.id = u.title_id ORDER BY u.date');
    // The movie premiere gets its service from TMDB's release note after enrich.
    expect(soon).toEqual([
      { tmdb_id: 700002, date: '2030-01-05', service: 'netflix', digital_note: 'Netflix' },
      { tmdb_id: 700003, date: '2030-01-07', service: 'netflix', digital_note: null },
    ]);
  });
});

describe('discoverAll', () => {
  it('splits a list too long for TMDB into date ranges', async () => {
    const calls: Record<string, string>[] = [];
    const fake = {
      async discoverPage(_type: string, params: Record<string, string>, page: number) {
        calls.push({ ...params, page: String(page) });
        const from = params['primary_release_date.gte'], to = params['primary_release_date.lte'];
        // 1,200 pages unfiltered; any range up to 50 years fits.
        const span = from && to ? (Date.parse(to) - Date.parse(from)) / (365 * DAY) : 999;
        const pages = span > 70 ? 1200 : 2;
        return { totalPages: pages, totalResults: pages * 20, results: [{ id: Number(`${page}${(from ?? '0').slice(0, 4)}`), title: 't', date: from ?? null }] };
      },
    } as unknown as TmdbClient;
    const l = await discoverAll(fake, 'movie', { with_watch_providers: '9' }, 4);
    expect(calls.every((c) => c.page !== '501')).toBe(true);
    expect(l.failedPages).toEqual([]);
    expect(l.results.length).toBeGreaterThan(2);
    expect(calls.filter((c) => c.page === '1' && c['primary_release_date.gte']).length).toBeGreaterThanOrEqual(2);
  });
});



