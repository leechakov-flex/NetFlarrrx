import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp, type App } from '../app.js';
import { createServer } from '../server.js';
import { testConfig } from '../config.js';
import { get } from '../db/db.js';
import { FakeArrQueue, FakeJellyfin, FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';

let app: App;
let http: ReturnType<typeof createServer>;
let radarr: FakeArrQueue, sonarr: FakeArrQueue, jf: FakeJellyfin, seerr: FakeSeerr;
const hex = (n: number) => n.toString(16).padStart(32, '0');
const post = (path: string, passcode?: string) => http.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(passcode ? { 'x-passcode': passcode } : {}) }, body: '{}' });
let a: { tmdb_id: number }, b: { tmdb_id: number };

beforeEach(async () => {
  const catalog = realCatalog().filter((t) => t.tmdb_id && t.tmdb_type === 'movie').filter((_, i) => i % 40 === 0).slice(0, 6);
  [a, b] = catalog.map((t) => ({ tmdb_id: t.tmdb_id! })) as [typeof a, typeof b];
  radarr = new FakeArrQueue(); sonarr = new FakeArrQueue(); jf = new FakeJellyfin();
  radarr.library = [{ id: 42, title: 'A', tmdbId: a.tmdb_id, hasFile: true }];
  seerr = new FakeSeerr([{ id: 501, mediaType: 'movie', tmdbId: a.tmdb_id, status: 5, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' }]);
  jf.items = [
    { Id: hex(1), Name: 'A', Type: 'Movie', ProviderIds: { Tmdb: String(a.tmdb_id) } },
    { Id: hex(2), Name: 'B (not in Radarr)', Type: 'Movie', ProviderIds: { Tmdb: String(b.tmdb_id) } },
  ];
  app = createApp(testConfig({ APP_PASSCODE: 'monkey', RADARR_API_KEY: 'r', SONARR_API_KEY: 's', JELLYFIN_API_KEY: 'jf-key' }),
    { watchmode: new FakeWatchmode(catalog).fetch, tmdb: new FakeTmdb().fetch, seerr: seerr.fetch, radarr: radarr.fetch, sonarr: sonarr.fetch, jellyfin: jf.fetch });
  http = createServer(app, { webDir: null });
  await app.pipeline('cli');
  await app.syncJellyfin();
});
afterEach(() => app.close());

describe('remove from library', () => {
  it('needs the passcode', async () => {
    expect((await post(`/api/library/${hex(1)}/remove`)).status).toBe(401);
    expect(radarr.deleted).toEqual([]);
  });

  it('deletes through Radarr (files, stop watching), clears Seerr, drops it locally, rescans Jellyfin', async () => {
    const r = await post(`/api/library/${hex(1)}/remove`, 'monkey');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, title: 'A', via: 'radarr', seerrCleared: true });
    expect(radarr.deleted).toEqual(['/api/v3/movie/42?deleteFiles=true&addImportExclusion=false']);
    expect(seerr.actions).toContain('DELETE media 501');
    expect(jf.deleted).toEqual([]);                                   // Radarr handled the files
    expect(get(app.db, 'SELECT 1 x FROM jellyfin_items WHERE jellyfin_id = ?', [hex(1)])).toBeUndefined();
    expect(get(app.db, 'SELECT 1 x FROM seerr_media WHERE tmdb_id = ?', [a.tmdb_id])).toBeUndefined();
    await new Promise((res) => setTimeout(res, 10));
    expect(jf.refreshes).toBe(1);
  });

  it('falls back to Jellyfin for something Radarr doesn’t manage', async () => {
    const r = await post(`/api/library/${hex(2)}/remove`, 'monkey');
    expect(await r.json()).toMatchObject({ ok: true, via: 'jellyfin', seerrCleared: false });
    expect(jf.deleted).toEqual([hex(2)]);
    expect(radarr.deleted).toEqual([]);
  });

  it('404s for something no longer there, and deletes nothing', async () => {
    expect((await post(`/api/library/${hex(9)}/remove`, 'monkey')).status).toBe(404);
    expect(radarr.deleted).toEqual([]); expect(jf.deleted).toEqual([]);
  });
});
