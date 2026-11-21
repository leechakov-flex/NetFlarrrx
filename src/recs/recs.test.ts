import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp, type App } from '../app.js';
import { createServer } from '../server.js';
import { testConfig } from '../config.js';
import { all, get, run } from '../db/db.js';
import { FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';
import type { BrowseResponse, HomeResponse } from '../api/types.js';

// Library titles live outside the Netflix catalog: TMDB ids from 5,000,000 up.
const LIB = (n: number) => 5_000_000 + n;

let app: App;
let tmdb: FakeTmdb;
let seerr: FakeSeerr;
let http: ReturnType<typeof createServer>;
let netflix: { id: number; tmdb_id: number; tmdb_type: 'movie' | 'tv' }[];
const j = async <T>(path: string) => (await (await http.request(path)).json()) as T;

beforeEach(async () => {
  const catalog = realCatalog().filter((t) => t.tmdb_id && t.tmdb_type === 'movie').filter((_, i) => i % 40 === 0).slice(0, 30);
  tmdb = new FakeTmdb();
  seerr = new FakeSeerr([]);
  app = createApp(testConfig(), { watchmode: new FakeWatchmode(catalog).fetch, tmdb: tmdb.fetch, seerr: seerr.fetch });
  http = createServer(app, { webDir: null });
  await app.pipeline('cli');
  run(app.db, `UPDATE titles SET original_language = 'en'`);
  netflix = all(app.db, `SELECT id, tmdb_id, tmdb_type FROM titles WHERE tmdb_id IS NOT NULL ORDER BY id`);
});
afterEach(() => app.close());

/** Puts library titles in Seerr as available, with TMDB recommendations pointing at Netflix titles. */
async function library(seeds: { n: number; recs: number[]; title?: string; at?: string }[]) {
  seerr.media = seeds.map((s, i) => ({ id: 100 + i, mediaType: 'movie', tmdbId: LIB(s.n), status: 5, seasons: [], updatedAt: s.at ?? `2026-11-${String(10 + i).padStart(2, '0')}T00:00:00Z` }));
  for (const s of seeds) {
    tmdb.recs.set(`movie:${LIB(s.n)}`, s.recs.map((i) => netflix[i]!.tmdb_id));
    tmdb.overrides.set(`movie:${LIB(s.n)}`, { title: s.title ?? `Library film ${s.n}` });
  }
  await app.mirror();
  return app.library();
}

describe('library and recommendations', () => {
  it('copies what Seerr has available and fetches TMDB recommendations once', async () => {
    const r = await library([{ n: 1, recs: [0, 1, 2] }, { n: 2, recs: [1] }]);
    expect(r).toMatchObject({ library: 2, added: 2, fetched: 2, errors: 0 });
    expect(get<{ n: number }>(app.db, 'SELECT count(*) n FROM library_recs')!.n).toBe(4);
    expect((await app.library()).fetched).toBe(0);          // cached
  });

  it('scores titles by how many of yours recommend them, and how strongly', async () => {
    // netflix[1] is recommended by both seeds; netflix[0] once at rank 1; netflix[2] once at rank 3.
    await library([{ n: 1, recs: [0, 1, 2] }, { n: 2, recs: [3, 1] }]);
    const forYou = await j<BrowseResponse>('/api/titles?theme=for-you');
    expect(forYou.theme).toMatchObject({ slug: 'for-you', title: 'Recommended for you', sort: 'match' });
    expect(forYou.items.map((i) => i.id)).toEqual([netflix[1]!.id, netflix[0]!.id, netflix[3]!.id, netflix[2]!.id]);
  });

  it('leaves out what you already have or requested', async () => {
    await library([{ n: 1, recs: [0, 1, 2] }]);
    // netflix[0] is in your library too (available in Seerr); netflix[1] is requested.
    seerr.media.push({ id: 500, mediaType: 'movie', tmdbId: netflix[0]!.tmdb_id, status: 5, seasons: [] });
    seerr.media.push({ id: 501, mediaType: 'movie', tmdbId: netflix[1]!.tmdb_id, status: 2, seasons: [] });
    await app.mirror();
    await app.library();
    expect((await j<BrowseResponse>('/api/titles?theme=for-you')).items.map((i) => i.id)).toEqual([netflix[2]!.id]);
  });

  it('builds "Because you have" rows from your recent titles with enough matches', async () => {
    await library([
      { n: 1, recs: [0, 1, 2, 3, 4, 5, 6], title: 'Older pick', at: '2026-01-01T00:00:00Z' },
      { n: 2, recs: [7, 8, 9, 10, 11, 12, 13, 14], title: 'Severance' },
      { n: 3, recs: [15, 16], title: 'Too few matches' },
    ]);
    const home = await j<HomeResponse>('/api/home');
    const because = home.rows.filter((r) => r.slug.startsWith('because-'));
    expect(because.map((r) => r.title)).toEqual(['Because you have Severance', 'Because you have Older pick']);
    expect(because[0]).toMatchObject({ total: 8, link: `/browse?because=movie:${LIB(2)}` });
    expect(because[0]!.items[0]!.id).toBe(netflix[7]!.id);      // TMDB's top pick first
    const page = await j<BrowseResponse>(`/api/titles?because=movie:${LIB(2)}`);
    expect(page.theme).toMatchObject({ title: 'Because you have Severance' });
    expect(page.total).toBe(8);
    expect(home.rows.map((r) => r.slug)).toContain('for-you');
  });

  it('drops library titles that are no longer available', async () => {
    await library([{ n: 1, recs: [0] }, { n: 2, recs: [1] }]);
    seerr.media = seerr.media.slice(0, 1);
    await app.mirror();
    expect(await app.library()).toMatchObject({ library: 1, removed: 1 });
    expect(get<{ n: number }>(app.db, 'SELECT count(*) n FROM library_recs')!.n).toBe(1);
  });

  it('shows no recommendation rows without a library', async () => {
    const home = await j<HomeResponse>('/api/home');
    expect(home.rows.some((r) => r.slug === 'for-you' || r.slug.startsWith('because-'))).toBe(false);
  });
});
