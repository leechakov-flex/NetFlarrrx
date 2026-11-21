import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp, type App } from '../app.js';
import { createServer } from '../server.js';
import { testConfig } from '../config.js';
import { all, get, run } from '../db/db.js';
import { FakeJellyfin, FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';
import type { BrowseResponse, CompaniesResponse, HomeResponse, LibraryResponse, TitleDetail } from '../api/types.js';
import { companyGroup, companyKey } from './companies.js';

let app: App;
let http: ReturnType<typeof createServer>;
let jf: FakeJellyfin;
const j = async <T>(path: string) => { const r = await http.request(path); expect(r.status).toBe(200); return (await r.json()) as T; };
let movies: { tmdb_id: number; title: string }[];
let shows: { tmdb_id: number; title: string }[];
const hex = (n: number) => n.toString(16).padStart(32, '0');

beforeAll(async () => {
  const catalog = realCatalog().filter((t) => t.tmdb_id).filter((_, i) => i % 25 === 0).slice(0, 80);
  movies = catalog.filter((t) => t.tmdb_type === 'movie').slice(0, 6).map((t) => ({ tmdb_id: t.tmdb_id!, title: t.title }));
  shows = catalog.filter((t) => t.tmdb_type === 'tv').slice(0, 3).map((t) => ({ tmdb_id: t.tmdb_id!, title: t.title }));
  const tmdb = new FakeTmdb();
  const co = (id: number, name: string) => ({ id, name });
  tmdb.overrides.set(`movie:${movies[0]!.tmdb_id}`, { production_companies: [co(41077, 'A24')] });
  tmdb.overrides.set(`movie:${movies[1]!.tmdb_id}`, { production_companies: [co(41077, 'A24'), co(25, '20th Century Fox')] });
  tmdb.overrides.set(`movie:${movies[2]!.tmdb_id}`, { production_companies: [co(127928, '20th Century Studios')] });
  tmdb.overrides.set(`tv:${shows[0]!.tmdb_id}`, { networks: [co(88, 'FX')] });
  jf = new FakeJellyfin();
  jf.items = [
    { Id: hex(1), Name: movies[3]!.title, Type: 'Movie', ProductionYear: 2020, DateCreated: '2026-11-20T10:00:00Z', ProviderIds: { Tmdb: String(movies[3]!.tmdb_id) }, ImageTags: { Primary: 'x' } },
    { Id: hex(2), Name: 'Home Movie Not On TMDB', Type: 'Movie', ProductionYear: 1999, DateCreated: '2026-11-01T10:00:00Z', ProviderIds: {} },
    { Id: hex(3), Name: shows[1]!.title, Type: 'Series', ChildCount: 3, DateCreated: '2026-11-21T10:00:00Z', ProviderIds: { Tmdb: String(shows[1]!.tmdb_id) } },
  ];
  app = createApp(testConfig({ JELLYFIN_API_KEY: 'jf-key' }), { watchmode: new FakeWatchmode(catalog).fetch, tmdb: tmdb.fetch, seerr: new FakeSeerr([]).fetch, jellyfin: jf.fetch });
  http = createServer(app, { webDir: null });
  await app.pipeline('cli');
  run(app.db, `UPDATE titles SET original_language = 'en'`);
  await app.syncJellyfin();
});
afterAll(() => app.close());
const idOf = (type: string, tmdbId: number) => get<{ id: number }>(app.db, 'SELECT id FROM titles WHERE tmdb_type = ? AND tmdb_id = ?', [type, tmdbId])!.id;

describe('studios and networks', () => {
  it('groups a studio TMDB lists under several names', () => {
    expect(companyGroup('20th Century Fox')).toBe('20th Century');
    expect(companyGroup('20th Century Studios')).toBe('20th Century');
    expect(companyGroup('A24')).toBe('A24');
    expect(companyKey('Metro-Goldwyn-Mayer')).toBe('metro-goldwyn-mayer');
  });

  it('lists studios and networks with counts', async () => {
    const c = await j<CompaniesResponse>('/api/companies');
    expect(c.studios.find((s) => s.key === 'a24')).toEqual({ key: 'a24', name: 'A24', count: 2 });
    expect(c.studios.find((s) => s.key === '20th-century')).toMatchObject({ count: 2 });
    expect(c.networks.find((s) => s.key === 'fx')).toMatchObject({ name: 'FX', count: 1 });
  });

  it('filters browse by studio, network, or either', async () => {
    const ids = async (q: string) => (await j<BrowseResponse>(`/api/titles?${q}`)).items.map((i) => i.id).sort();
    expect(await ids('studios=a24')).toEqual([idOf('movie', movies[0]!.tmdb_id), idOf('movie', movies[1]!.tmdb_id)].sort());
    expect(await ids('studios=20th-century')).toEqual([idOf('movie', movies[1]!.tmdb_id), idOf('movie', movies[2]!.tmdb_id)].sort());
    expect(await ids('studios=a24&networks=fx')).toHaveLength(3);
  });

  it('narrows Discover too', async () => {
    const h = await j<HomeResponse>('/api/home?studios=a24');
    const shown = new Set(h.rows.flatMap((r) => r.items.map((i) => i.id)));
    expect([...shown].every((id) => [idOf('movie', movies[0]!.tmdb_id), idOf('movie', movies[1]!.tmdb_id)].includes(id))).toBe(true);
    expect(h.rows.every((r) => r.link?.includes('studios=a24'))).toBe(true);
  });
});

describe('Jellyfin library', () => {
  it('lists what is in Jellyfin, newest first, with links to titles', async () => {
    const l = await j<LibraryResponse>('/api/library');
    expect(l).toMatchObject({ configured: true, counts: { movie: 2, tv: 1 }, total: 3 });
    expect(l.items.map((i) => i.title)).toEqual([shows[1]!.title, movies[3]!.title, 'Home Movie Not On TMDB']);
    expect(l.items[1]).toMatchObject({ titleId: idOf('movie', movies[3]!.tmdb_id), posterUrl: `/api/library/${hex(1)}/poster` });
    expect(l.items[0]!.seasons).toBe(3);
    expect((await j<LibraryResponse>('/api/library?type=movie&q=home')).items.map((i) => i.title)).toEqual(['Home Movie Not On TMDB']);
  });

  it('passes posters through and caches them', async () => {
    const r = await http.request(`/api/library/${hex(1)}/poster`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(r.headers.get('cache-control')).toBe('private, max-age=86400');
    expect((await http.request('/api/library/not-an-id/poster')).status).toBe(404);
  });

  it('marks titles you have and leaves them out of Discover', async () => {
    const id = idOf('movie', movies[3]!.tmdb_id);
    expect((await j<TitleDetail>(`/api/titles/${id}`)).inLibrary).toBe(true);
    expect((await j<TitleDetail>(`/api/titles/${idOf('movie', movies[0]!.tmdb_id)}`)).inLibrary).toBe(false);
    const h = await j<HomeResponse>('/api/home');
    expect(h.rows.filter((r) => r.slug !== 'coming-soon').flatMap((r) => r.items.map((i) => i.id))).not.toContain(id);
  });

  it('keeps the last list when Jellyfin is unreachable', async () => {
    jf.key = 'changed';
    const r = await app.syncJellyfin();
    expect(r).toMatchObject({ ok: false, movies: 2 });
    expect(all(app.db, 'SELECT 1 FROM jellyfin_items')).toHaveLength(3);
    expect((await j<LibraryResponse>('/api/library')).error).toMatch(/401/);
    jf.key = 'jf-key';
  });
});
