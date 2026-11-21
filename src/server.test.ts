import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from './app.js';
import { createServer } from './server.js';
import { testConfig } from './config.js';
import { run } from './db/db.js';
import { FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from './test-support/fakes.js';

let app: App;
let wm: FakeWatchmode;
const hour = 3600_000;
const j = async (r: Response) => (await r.json()) as any;

function make(passcode?: string) {
  wm = new FakeWatchmode(realCatalog().slice(0, 600));
  app = createApp(testConfig(passcode ? { APP_PASSCODE: passcode } : {}), {
    watchmode: wm.fetch, tmdb: new FakeTmdb().fetch, seerr: new FakeSeerr().fetch,
  });
  return createServer(app, { webDir: null });
}

afterEach(() => app?.close());

describe('health', () => {
  it('is "starting" before the first sync, then "ok" after the pipeline', async () => {
    const http = make();
    let res = await http.request('/healthz');
    expect(res.status).toBe(200);
    expect((await j(res)).status).toBe('starting');

    const out = await app.pipeline('cli');
    expect('busy' in out).toBe(false);
    res = await http.request('/healthz');
    const body = await j(res);
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.stats.on_service).toBe(600);
    expect(body.stats.enrichment.pending).toBe(0);
    expect(body.seerr_mirror.ok).toBe(true);
  });

  it('turns 503 when the last applied sync is over 36 hours old', async () => {
    make();
    await app.pipeline('cli');
    expect(app.health(new Date(Date.now() + 37 * hour))).toMatchObject({ ok: false, status: 'stale' });
  });

  it('turns 503 "held" when a run is waiting for confirmation', async () => {
    const http = make();
    await app.pipeline('cli');
    wm.catalog = wm.catalog.slice(0, 300);
    await app.pipeline('cli');
    const res = await http.request('/healthz');
    expect(res.status).toBe(503);
    expect((await j(res)).status).toBe('held');
  });

  it('reports "failing" after the grace period when syncs keep failing', () => {
    make();
    run(app.db, `INSERT INTO sync_runs (provider_id, region, trigger, status, started_at, note) VALUES (203, 'US', 'cli', 'failed', ?, 'auth failed')`,
      [new Date().toISOString()]);
    expect(app.health(new Date(Date.now() + 4 * hour))).toMatchObject({ ok: false, status: 'failing' });
  });

  it('never runs two pipelines at once', async () => {
    make();
    const [a, b] = await Promise.all([app.pipeline('cli'), app.pipeline('cli')]);
    expect([a, b].filter((x) => 'busy' in x)).toHaveLength(1);
  });
});

describe('admin endpoints', () => {
  it('require the passcode when one is set', async () => {
    const http = make('open-sesame');
    expect((await http.request('/api/admin/sync', { method: 'POST' })).status).toBe(401);
    expect((await http.request('/api/admin/sync', { method: 'POST', headers: { 'x-passcode': 'wrong' } })).status).toBe(401);
    const ok = await http.request('/api/admin/sync', { method: 'POST', headers: { 'x-passcode': 'open-sesame' } });
    expect(ok.status).toBe(202);
  });

  it('confirm releases a held run', async () => {
    const http = make('pw');
    await app.pipeline('cli');
    wm.catalog = wm.catalog.slice(0, 300);
    const out = await app.pipeline('cli');
    const heldId = 'sync' in out ? out.sync.id : -1;
    const res = await http.request(`/api/admin/sync-runs/${heldId}/confirm`, { method: 'POST', headers: { 'x-passcode': 'pw' } });
    expect(res.status).toBe(200);
    expect(await j(res)).toMatchObject({ status: 'complete', applied: 1, missed: 300 });
    expect(app.health().status).toBe('ok');
  });

  it('without a web build, / shows a status fallback', async () => {
    const http = make();
    await app.pipeline('cli');
    const html = await (await http.request('/')).text();
    expect(html).toContain('On Netflix: 600');
  });
});

describe('web UI serving', () => {
  it('serves the app shell for client routes, hashed assets with long caching, and JSON 404s for /api', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
    writeFileSync(join(dir, 'secret.txt'), 'nope');
    make();
    const http = createServer(app, { webDir: dir });

    for (const path of ['/', '/movies', '/title/42', '/search?q=x']) {
      const r = await http.request(path);
      expect(r.status, path).toBe(200);
      expect(await r.text()).toContain('id="root"');
      expect(r.headers.get('cache-control')).toBe('no-cache');
    }
    const js = await http.request('/assets/index-abc.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect((await http.request('/assets/missing.js')).status).toBe(404);
    expect((await http.request('/assets/..%2Fsecret.txt')).status).toBe(404);
    const api = await http.request('/api/nope');
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: 'not found' });
    expect((await http.request('/healthz')).headers.get('content-type')).toContain('json');
  });
});

describe('install files', () => {
  it('serves the manifest, service worker and icons, revalidated each time', async () => {
    const web = mkdtempSync(join(tmpdir(), 'nfx-web-'));
    mkdirSync(join(web, 'icons'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(web, 'manifest.webmanifest'), '{"name":"MonkeySee"}');
    writeFileSync(join(web, 'sw.js'), 'self.addEventListener("fetch", () => {})');
    writeFileSync(join(web, 'icons', 'icon-192.png'), 'png');
    app = createApp(testConfig());           // closed by afterEach
    const s = createServer(app, { webDir: web });
    const m = await s.request('/manifest.webmanifest');
    expect(m.headers.get('content-type')).toBe('application/manifest+json');
    const sw = await s.request('/sw.js');
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    expect(sw.headers.get('content-type')).toContain('javascript');
    expect((await s.request('/icons/icon-192.png')).headers.get('content-type')).toBe('image/png');
    expect(await (await s.request('/icons/../index.html')).text()).toContain('id="root"');   // falls through to the shell
    expect((await s.request('/icons/missing.png')).headers.get('content-type')).toContain('text/html');
  });
});
