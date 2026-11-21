import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp, type App } from '../app.js';
import { createServer } from '../server.js';
import { testConfig } from '../config.js';
import { get, run } from '../db/db.js';
import { FakeArrQueue, FakeQbit, FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';
import { resetDownloadsCache, stateOf } from './downloads.js';
import { newSeason } from '../catalog/newSeasons.js';
import type { DownloadsResponse, MetaResponse, TitleDetail } from '../api/types.js';

let app: App;
let http: ReturnType<typeof createServer>;
let qbit: FakeQbit;
let radarr: FakeArrQueue;
let sonarr: FakeArrQueue;
let seerr: FakeSeerr;
let movie: { id: number; tmdb_id: number };
const now = Date.now();
const secsAgo = (h: number) => Math.round((now - h * 3600_000) / 1000);
const torrent = (hash: string, state: string, progress: number, extra: Record<string, unknown> = {}) =>
  ({ hash, name: `${hash}.mkv`, state, progress, dlspeed: state === 'downloading' ? 1_000_000 : 0, eta: 600, size: 4e9, num_seeds: 3, num_leechs: 1, added_on: secsAgo(5), last_activity: secsAgo(0), ...extra });
const post = (path: string, passcode?: string) => http.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(passcode ? { 'x-passcode': passcode } : {}) }, body: '{}' });

beforeEach(async () => {
  resetDownloadsCache();
  const catalog = realCatalog().filter((t) => t.tmdb_id && t.tmdb_type === 'movie').filter((_, i) => i % 40 === 0).slice(0, 20);
  qbit = new FakeQbit(); radarr = new FakeArrQueue(); sonarr = new FakeArrQueue(); seerr = new FakeSeerr([]);
  app = createApp(testConfig({ APP_PASSCODE: 'monkey', QBIT_PASSWORD: 'qbit-pass', RADARR_API_KEY: 'r', SONARR_API_KEY: 's' }),
    { watchmode: new FakeWatchmode(catalog).fetch, tmdb: new FakeTmdb().fetch, seerr: seerr.fetch, qbit: qbit.fetch, radarr: radarr.fetch, sonarr: sonarr.fetch });
  http = createServer(app, { webDir: null });
  await app.pipeline('cli');
  movie = get<{ id: number; tmdb_id: number }>(app.db, `SELECT id, tmdb_id FROM title_kinds WHERE kind = 'movie' AND tmdb_id IS NOT NULL ORDER BY id LIMIT 1`)!;

  qbit.torrents = [
    torrent('aaa', 'stalledDL', 0.41, { last_activity: secsAgo(3) }),
    torrent('bbb', 'downloading', 0.72),
    torrent('ccc', 'uploading', 1),
    torrent('ddd', 'queuedDL', 0),
  ];
  radarr.records = [{ downloadId: 'AAA', status: 'downloading', trackedDownloadStatus: 'ok', size: 4e9, sizeleft: 2e9,
    movie: { title: 'Stuck Movie', year: 2024, tmdbId: movie.tmdb_id, images: [] } }];
  sonarr.records = [{ downloadId: 'BBB', status: 'downloading', trackedDownloadStatus: 'ok', size: 1e9, sizeleft: 3e8,
    series: { title: 'Some Show', year: 2019, tmdbId: 777, images: [{ coverType: 'poster', remoteUrl: 'https://img/p.jpg' }] },
    episode: { seasonNumber: 2, episodeNumber: 5, title: 'Pilot' } }];
  seerr.requestList = [
    { id: 11, status: 2, createdAt: '2026-11-20T10:00:00Z', type: 'movie', seasons: [], media: { tmdbId: movie.tmdb_id, mediaType: 'movie', status: 3 } },
    { id: 12, status: 4, createdAt: '2026-11-19T10:00:00Z', type: 'movie', seasons: [], media: { tmdbId: movie.tmdb_id + 1, mediaType: 'movie', status: 2 } },
    { id: 13, status: 5, createdAt: '2026-11-18T10:00:00Z', type: 'tv', seasons: [{ seasonNumber: 1 }], media: { tmdbId: 778, mediaType: 'tv', status: 5 } },
  ];
});
afterEach(() => app.close());

