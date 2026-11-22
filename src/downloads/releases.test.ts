import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp, type App } from '../app.js';
import { createServer } from '../server.js';
import { testConfig } from '../config.js';
import { get } from '../db/db.js';
import { FakeArrQueue, FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';
import { reasonLabel, summarize } from './releases.js';
import { resetDownloadsCache } from './downloads.js';
import type { DownloadsResponse, ReleasesResponse } from '../api/types.js';

let app: App;
let http: ReturnType<typeof createServer>;
let radarr: FakeArrQueue;
let sonarr: FakeArrQueue;
let movie: { id: number; tmdb_id: number };
const rel = (o: Record<string, unknown>) => ({ guid: 'g', indexerId: 1, indexer: 'Torrentz', title: 'Movie.2026.720p.WEB', size: 2e9, age: 3, seeders: 40,
  quality: { quality: { name: 'WEBDL-720p', resolution: 720 } }, rejected: true, rejections: ['WEBDL-720p is not wanted in profile'], ...o });
const post = (path: string, body: unknown, passcode?: string) => http.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(passcode ? { 'x-passcode': passcode } : {}) }, body: JSON.stringify(body) });

beforeEach(async () => {
  resetDownloadsCache();
  const catalog = realCatalog().filter((t) => t.tmdb_id && t.tmdb_type === 'movie').filter((_, i) => i % 40 === 0).slice(0, 10);
  radarr = new FakeArrQueue(); sonarr = new FakeArrQueue();
  const seerr = new FakeSeerr([]);
  app = createApp(testConfig({ APP_PASSCODE: 'monkey', RADARR_API_KEY: 'r', SONARR_API_KEY: 's' }),
    { watchmode: new FakeWatchmode(catalog).fetch, tmdb: new FakeTmdb().fetch, seerr: seerr.fetch, radarr: radarr.fetch, sonarr: sonarr.fetch });
  http = createServer(app, { webDir: null });
  await app.pipeline('cli');
  movie = get<{ id: number; tmdb_id: number }>(app.db, `SELECT id, tmdb_id FROM title_kinds WHERE kind = 'movie' AND tmdb_id IS NOT NULL ORDER BY id LIMIT 1`)!;
  radarr.library = [{ id: 42, title: 'Stuck', tmdbId: movie.tmdb_id, hasFile: false, isAvailable: true, digitalRelease: '2026-09-01T00:00:00Z' }];
  seerr.requestList = [{ id: 11, status: 2, createdAt: '2026-10-01T00:00:00Z', type: 'movie', seasons: [], media: { tmdbId: movie.tmdb_id, mediaType: 'movie', status: 3 } }];
  radarr.releaseList = [
    rel({ guid: 'a', seeders: 5 }),
    rel({ guid: 'b', seeders: 90, title: 'Movie.2026.720p.AMZN' }),
    rel({ guid: 'c', title: 'Movie.2026.HDCAM', quality: { quality: { name: 'CAM', resolution: 480 } }, rejections: ['CAM is not wanted in profile', 'Language is unknown'] }),
  ];
});
afterEach(() => app.close());

describe('why Not found', () => {
  it('names the reasons in plain words', () => {
    expect(reasonLabel('WEBDL-720p is not wanted in profile')).toBe('Quality isn’t in your profile');
    expect(reasonLabel('Size: 52.1 GB is greater than maximum allowed 30 GB')).toBe('Size outside your limits');
    expect(reasonLabel('Language is not wanted')).toBe('Wrong language');
    const none = summarize([], 'Radarr');
    expect(none.headline).toBe('No releases on your indexers yet');
  });

  it('searches Radarr for the request and says why nothing was taken', async () => {
    const r = (await (await http.request('/api/requests/11/releases')).json()) as ReleasesResponse;
    expect(radarr.releaseQueries).toEqual(['?movieId=42']);
    expect(r.check).toMatchObject({ total: 3, accepted: 0, headline: '3 found, none wanted: quality isn’t in your profile' });
    expect(r.check.reasons[0]).toEqual({ reason: 'Quality isn’t in your profile', count: 3 });
    expect(r.check.qualities).toEqual([{ quality: '720p', count: 2 }, { quality: '480p', count: 1 }]);
    expect(r.releases.map((x) => x.guid)).toEqual(['b', 'c', 'a']);   // most seeders first
    // reused within 30 minutes; ?fresh=1 searches again
    await http.request('/api/requests/11/releases');
    await http.request('/api/requests/11/releases?fresh=1');
    expect(radarr.releaseQueries).toHaveLength(2);
    // and the Downloads row shows the summary
    resetDownloadsCache();
    const d = (await (await http.request('/api/downloads')).json()) as DownloadsResponse;
    expect(d.requests[0]).toMatchObject({ state: 'missing', check: { headline: r.check.headline, accepted: 0 } });
  });

  it('grabs a picked result behind the passcode, even a rejected one', async () => {
    await http.request('/api/requests/11/releases');
    expect((await post('/api/requests/11/grab', { guid: 'b', indexerId: 1 })).status).toBe(401);
    const ok = await post('/api/requests/11/grab', { guid: 'b', indexerId: 1 }, 'monkey');
    expect(ok.status).toBe(200);
    expect(radarr.grabbed).toEqual([{ guid: 'b', indexerId: 1 }]);
    expect((await post('/api/requests/11/grab', { guid: 'zzz', indexerId: 1 }, 'monkey')).status).toBe(410);
  });

  it('daily retry: searches when something is now acceptable, once a week per title', async () => {
    const now = new Date('2026-11-22T09:00:00Z');
    radarr.releaseList.push(rel({ guid: 'd', rejected: false, rejections: [], title: 'Movie.2026.1080p.WEB', quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } } }));
    const r1 = await app.retryNotFound(now);
    expect(r1).toMatchObject({ checked: 1, searched: [expect.any(String)] });
    expect(radarr.commands).toEqual([{ name: 'MoviesSearch', movieIds: [42] }]);
    const r2 = await app.retryNotFound(new Date(now.getTime() + 2 * 86_400_000));
    expect(r2.checked).toBe(0);                                       // checked 2 days ago: not due
    const r3 = await app.retryNotFound(new Date(now.getTime() + 8 * 86_400_000));
    expect(r3.checked).toBe(1);
  });

  it('daily retry: records why when nothing is acceptable, and does not search', async () => {
    const r = await app.retryNotFound(new Date('2026-11-22T09:00:00Z'));
    expect(r).toMatchObject({ checked: 1, searched: [], nothing: [expect.any(String)] });
    expect(radarr.commands).toEqual([]);
  });
});
