import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp, type App } from '../app.js';
import { createServer } from '../server.js';
import { testConfig } from '../config.js';
import { all, run } from '../db/db.js';
import { FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';
import type { BrowseResponse, Genre, HomeResponse, MetaResponse, TitleDetail, TopResponse } from './types.js';

let app: App;
let http: ReturnType<typeof createServer>;
const j = async <T>(path: string) => { const r = await http.request(path); return { status: r.status, body: (await r.json()) as T }; };
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

// 400 real titles, enriched by the fake TMDB, then shaped so every filter has something to find.
beforeAll(async () => {
  const catalog = realCatalog().filter((_, i) => i % 18 === 0).slice(0, 400);
  const seerrMedia = catalog.filter((t) => t.tmdb_id).slice(0, 6).map((t, i) => ({
    id: i + 1, mediaType: t.tmdb_type, tmdbId: t.tmdb_id, status: [5, 4, 2, 3, 7, 1][i], seasons: t.tmdb_type === 'tv' ? [{ seasonNumber: 1, status: 5 }] : [],
  }));
  app = createApp(testConfig(), { watchmode: new FakeWatchmode(catalog).fetch, tmdb: new FakeTmdb().fetch, seerr: new FakeSeerr(seerrMedia).fetch });
  http = createServer(app);
  await app.pipeline('cli');
  const db = app.db;
  // Half English; a spread of ratings, votes and popularity; some dated.
  run(db, `UPDATE titles SET original_language = CASE WHEN id % 2 = 0 THEN 'en' ELSE 'ko' END,
                             vote_average = (id % 10) * 0.9 + 1, vote_count = (id * 37) % 3000, popularity = id % 97`);
  const ids = all<{ id: number }>(db, `SELECT a.id FROM availability a JOIN titles t ON t.id = a.title_id WHERE t.id % 2 = 0 ORDER BY a.id`).map((r) => r.id);
  ids.slice(0, 10).forEach((id, i) => run(db, 'UPDATE availability SET added_at = ?, baseline = 0 WHERE id = ?', [iso(i * 0.5), id]));   // within 7 days
  ids.slice(10, 20).forEach((id, i) => run(db, 'UPDATE availability SET added_at = ?, baseline = 0 WHERE id = ?', [iso(10 + i), id]));  // 10-19 days
  run(db, 'UPDATE availability SET removed_at = ? WHERE id = ?', [iso(1), ids[25]!]);
});
afterAll(() => app.close());

describe('read API', () => {
  it('/api/meta reports tracking start and counts', async () => {
    const { body } = await j<MetaResponse>('/api/meta');
    expect(body.trackingSince).toEqual(expect.any(String));
    expect(body.newThisWeek).toBe(10);
    expect(body.languageRule).toBe('en');
    expect(body.eligible).toBeGreaterThan(100);
  });

  it('/api/home returns the four rows, newest first, with totals', async () => {
    const { body } = await j<HomeResponse>('/api/home');
    expect(body.showTrackingNotice).toBe(true);
    expect(body.rows.map((r) => r.slug)).toEqual(['new-week', 'new-month', 'popular', 'acclaimed']);
    const week = body.rows[0]!;
    expect(week.total).toBe(10);
    const dates = week.items.map((i) => i.addedAt!);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(body.rows[1]!.total).toBe(20);
    expect(body.rows[3]!.items.every((i) => i.voteAverage! >= 7.5 && i.voteCount! >= 1000)).toBe(true);
  });

  it('home drops empty new rows during the baseline period', async () => {
    const a2 = createApp(testConfig(), { watchmode: new FakeWatchmode(realCatalog().slice(0, 50)).fetch, tmdb: new FakeTmdb().fetch, seerr: new FakeSeerr([]).fetch });
    await a2.pipeline('cli');
    run(a2.db, `UPDATE titles SET original_language = 'en'`);
    const h = (await (await createServer(a2).request('/api/home')).json()) as HomeResponse;
    expect(h.rows.map((r) => r.slug)).toEqual(['popular']);
    a2.close();
  });

  it('only English-original, non-special, current titles are listed', async () => {
    const { body } = await j<BrowseResponse>('/api/titles?page=1');
    const rows = all<{ n: number }>(app.db, `
      SELECT count(*) n FROM availability a JOIN title_kinds tk ON tk.id = a.title_id
      WHERE a.removed_at IS NULL AND tk.kind IS NOT NULL AND tk.original_language = 'en'`);
    expect(body.total).toBe(rows[0]!.n);
    expect(body.items).toHaveLength(Math.min(40, body.total));
  });

  it('filters by kind, added window, rating, votes and genre, and pages', async () => {
    const movies = (await j<BrowseResponse>('/api/titles?kind=movie')).body;
    const series = (await j<BrowseResponse>('/api/titles?kind=series')).body;
    const allTitles = (await j<BrowseResponse>('/api/titles')).body;
    expect(movies.total + series.total).toBe(allTitles.total);
    expect(movies.items.every((i) => i.kind === 'movie')).toBe(true);

    expect((await j<BrowseResponse>('/api/titles?added=7')).body.total).toBe(10);
    expect((await j<BrowseResponse>('/api/titles?added=30')).body.total).toBe(20);

    const rated = (await j<BrowseResponse>('/api/titles?minRating=7&minVotes=500&sort=rating')).body;
    expect(rated.items.every((i) => i.voteAverage! >= 7 && i.voteCount! >= 500)).toBe(true);
    const scores = rated.items.map((i) => i.voteAverage!);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    const g = (await j<Genre[]>('/api/genres?kind=movie')).body;
    expect(g.length).toBeGreaterThan(0);
    const drama = g.find((x) => x.name === 'Drama' || x.name === 'Action')!;
    expect((await j<BrowseResponse>(`/api/titles?kind=movie&genres=${drama.id}`)).body.total).toBe(drama.count);

    const p2 = (await j<BrowseResponse>('/api/titles?page=2')).body;
    expect(p2.page).toBe(2);
    expect(p2.items[0]!.id).not.toBe(allTitles.items[0]!.id);
  });

  it('search matches titles case-insensitively and escapes wildcards', async () => {
    const any = (await j<BrowseResponse>('/api/titles')).body.items[0]!;
    const word = any.title.split(' ')[0]!.toLowerCase();
    const res = (await j<BrowseResponse>(`/api/titles?q=${encodeURIComponent(word)}`)).body;
    expect(res.items.some((i) => i.id === any.id)).toBe(true);
    expect((await j<BrowseResponse>('/api/titles?q=%25%25%25')).body.total).toBe(0);
  });

  it('rejects bad query values', async () => {
    expect((await j('/api/titles?added=5')).status).toBe(400);
    expect((await j('/api/titles?minRating=11')).status).toBe(400);
    expect((await j('/api/top?kind=book')).status).toBe(400);
  });

  it('/api/top ranks by score with the 200-vote floor', async () => {
    const { body } = await j<TopResponse>('/api/top?kind=movie');
    expect(body.minVotes).toBe(200);
    expect(body.items.every((i) => i.voteCount! >= 200 && i.kind === 'movie')).toBe(true);
    expect(body.items.map((i) => i.rank)).toEqual(body.items.map((_, k) => k + 1));
  });

  it('/api/titles/:id returns the detail with trailer, rating and Seerr state', async () => {
    const card = (await j<BrowseResponse>('/api/titles?kind=movie')).body.items[0]!;
    const { body } = await j<TitleDetail>(`/api/titles/${card.id}`);
    expect(body).toMatchObject({ id: card.id, kind: 'movie', certification: 'PG-13', trailer: { key: 'trailer456' }, onNetflix: true });
    expect(body.genres.length).toBeGreaterThan(0);
    expect((await j('/api/titles/999999')).status).toBe(404);
  });

  it('maps Seerr statuses onto cards', async () => {
    const states = all<{ id: number; status: number }>(app.db,
      `SELECT t.id, sm.status FROM titles t JOIN seerr_media sm ON sm.media_type = t.tmdb_type AND sm.tmdb_id = t.tmdb_id`);
    const expected: Record<number, string | null> = { 5: 'available', 4: 'partial', 2: 'requested', 3: 'processing', 7: null, 1: null };
    for (const s of states) {
      const r = await http.request(`/api/titles/${s.id}`);
      if (r.status !== 200) continue;          // not English, so not shown
      expect(((await r.json()) as TitleDetail).seerr).toBe(expected[s.status]);
    }
  });
});

describe('rating range', () => {
  it('filters between minRating and maxRating', async () => {
    const { body } = await j<BrowseResponse>('/api/titles?minRating=4&maxRating=6');
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.every((i) => i.voteAverage! >= 4 && i.voteAverage! <= 6)).toBe(true);
    const open = await j<BrowseResponse>('/api/titles?minRating=4&maxRating=10');
    const min = await j<BrowseResponse>('/api/titles?minRating=4');
    expect(open.body.total).toBe(min.body.total);       // 10 means no upper bound
  });
});
