import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp, type App } from '../app.js';
import { createServer } from '../server.js';
import { testConfig, type Config } from '../config.js';
import { all, get, run } from '../db/db.js';
import { FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';
import { resetSeerrSettingsCache, seasonStates } from '../seerr/requests.js';
import type { BrowseResponse, MetaResponse, SeasonsResponse, TitleDetail } from './types.js';

let app: App;
let seerr: FakeSeerr;
let http: ReturnType<typeof createServer>;

async function setup(overrides: Partial<Record<keyof Config, string>> = {}) {
  resetSeerrSettingsCache();
  const catalog = realCatalog().filter((t) => t.tmdb_id).filter((_, i) => i % 40 === 0).slice(0, 120);
  seerr = new FakeSeerr([]);
  app = createApp(testConfig(overrides), { watchmode: new FakeWatchmode(catalog).fetch, tmdb: new FakeTmdb().fetch, seerr: seerr.fetch });
  http = createServer(app, { webDir: null });
  open = true;
  await app.pipeline('cli');
  run(app.db, `UPDATE titles SET original_language = 'en'`);
}

const pick = (kind: 'movie' | 'series') =>
  get<{ id: number; tmdb_id: number }>(app.db, `SELECT tk.id, tk.tmdb_id FROM title_kinds tk JOIN availability a ON a.title_id = tk.id
    WHERE tk.kind = ? AND tk.tmdb_id IS NOT NULL ORDER BY tk.id LIMIT 1`, [kind])!;

const post = (path: string, body: unknown = {}, passcode?: string) => http.request(path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(passcode ? { 'x-passcode': passcode } : {}) }, body: JSON.stringify(body),
});

let open = false;
afterEach(() => { if (open) app.close(); open = false; });

describe('requests', () => {
  beforeEach(() => setup({ APP_PASSCODE: 'monkey' }));

  it('needs the passcode, and meta says so', async () => {
    const meta = (await (await http.request('/api/meta')).json()) as MetaResponse;
    expect(meta.passcodeRequired).toBe(true);
    const movie = pick('movie');
    expect((await post(`/api/titles/${movie.id}/request`)).status).toBe(401);
    expect((await post(`/api/titles/${movie.id}/request`, {}, 'wrong!')).status).toBe(401);
    expect((await post('/api/passcode/check', {}, 'monkey')).status).toBe(200);
    expect(seerr.requests).toHaveLength(0);
  });

  it('locks out an address after 10 wrong passcodes', async () => {
    for (let i = 0; i < 10; i++) expect((await post('/api/passcode/check', {}, `nope${i}`)).status).toBe(401);
    expect((await post('/api/passcode/check', {}, 'monkey')).status).toBe(429);
  });

  it('requests a title that is only on another service (not Netflix)', async () => {
    const movie = pick('movie');
    // Move it from Netflix to Prime Video, like Madden on Prime.
    run(app.db, `UPDATE availability SET provider_id = 1026 WHERE title_id = ?`, [movie.id]);
    const r = await post(`/api/titles/${movie.id}/request`, {}, 'monkey');
    expect(r.status).toBe(201);
    expect(seerr.requests).toEqual([expect.objectContaining({ mediaType: 'movie', mediaId: movie.tmdb_id })]);
  });

  it('requests a movie and shows it as requested at once', async () => {
    const movie = pick('movie');
    const r = await post(`/api/titles/${movie.id}/request`, {}, 'monkey');
    expect(r.status).toBe(201);
    expect(((await r.json()) as { message: string }).message).toMatch(/^Requested /);
    expect(seerr.requests).toEqual([expect.objectContaining({ mediaType: 'movie', mediaId: movie.tmdb_id, is4k: false })]);
    expect(seerr.requests[0]!.seasons).toBeUndefined();
    const detail = (await (await http.request(`/api/titles/${movie.id}`)).json()) as TitleDetail;
    expect(detail.seerr).toBe('requested');
  });

  it('requests every open season of a series by default, and only the chosen ones when asked', async () => {
    const series = pick('series');
    const before = (await (await http.request(`/api/titles/${series.id}/seasons`)).json()) as SeasonsResponse;
    expect(before.seasons.map((s) => s.seasonNumber)).toEqual([1, 2, 3]);       // specials hidden
    expect(before.seasons.every((s) => s.state === null)).toBe(true);

    const r1 = await post(`/api/titles/${series.id}/request`, { seasons: [2] }, 'monkey');
    expect(r1.status).toBe(201);
    expect(seerr.requests[0]).toMatchObject({ mediaType: 'tv', mediaId: series.tmdb_id, seasons: [2] });

    const mid = (await (await http.request(`/api/titles/${series.id}/seasons`)).json()) as SeasonsResponse;
    expect(mid.seasons.map((s) => s.state)).toEqual([null, 'requested', null]);

    const r2 = await post(`/api/titles/${series.id}/request`, {}, 'monkey');
    expect(r2.status).toBe(201);
    expect(seerr.requests[1]!.seasons).toEqual([1, 3]);

    const r3 = await post(`/api/titles/${series.id}/request`, {}, 'monkey');
    expect(r3.status).toBe(409);
    expect(((await r3.json()) as { code: string }).code).toBe('nothing_left');
  });

  it('rejects seasons that do not exist', async () => {
    const series = pick('series');
    const r = await post(`/api/titles/${series.id}/request`, { seasons: [9] }, 'monkey');
    expect(r.status).toBe(400);
    expect(seerr.requests).toHaveLength(0);
  });

  it('passes on Seerr refusals and outages as clear errors', async () => {
    const movie = pick('movie');
    seerr.nextRequestStatus = 403;
    const r403 = await post(`/api/titles/${movie.id}/request`, {}, 'monkey');
    expect(r403.status).toBe(403);
    expect(((await r403.json()) as { error: string }).error).toContain('Quota exceeded');

    seerr.nextRequestStatus = 409;
    expect((await post(`/api/titles/${movie.id}/request`, {}, 'monkey')).status).toBe(409);

    seerr.fail = true;
    const r502 = await post(`/api/titles/${movie.id}/request`, {}, 'monkey');
    expect(r502.status).toBe(502);
    expect(((await r502.json()) as { code: string }).code).toBe('seerr_unreachable');
    const sm = all(app.db, 'SELECT * FROM seerr_media');
    expect(sm).toHaveLength(0);                         // nothing marked requested on failure
  });

  it('does not retry a POST that failed upstream', async () => {
    const movie = pick('movie');
    seerr.nextRequestStatus = 500;
    expect((await post(`/api/titles/${movie.id}/request`, {}, 'monkey')).status).toBe(502);
    expect(seerr.requests).toHaveLength(0);
  });

  it('hide=have drops titles already in Seerr', async () => {
    const movie = pick('movie');
    const all1 = (await (await http.request('/api/titles?kind=movie')).json()) as BrowseResponse;
    await post(`/api/titles/${movie.id}/request`, {}, 'monkey');
    const hidden = (await (await http.request('/api/titles?kind=movie&hide=have')).json()) as BrowseResponse;
    expect(hidden.total).toBe(all1.total - 1);
    const shown = (await (await http.request('/api/titles?kind=movie')).json()) as BrowseResponse;
    expect(shown.total).toBe(all1.total);
  });
});