describe('downloads', () => {
  it('maps qBittorrent states', () => {
    expect(stateOf({ state: 'stalledDL', progress: 0.2 })).toBe('stalled');
    expect(stateOf({ state: 'metaDL', progress: 0 })).toBe('metadata');
    expect(stateOf({ state: 'forcedDL', progress: 0.2 })).toBe('downloading');
    expect(stateOf({ state: 'stalledUP', progress: 1 })).toBeNull();
    expect(stateOf({ state: 'missingFiles', progress: 1 })).toBe('error');
  });

  it('merges torrents with the Radarr and Sonarr queues and your requests', async () => {
    const d = (await (await http.request('/api/downloads')).json()) as DownloadsResponse;
    expect(d.qbit).toMatchObject({ configured: true, connected: true, seeding: 1, vpn: 'connected', downSpeed: 2_500_000 });
    expect(d.attention).toEqual([expect.objectContaining({ hash: 'AAA', state: 'stalled', title: 'Stuck Movie', titleId: movie.id, source: 'radarr' })]);
    expect(Date.parse(d.attention[0]!.since!)).toBeCloseTo(now - 3 * 3600_000, -4);
    expect(d.downloading).toEqual([expect.objectContaining({ hash: 'BBB', title: 'Some Show', subtitle: 'S2 E5 · Pilot', posterUrl: 'https://img/p.jpg', etaSeconds: 600 })]);
    expect(d.queued.map((q) => q.hash)).toEqual(['DDD']);
    expect(d.requests.map((r) => [r.id, r.state])).toEqual([[11, 'downloading'], [12, 'failed'], [13, 'available']]);
    expect(d.requests[0]).toMatchObject({ titleId: movie.id, progress: 0.41 });
    expect(qbit.logins).toBe(1);   // torrents and transfer share one login
  });

  it('marks a request available once Radarr or Sonarr has the files, before Seerr catches up', async () => {
    radarr.library = [{ title: 'Got It', tmdbId: movie.tmdb_id + 1, hasFile: true, added: '2026-11-21T00:00:00Z' }];
    sonarr.library = [{ title: 'Show', tmdbId: 778, tvdbId: 1, statistics: { episodeFileCount: 10 }, seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 10 } }] }];
    seerr.requestList.push({ id: 14, status: 2, createdAt: '2026-11-18T10:00:00Z', type: 'tv', seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }], media: { tmdbId: 778, mediaType: 'tv', status: 3 } });
    seerr.requestList[1]!.status = 2;   // 12: approved, not failed
    const d = (await (await http.request('/api/downloads')).json()) as DownloadsResponse;
    expect(d.requests.find((r) => r.id === 12)).toMatchObject({ state: 'available', detail: expect.stringMatching(/Downloaded/) });
    expect(d.requests.find((r) => r.id === 14)).toMatchObject({ state: 'requested', detail: 'Have season 1 · Sonarr is looking for the rest' });
    expect(d.qbit.states).toEqual({ stalledDL: 1, downloading: 1, uploading: 1, queuedDL: 1 });
  });

  it('still shows requests when qBittorrent is down', async () => {
    qbit.down = true;
    const d = (await (await http.request('/api/downloads')).json()) as DownloadsResponse;
    expect(d.qbit).toMatchObject({ configured: true, connected: false });
    expect(d.errors).toContain('qBittorrent');
    expect(d.requests).toHaveLength(3);
  });

  it('says when the qBittorrent password is wrong, and backs off instead of retrying', async () => {
    qbit.password = 'something-else';
    const d = (await (await http.request('/api/downloads')).json()) as DownloadsResponse;
    expect(d.qbit.error).toMatch(/username or password is wrong/);
    resetDownloadsCache();
    await http.request('/api/downloads');
    expect(qbit.logins).toBe(1);    // second look didn't try again (qBittorrent bans after 5 failures)
  });

  it('logs in to qBittorrent 5 (204, no body)', async () => {
    qbit.v5 = true;
    const d = (await (await http.request('/api/downloads')).json()) as DownloadsResponse;
    expect(d.qbit.connected).toBe(true);
    expect(d.attention).toHaveLength(1);
  });

  it('logs in with Referer when qBittorrent’s cross-site check wants it', async () => {
    qbit.requireReferer = true;
    const d = (await (await http.request('/api/downloads')).json()) as DownloadsResponse;
    expect(d.qbit.connected).toBe(true);
    expect(qbit.logins).toBe(2);
  });

  it('shows download progress on the title page', async () => {
    run(app.db, `INSERT INTO seerr_media (media_type, tmdb_id, seerr_id, status, updated_at, mirrored_at) VALUES ('movie', ?, 1, 3, '', '')`, [movie.tmdb_id]);
    const t = (await (await http.request(`/api/titles/${movie.id}`)).json()) as TitleDetail;
    expect(t.download).toMatchObject({ state: 'stalled', progress: 0.41 });
  });

  it('alerts on a download stuck past STALL_ALERT_HOURS, not before', async () => {
    await app.watchDownloads(new Date(now));
    expect(app.problems(new Date(now)).map((p) => p.key)).toContain('download:AAA');
    const meta = (await (await http.request('/api/meta')).json()) as MetaResponse;
    expect(meta.downloads).toEqual({ configured: true, attention: 1, downloading: 1 });

    qbit.torrents[0] = torrent('aaa', 'stalledDL', 0.41, { last_activity: secsAgo(1) });
    await app.watchDownloads(new Date(now));
    expect(app.problems(new Date(now)).map((p) => p.key)).not.toContain('download:AAA');
  });

  it('cancels and retries requests behind the passcode', async () => {
    expect((await post('/api/requests/12/retry')).status).toBe(401);
    expect((await post('/api/requests/12/retry', 'monkey')).status).toBe(200);
    expect((await post('/api/requests/11/cancel', 'monkey')).status).toBe(200);
    expect((await post('/api/requests/99/cancel', 'monkey')).status).toBe(404);
    expect(seerr.actions).toEqual(['retry 12', 'DELETE 11']);
  });
});

describe('new seasons', () => {
  const base = { haveSeason: 2, monitoredJson: '[1,2]', seasons: 3, lastAirDate: new Date(now - 10 * 86_400_000).toISOString().slice(0, 10), seerrSeasonsJson: null };
  it('flags a new season you have not got or asked for', () => {
    expect(newSeason(base, new Date(now))).toEqual({ season: 3, haveThrough: 2 });
  });
  it('stays quiet when Sonarr will grab it, it is requested, you have it, or it is old', () => {
    expect(newSeason({ ...base, monitoredJson: '[1,2,3]' }, new Date(now))).toBeNull();
    expect(newSeason({ ...base, seerrSeasonsJson: '[{"seasonNumber":3,"status":2}]' }, new Date(now))).toBeNull();
    expect(newSeason({ ...base, haveSeason: 3 }, new Date(now))).toBeNull();
    expect(newSeason({ ...base, lastAirDate: '2025-01-01' }, new Date(now))).toBeNull();
    expect(newSeason({ ...base, haveSeason: null }, new Date(now))).toBeNull();
  });
});
