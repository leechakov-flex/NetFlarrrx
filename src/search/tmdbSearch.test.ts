import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp, type App } from '../app.js';
import { createServer } from '../server.js';
import { testConfig } from '../config.js';
import { get } from '../db/db.js';
import { FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';
import { resetSeerrSettingsCache } from '../seerr/requests.js';
import type { TitleCard, TitleDetail } from '../api/types.js';
import { fromTmdbCardId, tmdbCardId } from './tmdbSearch.js';

let app: App;
let http: ReturnType<typeof createServer>;
let seerr: FakeSeerr;
let inCatalog: { tmdb_id: number; tmdb_type: string };
const results = async (q: string) => ((await (await http.request(`/api/search/tmdb?q=${encodeURIComponent(q)}`)).json()) as { items: TitleCard[] }).items;

beforeAll(async () => {
  resetSeerrSettingsCache();
  const catalog = realCatalog().filter((t) => t.tmdb_id).filter((_, i) => i % 40 === 0).slice(0, 40);
  const tmdb = new FakeTmdb();
  seerr = new FakeSeerr([]);
  app = createApp(testConfig({ APP_PASSCODE: 'monkey' }), { watchmode: new FakeWatchmode(catalog).fetch, tmdb: tmdb.fetch, seerr: seerr.fetch });
  http = createServer(app, { webDir: null });
  await app.pipeline('cli');
  inCatalog = get<{ tmdb_id: number; tmdb_type: string }>(app.db, 'SELECT tmdb_id, tmdb_type FROM titles WHERE tmdb_id IS NOT NULL LIMIT 1')!;
  tmdb.searchable = [
    { id: 777001, media_type: 'movie', title: 'Dreamquil', release_date: '2027-03-12', poster_path: '/dq.jpg', popularity: 14.2, vote_count: 0 },
    { id: inCatalog.tmdb_id, media_type: inCatalog.tmdb_type, title: 'Dream in the catalog', name: 'Dream in the catalog', poster_path: '/x.jpg', popularity: 50 },
    { id: 777002, media_type: 'movie', title: 'Dream stub', popularity: 0.3 },              // no poster, no interest
    { id: 888, media_type: 'person', name: 'Dream Person' },                                // not a title
  ];
});
afterAll(() => app.close());

describe('search beyond the catalog (TMDB)', () => {
  it('finds a film not out yet, without catalog titles, stubs or people', async () => {
    const r = await results('dream');
    expect(r.map((x) => x.title)).toEqual(['Dreamquil']);
    expect(r[0]).toMatchObject({ id: tmdbCardId('movie', 777001), kind: 'movie', year: 2027, soon: { date: '2027-03-12', service: null, release: true }, seerr: null, services: [] });
  });

  it('ignores one-letter searches', async () => {
    expect(await results('d')).toEqual([]);
  });

  it('encodes type and TMDB ID in a negative card ID', () => {
    expect(fromTmdbCardId(tmdbCardId('movie', 777001))).toEqual({ type: 'movie', tmdbId: 777001 });
    expect(fromTmdbCardId(tmdbCardId('tv', 42))).toEqual({ type: 'tv', tmdbId: 42 });
    expect(fromTmdbCardId(5)).toBeNull();
  });

  it('opens a title page built from TMDB', async () => {
    const r = await http.request(`/api/titles/${tmdbCardId('movie', 777001)}`);
    expect(r.status).toBe(200);
    const d = (await r.json()) as TitleDetail;
    expect(d).toMatchObject({ id: tmdbCardId('movie', 777001), tmdbId: 777001, tmdbType: 'movie', watch: { services: [] } });
  });

  it('requests it through the normal route behind the passcode, then shows it as requested', async () => {
    const path = `/api/titles/${tmdbCardId('movie', 777001)}/request`;
    const req = (passcode?: string) => http.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(passcode ? { 'x-passcode': passcode } : {}) }, body: '{}' });
    expect((await req()).status).toBe(401);
    const r = await req('monkey');
    expect(r.status).toBe(201);
    expect(((await r.json()) as { message: string }).message).toMatch(/^Requested /);
    expect(seerr.requests.at(-1)).toMatchObject({ mediaType: 'movie', mediaId: 777001 });
    expect((await results('dream'))[0]!.seerr).toBe('requested');
  });
});