describe('requests without a passcode or with a Seerr user', () => {
  it('is open when APP_PASSCODE is unset', async () => {
    await setup();
    const meta = (await (await http.request('/api/meta')).json()) as MetaResponse;
    expect(meta.passcodeRequired).toBe(false);
    expect((await post(`/api/titles/${pick('movie').id}/request`)).status).toBe(201);
    expect(seerr.requests[0]!.headers['x-api-user']).toBeUndefined();
  });

  it('sends X-API-User when SEERR_USER_ID is set', async () => {
    await setup({ SEERR_USER_ID: '4' });
    expect((await post(`/api/titles/${pick('movie').id}/request`)).status).toBe(201);
    expect(seerr.requests[0]!.headers['x-api-user']).toBe('4');
  });
});

describe('seasonStates', () => {
  const settings = { partialRequestsEnabled: true, enableSpecialEpisodes: false };
  const seasons = [0, 1, 2, 3, 4].map((n) => ({ seasonNumber: n, episodeCount: 10, name: n ? `Season ${n}` : 'Specials' }));
  it('merges media status with open requests and skips declined and 4K ones', () => {
    const out = seasonStates({
      id: 1, seasons,
      mediaInfo: {
        status: 4,
        seasons: [{ seasonNumber: 1, status: 5 }, { seasonNumber: 2, status: 3 }],
        requests: [
          { status: 2, is4k: false, seasons: [{ seasonNumber: 3, status: 2 }] },
          { status: 3, is4k: false, seasons: [{ seasonNumber: 4, status: 1 }] },   // declined
          { status: 1, is4k: true, seasons: [{ seasonNumber: 4, status: 1 }] },    // 4K
        ],
      },
    }, settings);
    expect(out.map((s) => [s.seasonNumber, s.state])).toEqual([[1, 'available'], [2, 'processing'], [3, 'requested'], [4, null]]);
  });
  it('includes specials when Seerr allows them', () => {
    expect(seasonStates({ id: 1, seasons, mediaInfo: null }, { ...settings, enableSpecialEpisodes: true })[0]!.name).toBe('Specials');
  });
});
