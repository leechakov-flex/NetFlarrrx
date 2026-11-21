import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../app.js';
import { createServer } from '../server.js';
import { testConfig } from '../config.js';
import { all, run } from '../db/db.js';
import { FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';
import { DEFAULT_THEMES, ThemeRule, loadThemes } from './themes.js';
import { keywordSearch, themePreview } from './queries.js';
import type { BrowseResponse, HomeResponse, ThemeSummary } from '../api/types.js';

let app: App;
let http: ReturnType<typeof createServer>;
let movies: number[];
let series: number[];
const j = async <T>(path: string) => { const r = await http.request(path); return { status: r.status, body: (await r.json()) as T }; };

// A neutral title: rated 6 with 300 votes, 110 minutes or 3 seasons, genre Drama, no keywords.
function reset() {
  const db = app.db;
  run(db, `UPDATE titles SET original_language = 'en', vote_average = 6, vote_count = 300, runtime = CASE WHEN watchmode_type LIKE 'tv_%' THEN NULL ELSE 110 END,
           seasons = CASE WHEN watchmode_type LIKE 'tv_%' THEN 3 ELSE NULL END,
           watchmode_type = CASE WHEN watchmode_type = 'tv_miniseries' THEN 'tv_series' WHEN watchmode_type = 'tv_special' THEN 'movie' ELSE watchmode_type END,
           release_date = '2001-01-01', last_air_date = NULL, netflix_original = 0`);
  run(db, 'DELETE FROM title_keywords');
  run(db, 'DELETE FROM title_genres');
  run(db, `INSERT OR IGNORE INTO genres (id, name) VALUES (18, 'Drama'), (99, 'Documentary'), (16, 'Animation'), (80, 'Crime')`);
  run(db, `INSERT INTO title_genres (title_id, genre_id) SELECT id, 18 FROM titles`);
  run(db, `INSERT OR IGNORE INTO keywords (id, name) VALUES (9672, 'based on true story'), (10051, 'heist'), (9748, 'Con Artist'), (11162, 'miniseries'), (1, 'dog')`);
}
const kw = (id: number, kwId: number) => run(app.db, 'INSERT OR IGNORE INTO title_keywords (title_id, keyword_id) VALUES (?, ?)', [id, kwId]);
const genre = (id: number, g: number) => run(app.db, 'INSERT OR IGNORE INTO title_genres (title_id, genre_id) VALUES (?, ?)', [id, g]);
const set = (id: number, cols: string) => run(app.db, `UPDATE titles SET ${cols} WHERE id = ?`, [id]);
const slugsFor = async (theme: string) => (await j<BrowseResponse>(`/api/titles?theme=${theme}`)).body.items.map((i) => i.id).sort((a, b) => a - b);

beforeAll(async () => {
  const catalog = realCatalog().filter((t) => t.tmdb_id).filter((_, i) => i % 30 === 0).slice(0, 80);
  app = createApp(testConfig(), { watchmode: new FakeWatchmode(catalog).fetch, tmdb: new FakeTmdb().fetch, seerr: new FakeSeerr([]).fetch });
  http = createServer(app, { webDir: null });
  await app.pipeline('cli');
  const ids = (kind: string) => all<{ id: number }>(app.db, `SELECT tk.id FROM title_kinds tk JOIN availability a ON a.title_id = tk.id WHERE tk.kind = ? ORDER BY tk.id`, [kind]).map((r) => r.id);
  reset();
  movies = ids('movie');
  series = ids('series');
});
afterAll(() => app.close());

describe('default themes', () => {
  it('are valid and in Discover order', () => {
    const slugs = DEFAULT_THEMES.map((t) => t.slug);
    expect(slugs.slice(0, 6)).toEqual(['new-week', 'new-month', 'new-movies', 'new-episodes', 'new-originals', 'for-you']);
    expect(slugs.indexOf('standup')).toBeLessThan(slugs.indexOf('trending'));         // comedy before the genre rows
    expect(slugs.at(-1)).toBe('popular');
    for (const s of ['acclaimed', 'hidden-gems', 'true-stories', 'heists', 'limited-series', 'short-movies']) expect(slugs).toContain(s);
    expect(DEFAULT_THEMES.filter((t) => t.special === 'because')).toHaveLength(3);
  });

  it('true stories: any listed keyword, case-insensitive; documentaries excluded', async () => {
    reset();
    const [a, b, doc] = movies;
    kw(a!, 9672); kw(series[0]!, 9672);
    kw(doc!, 9672); genre(doc!, 99);
    kw(b!, 1);                                   // unrelated keyword
    expect(await slugsFor('true-stories')).toEqual([a!, series[0]!].sort((x, y) => x - y));
  });

  it('heists: keyword names match regardless of TMDB capitalisation', async () => {
    reset();
    kw(movies[0]!, 10051); kw(movies[1]!, 9748);
    kw(movies[2]!, 10051); genre(movies[2]!, 16);  // animated heist excluded
    run(app.db, `INSERT OR IGNORE INTO keywords (id, name) VALUES (2, 'thief')`); kw(movies[3]!, 2);   // too broad
    expect(await slugsFor('heists')).toEqual([movies[0]!, movies[1]!]);
  });

  it('limited series: Watchmode miniseries type or keyword, one season at most', async () => {
    reset();
    const [s1, s2, s3, s4] = series;
    set(s1!, `watchmode_type = 'tv_miniseries', seasons = 1`);
    kw(s2!, 11162); set(s2!, 'seasons = 1');
    set(s3!, `watchmode_type = 'tv_miniseries', seasons = 2`);   // second season: no longer limited
    set(s4!, 'seasons = 1');                                     // one season but no signal
    expect(await slugsFor('limited-series')).toEqual([s1!, s2!].sort((x, y) => x - y));
  });

  it('short movies: 40 to 89 minutes, movies only', async () => {
    reset();
    set(movies[0]!, 'runtime = 85'); set(movies[1]!, 'runtime = 89'); set(movies[2]!, 'runtime = 90'); set(movies[3]!, 'runtime = 22');
    set(movies[4]!, 'runtime = 42, vote_average = 1.75, vote_count = 8');    // low-vote TV movie
    expect(await slugsFor('short-movies')).toEqual([movies[0]!, movies[1]!]);
  });

  it('hidden gems and acclaimed split by vote count, sorted by rating', async () => {
    reset();
    set(movies[0]!, 'vote_average = 7.8, vote_count = 400');
    set(movies[1]!, 'vote_average = 8.4, vote_count = 200');
    set(movies[2]!, 'vote_average = 8.1, vote_count = 120');      // too few votes to trust
    set(movies[4]!, 'vote_average = 8.8, vote_count = 381, runtime = 27');   // a trailer special
    set(series[0]!, 'vote_average = 7.5, vote_count = 300');      // series have no runtime: still in
    set(movies[3]!, 'vote_average = 8.0, vote_count = 5000');      // famous, so acclaimed instead
    const gems = await j<BrowseResponse>('/api/titles?theme=hidden-gems');
    expect(gems.body.items.map((i) => i.id)).toEqual([movies[1]!, movies[0]!, series[0]!]);
    expect(gems.body.theme).toEqual({ slug: 'hidden-gems', title: 'Hidden gems', sort: 'rating' });
    expect(await slugsFor('acclaimed')).toEqual([movies[3]!]);
  });
});

describe('new rule fields', () => {
  const day = 86_400_000;
  const date = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString().slice(0, 10);

  it('stand-up: Watchmode specials or stand-up keywords, comedy only, newest first', async () => {
    reset();
    run(app.db, `INSERT OR IGNORE INTO genres (id, name) VALUES (35, 'Comedy')`);
    run(app.db, `INSERT OR IGNORE INTO keywords (id, name) VALUES (9716, 'stand-up comedy')`);
    set(movies[0]!, `watchmode_type = 'tv_special', release_date = '${date(400)}'`); genre(movies[0]!, 35);
    set(movies[1]!, `release_date = '${date(10)}'`); genre(movies[1]!, 35); kw(movies[1]!, 9716);
    set(movies[2]!, `watchmode_type = 'tv_special'`);                     // an awards show: not comedy
    genre(movies[3]!, 35);                                                // a comedy film: not stand-up
    expect((await j<BrowseResponse>('/api/titles?theme=standup')).body.items.map((i) => i.id)).toEqual([movies[1]!, movies[0]!]);
    expect((await j<BrowseResponse>('/api/titles?theme=new-movies')).body.items.map((i) => i.id)).not.toContain(movies[0]!);
  });

  it('released, aired and originals windows; future dates are ignored', async () => {
    reset();
    set(movies[0]!, `release_date = '${date(20)}', netflix_original = 1`);
    set(movies[1]!, `release_date = '${date(200)}'`);
    set(movies[2]!, `release_date = '${date(-30)}'`);                   // announced, not out yet
    set(series[0]!, `release_date = '2015-01-01', last_air_date = '${date(5)}'`);   // old show, new season
    set(series[1]!, `release_date = '2015-01-01', last_air_date = '2018-06-01'`);
    expect(await slugsFor('new-movies')).toEqual([movies[0]!]);
    expect(await slugsFor('new-episodes')).toEqual([series[0]!]);
    expect(await slugsFor('new-originals')).toEqual([movies[0]!]);
  });

  it('newest added falls back to the latest release or episode for undated titles', async () => {
    reset();
    run(app.db, `UPDATE titles SET release_date = '2001-01-01', popularity = 1`);
    set(movies[0]!, `release_date = '${date(3)}'`);
    set(series[0]!, `release_date = '2010-01-01', last_air_date = '${date(1)}'`);
    set(movies[1]!, 'popularity = 999');                                  // popular but old
    const items = (await j<BrowseResponse>('/api/titles?sort=added')).body.items.map((i) => i.id);
    expect(items.slice(0, 2)).toEqual([series[0]!, movies[0]!]);
    expect(items.indexOf(movies[1]!)).toBeGreaterThan(1);
  });
});

describe('theme API and home', () => {
  it('home shows theme rows after the fixed rows and drops empty ones', async () => {
    reset();
    kw(movies[0]!, 10051);
    set(movies[1]!, 'runtime = 80');
    const { body } = await j<HomeResponse>('/api/home');
    const slugs = body.rows.map((r) => r.slug);
    expect(body.rows.find((r) => r.slug === 'heists')).toMatchObject({ title: 'Heists and cons', total: 1, link: '/browse?theme=heists' });
    expect(slugs).toContain('short-movies');
    expect(slugs).not.toContain('true-stories');        // nothing matches: dropped
    expect(slugs).not.toContain('for-you');             // no library yet
    expect(body.rows.every((r) => r.items.length > 0)).toBe(true);
    expect(slugs.indexOf('heists')).toBeLessThan(slugs.indexOf('short-movies'));
  });

  describe('no repeated titles on Discover', () => {
    const date = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const rowsOf = async () => (await j<HomeResponse>('/api/home')).body.rows;

    it('a title shows in one row unless its theme allows repeats', async () => {
      reset();
      // Recent dramas fit new-movies, trending, dramas, new-for-you... all at once.
      for (const id of movies.slice(0, 30)) set(id, `release_date = '${date(10)}'`);
      const rows = await rowsOf();
      const seen = new Map<number, string[]>();
      for (const r of rows) for (const i of r.items) seen.set(i.id, [...(seen.get(i.id) ?? []), r.slug]);
      const repeatCap = new Map(DEFAULT_THEMES.map((t) => [t.slug, t.repeat ?? 1]));
      for (const [id, slugs] of seen) {
        // A title is in at most as many rows as the most permissive of them allows.
        expect(slugs.length, `title ${id} in ${slugs.join(', ')}`).toBeLessThanOrEqual(Math.max(...slugs.map((s) => repeatCap.get(s) ?? 1)));
      }
      expect(rows.find((r) => r.slug === 'new-movies')).toBeTruthy();
    });

    it('rows fill from further down their ranking instead of shrinking', async () => {
      reset();
      for (const id of movies.slice(0, 40)) set(id, `release_date = '${date(10)}'`);
      const rows = await rowsOf();
      const newMovies = rows.find((r) => r.slug === 'new-movies')!;
      const trending = rows.find((r) => r.slug === 'trending')!;
      expect(newMovies.items.length).toBeGreaterThan(0);
      const taken = new Set(newMovies.items.map((i) => i.id));
      expect(trending.items.every((i) => !taken.has(i.id))).toBe(true);       // trending skips what new-movies showed...
      expect(trending.items.length).toBeGreaterThan(0);                       // ...and still has titles to show
      expect(trending.total).toBeGreaterThanOrEqual(newMovies.total);         // "see all" still counts the whole theme
    });

    it('a row that dedupe thins to a handful is dropped, not shown half empty', async () => {
      reset();
      const [a, b, c] = movies;
      for (const id of [a!, b!, c!]) { kw(id, 10051); set(id, `release_date = '${date(10)}'`); }   // heists, and new-movies too
      const rows = await rowsOf();
      // new-movies (earlier on the page) shows exactly these three, so heists has nothing left.
      expect(rows.find((r) => r.slug === 'new-movies')!.items.map((i) => i.id).sort((x, y) => x - y)).toEqual([a!, b!, c!].sort((x, y) => x - y));
      expect(rows.some((r) => r.slug === 'heists')).toBe(false);
      // The full theme is still there for "see all".
      expect((await j<BrowseResponse>('/api/titles?theme=heists')).body.total).toBe(3);
    });

    it('repeat is an optional positive integer on a theme', () => {
      expect(ThemeRule.safeParse({ slug: 'x', title: 'X', repeat: 2 }).success).toBe(true);
      expect(ThemeRule.safeParse({ slug: 'x', title: 'X' }).success).toBe(true);
      expect(ThemeRule.safeParse({ slug: 'x', title: 'X', repeat: 0 }).success).toBe(false);
      expect(DEFAULT_THEMES.filter((t) => (t.repeat ?? 1) > 1).map((t) => t.slug).sort())
        .toEqual(['action', 'crime', 'dramas', 'scifi', 'thrillers', 'true-stories']);
    });
  });

  it('/api/themes lists every theme with a count; unknown themes are 404', async () => {
    reset();
    kw(movies[0]!, 10051);
    const { body } = await j<ThemeSummary[]>('/api/themes');
    expect(body.find((t) => t.slug === 'heists')).toMatchObject({ count: 1, kind: null, home: true });
    expect(body).toHaveLength(DEFAULT_THEMES.length - 3);     // "because" rows aren't browseable themes
    expect((await j('/api/titles?theme=because-1')).status).toBe(404);
    expect((await j('/api/titles?theme=nope')).status).toBe(404);
  });

  it('theme combines with other filters, and an explicit sort wins', async () => {
    reset();
    set(movies[0]!, 'runtime = 80, vote_average = 5'); set(movies[1]!, 'runtime = 80, vote_average = 8');
    expect((await j<BrowseResponse>('/api/titles?theme=short-movies&minRating=7')).body.items.map((i) => i.id)).toEqual([movies[1]!]);
    expect((await j<BrowseResponse>('/api/titles?theme=short-movies&sort=rating')).body.items[0]!.id).toBe(movies[1]!);
  });
});

describe('tuning tools', () => {
  it('preview counts what each signal catches', () => {
    reset();
    kw(movies[0]!, 10051); kw(movies[1]!, 10051); kw(movies[1]!, 9748); kw(series[0]!, 9748);
    const p = themePreview(app.db, app.cfg, DEFAULT_THEMES.find((t) => t.slug === 'heists')!);
    expect(p).toMatchObject({ n: 3, movies: 2, series: 1 });
    expect(p.bySignal.find((s) => s.signal === 'keyword: heist')!.titles).toBe(2);
    expect(p.bySignal.find((s) => s.signal === 'keyword: con artist')!.titles).toBe(2);
    expect(p.items).toHaveLength(3);
  });

  it('keyword search finds names with counts', () => {
    reset();
    kw(movies[0]!, 10051); kw(movies[1]!, 10051);
    expect(keywordSearch(app.db, app.cfg, 'HEI')).toEqual([{ name: 'heist', titles: 2 }]);
  });
});

describe('themes.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nfx-themes-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('replaces the defaults when valid', () => {
    const custom: unknown[] = [{ slug: 'eighties', title: 'Made in the 80s', year: { min: 1980, max: 1989 } }];
    writeFileSync(join(dir, 'themes.json'), JSON.stringify(custom));
    const t = loadThemes(testConfig({ DATA_DIR: dir }));
    expect(t).toEqual([ThemeRule.parse(custom[0])]);
    expect(t[0]).toMatchObject({ sort: 'added', home: true });
  });

  it('falls back to the defaults when broken', () => {
    writeFileSync(join(dir, 'themes.json'), '[{"slug":"Bad Slug","title":""}]');
    expect(loadThemes(testConfig({ DATA_DIR: dir }))).toBe(DEFAULT_THEMES);
    writeFileSync(join(dir, 'themes.json'), '{not json');
    expect(loadThemes(testConfig({ DATA_DIR: dir }))).toBe(DEFAULT_THEMES);
  });
});
