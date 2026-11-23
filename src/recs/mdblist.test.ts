import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp, type App } from '../app.js';
import { createServer } from '../server.js';
import { testConfig } from '../config.js';
import { all, run } from '../db/db.js';
import { FakeMdbList, FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';
import type { BrowseResponse, HomeResponse, ListSearchResponse, ListsResponse } from '../api/types.js';

let app: App;
let http: ReturnType<typeof createServer>;
let mdb: FakeMdbList;
let ours: { id: number; tmdb_id: number; tmdb_type: string; title: string }[];
const j = async <T>(path: string) => { const r = await http.request(path); expect(r.status).toBe(200); return (await r.json()) as T; };
const post = (path: string, body: unknown, passcode?: string) => http.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(passcode ? { 'x-passcode': passcode } : {}) }, body: JSON.stringify(body) });

beforeAll(async () => {
  const catalog = realCatalog().filter((t) => t.tmdb_id).filter((_, i) => i % 30 === 0).slice(0, 40);
  mdb = new FakeMdbList();
  app = createApp(testConfig({ APP_PASSCODE: 'monkey', MDBLIST_API_KEY: 'mdb-key' }),
    { watchmode: new FakeWatchmode(catalog).fetch, tmdb: new FakeTmdb().fetch, seerr: new FakeSeerr([]).fetch, mdblist: mdb.fetch });
  http = createServer(app, { webDir: null });
  await app.pipeline('cli');
  run(app.db, `UPDATE titles SET original_language = 'en'`);
  ours = all(app.db, `SELECT id, tmdb_id, tmdb_type, title FROM title_kinds WHERE tmdb_id IS NOT NULL AND kind IS NOT NULL ORDER BY id LIMIT 5`);
  mdb.lists = [
    { id: 7, name: 'A24 Films', user_name: 'curator', slug: 'a24', items: 120, likes: 900, mediatype: 'movie' },
    { id: 8, name: 'Best TV of the decade', user_name: 'tvfan', slug: 'tv', items: 50, likes: 300, mediatype: 'show' },
  ];
  // Our five catalog titles in reverse order, plus two that aren't on any service.
  mdb.listItems.set(7, [
    ...[...ours].reverse().map((t, i) => ({ id: t.tmdb_id, rank: i + 1, title: t.title, mediatype: t.tmdb_type === 'tv' ? 'show' as const : 'movie' as const })),
    { id: 999999001, rank: 6, title: 'Not here', mediatype: 'movie' }, { id: 999999002, rank: 7, title: 'Nor this', mediatype: 'show' },
  ]);
});
afterAll(() => app.close());

describe('MDBList recommendation lists', () => {
  it('searches lists, top lists when the box is empty', async () => {
    expect((await j<ListSearchResponse>('/api/lists/search?q=a24')).results.map((r) => r.name)).toEqual(['A24 Films']);
    expect((await j<ListSearchResponse>('/api/lists/search')).results.map((r) => r.id)).toEqual([7, 8]);
  });

  it('adds a list behind the passcode and fetches its titles', async () => {
    expect((await post('/api/lists', { id: 7, name: 'A24 Films' })).status).toBe(401);
    const r = await post('/api/lists', { id: 7, name: 'A24 Films', userName: 'curator', items: 120 }, 'monkey');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, list: { id: 7, name: 'A24 Films', inCatalog: 5 } });
    const l = await j<ListsResponse>('/api/lists');
    expect(l).toMatchObject({ configured: true, picked: [{ id: 7, inCatalog: 5, error: null }] });
    expect((await j<ListSearchResponse>('/api/lists/search?q=a24')).results[0]!.picked).toBe(true);
  });

  it('browses a list in its own order, titled after it', async () => {
    const b = await j<BrowseResponse>('/api/titles?list=7');
    expect(b.theme).toMatchObject({ title: 'A24 Films' });
    expect(b.items.map((i) => i.id)).toEqual([...ours].reverse().map((t) => t.id));
  });

  it('shows a Discover row for it', async () => {
    const h = await j<HomeResponse>('/api/home');
    const row = h.rows.find((r) => r.slug === 'list-7');
    expect(row).toMatchObject({ title: 'A24 Films', link: '/browse?list=7&hide=have' });
    expect(row!.items.length).toBe(5);
  });

  it('refreshes daily and records a failure without losing the titles', async () => {
    mdb.key = 'changed';
    await app.refreshLists();
    const l = await j<ListsResponse>('/api/lists');
    expect(l.picked[0]).toMatchObject({ inCatalog: 5 });
    expect(l.picked[0]!.error).toMatch(/mdblist HTTP 403/);
    expect(l.picked[0]!.error).not.toMatch(/mdb-key|changed/);    // the key never lands in the error
    mdb.key = 'mdb-key';
    await app.refreshLists();
    expect((await j<ListsResponse>('/api/lists')).picked[0]!.error).toBeNull();
  });

  it('removes a list and its row', async () => {
    expect((await post('/api/lists/7/remove', {}, 'monkey')).status).toBe(200);
    expect((await j<ListsResponse>('/api/lists')).picked).toEqual([]);
    expect((await j<HomeResponse>('/api/home')).rows.find((r) => r.slug === 'list-7')).toBeUndefined();
  });
});
