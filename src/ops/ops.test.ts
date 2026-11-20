import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp, type App } from '../app.js';
import { createServer } from '../server.js';
import { testConfig, type Config } from '../config.js';
import { all, run, setJobState } from '../db/db.js';
import type { FetchFn } from '../clients/http.js';
import { FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';
import { runBackup } from './backup.js';
import { Notifier, reconcileAlerts } from './alerts.js';
import type { MetaResponse } from '../api/types.js';

const catalog = () => realCatalog().filter((t) => t.tmdb_id).filter((_, i) => i % 50 === 0).slice(0, 60);

/** Captures what alerts would send. */
class AlertSink {
  sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  status = 200;
  fetch: FetchFn = async (input, init) => {
    this.sent.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') });
    return new Response('{}', { status: this.status, headers: { 'content-type': 'application/json' } });
  };
}

let dir: string;
let app: App;
let tmdb: FakeTmdb;
let sink: AlertSink;
async function setup(overrides: Partial<Record<keyof Config, string>> = {}) {
  tmdb = new FakeTmdb();
  sink = new AlertSink();
  app = createApp(testConfig({ DATA_DIR: dir, ALERT_URL: 'https://ntfy.sh/netflarrrx-test', APP_URL: 'http://monkeyserver.local:8484', ...overrides }), {
    watchmode: new FakeWatchmode(catalog()).fetch, tmdb: tmdb.fetch, seerr: new FakeSeerr([]).fetch, alerts: sink.fetch,
  });
  await app.pipeline('cli');
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nfx-ops-')); });
afterEach(() => { app?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('backups', () => {
  it('writes a verified copy that opens and holds the history', async () => {
    await setup();
    const b = await app.backup();
    expect(b).toMatchObject({ ok: true, titles: 60, kept: 1 });
    const copy = new DatabaseSync(b.file!, { readOnly: true });
    expect((copy.prepare('SELECT count(*) n FROM availability').get() as { n: number }).n).toBe(60);
    copy.close();
    expect(readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.partial'))).toEqual([]);
  });

  it('keeps the newest BACKUP_KEEP days and one file per day', async () => {
    await setup({ BACKUP_KEEP: '3' });
    for (const d of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) runBackup(app.db, app.cfg, new Date(`${d}T12:00:00Z`));
    runBackup(app.db, app.cfg, new Date('2026-11-05T18:00:00Z'));     // same day again: replaces
    expect(readdirSync(join(dir, 'backups')).sort()).toEqual(['netflarrrx-2026-11-03.sqlite', 'netflarrrx-2026-11-04.sqlite', 'netflarrrx-2026-11-05.sqlite']);
  });

  it('records a failure, keeps the last good time, and alerts', async () => {
    await setup();
    const ok = runBackup(app.db, app.cfg, new Date('2026-11-01T08:00:00Z'));
    writeFileSync(join(dir, 'blocked'), 'not a folder');
    const bad = createApp(testConfig({ DATA_DIR: dir, BACKUP_DIR: join(dir, 'blocked', 'sub'), ALERT_URL: 'https://ntfy.sh/t' }), { alerts: sink.fetch });
    try {
      const r = await bad.backup();
      expect(r.ok).toBe(false);
      expect(bad.health().backup).toEqual({ last_ok_at: ok.at, last_error: expect.any(String) });
      expect(sink.sent.map((s) => s.headers.Title)).toContain('NetFlarrrx: Backup failed');
    } finally { bad.close(); }
  });

  it('alerts when the last good backup is over two days old', async () => {
    await setup();
    runBackup(app.db, app.cfg, new Date(Date.now() - 3 * 86_400_000));
    expect(app.problems().map((p) => p.key)).toContain('backup:stale');
    runBackup(app.db, app.cfg);
    expect(app.problems().map((p) => p.key)).not.toContain('backup:stale');
  });
});

describe('alerts', () => {
  it('ntfy: one alert per problem, a reminder after a day, and resolved when it clears', async () => {
    await setup();
    const n = new Notifier(app.cfg, sink.fetch);
    const p = [{ key: 'sync:held', title: 'Sync held', message: 'run 4 held: count swing 14%' }];
    const t0 = new Date('2026-11-20T12:00:00Z');
    await reconcileAlerts(app.db, n, p, t0);
    await reconcileAlerts(app.db, n, p, new Date(t0.getTime() + 3600_000));            // still open: quiet
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]).toMatchObject({
      url: 'https://ntfy.sh/netflarrrx-test', body: 'run 4 held: count swing 14%',
      headers: expect.objectContaining({ Title: 'NetFlarrrx: Sync held', Priority: 'high', Tags: 'warning', Click: 'http://monkeyserver.local:8484' }),
    });
    await reconcileAlerts(app.db, n, p, new Date(t0.getTime() + 25 * 3600_000));       // reminder
    expect(sink.sent[1]!.headers.Title).toBe('NetFlarrrx: Still: Sync held');
    await reconcileAlerts(app.db, n, [], new Date(t0.getTime() + 26 * 3600_000));      // cleared
    expect(sink.sent[2]!.headers).toMatchObject({ Title: 'NetFlarrrx: Resolved: Sync held', Tags: 'white_check_mark' });
    expect(sink.sent).toHaveLength(3);
  });

  it('retries a failed send at the next check', async () => {
    await setup();
    const n = new Notifier(app.cfg, sink.fetch);
    sink.status = 500;
    const p = [{ key: 'x', title: 'Thing', message: 'm' }];
    expect((await reconcileAlerts(app.db, n, p)).sent).toEqual([]);
    sink.status = 200;
    expect((await reconcileAlerts(app.db, n, p)).sent).toEqual(['x']);
  });

  it('Discord webhooks get a JSON message; token and curly quotes are handled for ntfy', async () => {
    await setup({ ALERT_URL: 'https://discord.com/api/webhooks/1/abc' });
    await new Notifier(app.cfg, sink.fetch).send('Sync held', 'details', 'problem');
    expect(JSON.parse(sink.sent[0]!.body)).toEqual({ content: '⚠️ **Sync held**\ndetails\nhttp://monkeyserver.local:8484' });
    const ntfy = new Notifier(testConfig({ ALERT_URL: 'https://ntfy.example.com/nfx', ALERT_TOKEN: 'tk_123' }), sink.fetch);
    await ntfy.send('Netflix’s list', 'x', 'test');
    expect(sink.sent[1]!.headers).toMatchObject({ Title: "NetFlarrrx: Netflix's list", Authorization: 'Bearer tk_123' });
  });

  it('a held sync alerts through the pipeline', async () => {
    await setup();
    setJobState(app.db, 'alerts', { open: {} });
    run(app.db, `UPDATE sync_runs SET status = 'held', note = 'count swing 14%' WHERE id = (SELECT max(id) FROM sync_runs)`);
    await app.checkAlerts();
    expect(sink.sent.map((s) => s.headers.Title)).toContain('NetFlarrrx: Sync held');
  });

  it('without ALERT_URL nothing is sent', async () => {
    await setup({ ALERT_URL: '' });
    expect(app.notifier.enabled).toBe(false);
    await app.notifier.send('x', 'y', 'test');
    expect(sink.sent).toHaveLength(0);
  });
});

describe('TMDB cross-check', () => {
  function tmdbList(share: number, extra = 0) {
    const ours = all<{ tmdb_type: 'movie' | 'tv'; tmdb_id: number }>(app.db, 'SELECT tmdb_type, tmdb_id FROM titles WHERE tmdb_id IS NOT NULL');
    const keep = ours.slice(0, Math.round(ours.length * share));
    tmdb.discover = {
      movie: [...keep.filter((r) => r.tmdb_type === 'movie').map((r) => ({ id: r.tmdb_id, title: `m${r.tmdb_id}` })),
        ...Array.from({ length: extra }, (_, i) => ({ id: 900000 + i, title: `Only on TMDB ${i}`, popularity: 100 - i }))],
      tv: keep.filter((r) => r.tmdb_type === 'tv').map((r) => ({ id: r.tmdb_id, title: `t${r.tmdb_id}` })),
    };
    return ours.length;
  }

  it('pages through TMDB and reports both directions', async () => {
    await setup();
    const n = tmdbList(0.9, 30);          // 2+ pages of movies
    const x = await app.crosscheck();
    expect(x.ok).toBe(true);
    expect(x.oursTotal).toBe(n);
    expect(x.both).toBe(Math.round(n * 0.9));
    expect(x.tmdbTotal).toBe(Math.round(n * 0.9) + 30);
    expect(x.onlyTmdb![0]).toEqual({ tmdbId: 900000, type: 'movie', title: 'Only on TMDB 0', year: 2020 });
    expect(x.onlyOurs).toHaveLength(n - Math.round(n * 0.9));
    expect(app.problems().map((p) => p.key)).not.toContain('crosscheck:low');
  });

  it('alerts when coverage is low or drops sharply, and on failure', async () => {
    await setup();
    tmdbList(1, 200);                      // we have 60 of 260: 23%
    await app.crosscheck();
    expect(sink.sent.map((s) => s.headers.Title)).toContain('NetFlarrrx: Netflix list looks incomplete');

    tmdbList(1);                           // back to 100%
    await app.crosscheck();
    tmdbList(1, 12);                       // 60 of 72: 83%, a 17-point drop
    await app.crosscheck();
    expect(app.problems().map((p) => p.key)).toEqual(['crosscheck:drop']);

    tmdb.discoverFailPage = 1;
    const x = await app.crosscheck();
    expect(x.ok).toBe(false);
    expect(app.problems().map((p) => p.key)).toContain('crosscheck:failed');
  });

  it('shows on /api/meta for the More page', async () => {
    await setup();
    tmdbList(1);
    await app.crosscheck();
    await app.backup();
    const meta = (await (await createServer(app, { webDir: null }).request('/api/meta')).json()) as MetaResponse;
    expect(meta.ops).toMatchObject({ lastBackupAt: expect.any(String), backupError: null, alerts: true, crosscheck: { ok: true, coveragePct: 100 } });
  });
});

