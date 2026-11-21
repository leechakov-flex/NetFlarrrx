import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp, type App } from '../app.js';
import { createServer } from '../server.js';
import { testConfig } from '../config.js';
import { all, get, run } from '../db/db.js';
import { FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';
import type { FetchFn } from '../clients/http.js';

/** Radarr or Sonarr answering GET /api/v3/movie or /series; counts calls and checks the key. */
class FakeArr {
  items: unknown[] = [];
  fail = false;
  calls: string[] = [];
  fetch: FetchFn = async (input, init) => {
    const url = new URL(String(input));
    this.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if ((init?.headers as Record<string, string>)?.['X-Api-Key'] !== 'arr-key') return new Response('{}', { status: 401 });
    if (this.fail) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify(this.items), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
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

describe('Radarr and Sonarr as the library', () => {
  let radarr: FakeArr;
  let sonarr: FakeArr;
  async function withArr() {
    app.close();
    radarr = new FakeArr(); sonarr = new FakeArr();
    const catalog = realCatalog().filter((t) => t.tmdb_id && t.tmdb_type === 'movie').filter((_, i) => i % 40 === 0).slice(0, 30);
    app = createApp(testConfig({ RADARR_API_KEY: 'arr-key', SONARR_API_KEY: 'arr-key' }), {
      watchmode: new FakeWatchmode(catalog).fetch, tmdb: tmdb.fetch, seerr: seerr.fetch, radarr: radarr.fetch, sonarr: sonarr.fetch,
    });
    http = createServer(app, { webDir: null });
    await app.pipeline('cli');
    run(app.db, `UPDATE titles SET original_language = 'en'`);
  }

  it('reads movies with files and series with episodes, read-only', async () => {
    await withArr();
    radarr.items = [
      { title: 'Knives Out', tmdbId: LIB(1), hasFile: true, added: '2026-10-01T00:00:00Z' },
      { title: 'Wanted, not downloaded', tmdbId: LIB(2), hasFile: false },
    ];
    sonarr.items = [
      { title: 'The Bear', tmdbId: LIB(3), tvdbId: 1, added: '2026-11-01T00:00:00Z', statistics: { episodeFileCount: 18 } },
      { title: 'Monitored only', tmdbId: LIB(4), tvdbId: 2, statistics: { episodeFileCount: 0 } },
    ];
    tmdb.recs.set(`movie:${LIB(1)}`, [netflix[0]!.tmdb_id]);
    const r = await app.library();
    expect(r).toMatchObject({ library: 2, sources: { radarr: 1, sonarr: 1, seerr: 0 } });
    expect(all(app.db, 'SELECT media_type, title, source FROM library_items ORDER BY title')).toEqual([
      { media_type: 'movie', title: 'Knives Out', source: 'radarr' },
      { media_type: 'tv', title: 'The Bear', source: 'sonarr' },
    ]);
    expect([...radarr.calls, ...sonarr.calls].every((c) => c.startsWith('GET '))).toBe(true);
  });

  it('finds TMDB IDs for series Sonarr only knows by TVDB ID', async () => {
    await withArr();
    sonarr.items = [{ title: 'Old Sonarr show', tvdbId: 81189, statistics: { episodeFileCount: 3 } }];
    tmdb.find.set(81189, LIB(9));
    expect((await app.library()).library).toBe(1);
    expect(get<{ tmdb_id: number }>(app.db, `SELECT tmdb_id FROM library_items WHERE source = 'sonarr'`)!.tmdb_id).toBe(LIB(9));
  });

  it('keeps the last known library when Radarr is down', async () => {
    await withArr();
    radarr.items = [{ title: 'Knives Out', tmdbId: LIB(1), hasFile: true }];
    await app.library();
    radarr.fail = true;
    const r = await app.library();
    expect(r.sources.radarr).toBe('error');
    expect(r).toMatchObject({ library: 1, removed: 0 });
  });
});

describe('ranking', () => {
  it('skips weak titles and favours recent ones', async () => {
    const recent = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    run(app.db, `UPDATE titles SET vote_average = 7, vote_count = 500, release_date = '2005-01-01', last_air_date = NULL`);
    run(app.db, 'UPDATE titles SET vote_average = 5.8 WHERE id = ?', [netflix[0]!.id]);              // rank 1, but weak
    run(app.db, 'UPDATE titles SET release_date = ? WHERE id = ?', [recent, netflix[3]!.id]);       // rank 3, but new
    await library([{ n: 1, recs: [0, 1, 2, 3] }]);
    const ids = (await j<BrowseResponse>('/api/titles?theme=for-you')).items.map((i) => i.id);
    expect(ids).not.toContain(netflix[0]!.id);
    expect(ids[0]).toBe(netflix[3]!.id);          // (21-4)/20 x 1.5 = 1.275 beats (21-2)/20 = 0.95
  });
});

describe('discovery tweaks', () => {
  const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  it('drops titles over 10 years old unless rated 7.5 or higher', async () => {
    run(app.db, `UPDATE titles SET vote_average = 7, vote_count = 500, release_date = ?, last_air_date = NULL`, [days(400)]);
    run(app.db, `UPDATE titles SET release_date = '1982-05-14', vote_average = 6.8 WHERE id = ?`, [netflix[0]!.id]);   // Conan
    run(app.db, `UPDATE titles SET release_date = '1997-02-28', vote_average = 7.5 WHERE id = ?`, [netflix[1]!.id]);   // Donnie Brasco
    await library([{ n: 1, recs: [0, 1, 2] }]);
    const ids = (await j<BrowseResponse>('/api/titles?theme=for-you')).items.map((i) => i.id);
    expect(ids).not.toContain(netflix[0]!.id);
    expect(ids).toContain(netflix[1]!.id);
    expect(ids).toContain(netflix[2]!.id);
  });

  it('mixes "Because you have" rows: at most one stand-up special, then a series and a movie', async () => {
    run(app.db, `UPDATE titles SET vote_average = 7, vote_count = 500, release_date = ?`, [days(100)]);
    const recs = (from: number) => Array.from({ length: 7 }, (_, i) => from + i);
    // Three stand-up specials with the most matches, one series, one film.
    seerr.media = [
      ...[1, 2, 3].map((n) => ({ id: n, mediaType: 'movie', tmdbId: LIB(n), status: 5, seasons: [], updatedAt: `2026-11-1${n}T00:00:00Z` })),
      { id: 4, mediaType: 'tv', tmdbId: LIB(4), status: 5, seasons: [], updatedAt: '2026-11-05T00:00:00Z' },
      { id: 5, mediaType: 'movie', tmdbId: LIB(5), status: 5, seasons: [], updatedAt: '2026-11-04T00:00:00Z' },
    ];
    for (const n of [1, 2, 3]) {
      tmdb.recs.set(`movie:${LIB(n)}`, recs(0).map((i) => netflix[i]!.tmdb_id));
      tmdb.overrides.set(`movie:${LIB(n)}`, { title: `Comic ${n}: Live`, genres: [{ id: 35, name: 'Comedy' }], runtime: 62, keywords: { keywords: [{ id: 9716, name: 'stand-up comedy' }] } });
    }
    tmdb.overrides.set(`tv:${LIB(4)}`, { name: 'Severance' });
    tmdb.recs.set(`tv:${LIB(4)}`, recs(0).map((i) => netflix[i]!.tmdb_id));       // same ids, but tv type: no Netflix match
    tmdb.overrides.set(`movie:${LIB(5)}`, { title: 'Knives Out', genres: [{ id: 80, name: 'Crime' }], runtime: 130, keywords: { keywords: [] } });
    tmdb.recs.set(`movie:${LIB(5)}`, recs(10).map((i) => netflix[i]!.tmdb_id));
    await app.mirror();
    await app.library();
    expect(all(app.db, 'SELECT title, category FROM library_items ORDER BY title').map((r) => (r as { category: string }).category))
      .toEqual(['standup', 'standup', 'standup', 'movie', 'series']);
    const rows = (await j<HomeResponse>('/api/home')).rows.filter((r) => r.slug.startsWith('because-')).map((r) => r.title);
    expect(rows.filter((t) => t.includes('Comic'))).toHaveLength(1);
    expect(rows).toContain('Because you have Knives Out');
  });
});
