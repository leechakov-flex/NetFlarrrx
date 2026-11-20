import { Hono, type Context, type Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { App } from './app.js';
import { confirmHeldRun, recentRuns } from './sync/catalog.js';
import { getJobState } from './db/db.js';
import { log } from './log.js';
import { apiRoutes } from './api/routes.js';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
};

function findWebDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [join(here, 'web'), join(here, '..', 'dist', 'web')]) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

export interface ServerOptions {
  /** Built web UI folder. Omit to look next to the server build; null to disable. */
  webDir?: string | null;
}

export function createServer(app: App, opts: ServerOptions = {}) {
  const http = new Hono();

  // Docker's own healthcheck: is the process serving? Says nothing about sync health.
  http.get('/livez', (c) => c.json({ ok: true }));

  // Uptime Kuma watches this. 200 = fine; 503 = needs attention (held, failing or stale sync).
  http.get('/healthz', (c) => {
    const h = app.health();
    return c.json(h, h.ok ? 200 : 503);
  });

  const requirePasscode = async (c: Context, next: Next) => {
    const expected = app.cfg.APP_PASSCODE;
    if (!expected) return next();
    const given = c.req.header('x-passcode') ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return c.json({ error: 'passcode required' }, 401);
    return next();
  };

  http.route('/api', apiRoutes(app));

  http.get('/api/admin/status', (c) => c.json({
    health: app.health(),
    runs: recentRuns(app.db, 20),
    jobs: { enrich: getJobState(app.db, 'enrich') ?? null, seerr_mirror: getJobState(app.db, 'seerr_mirror') ?? null },
  }));

  http.post('/api/admin/sync', requirePasscode, (c) => {
    const health = app.health();
    if (health.pipeline_running) return c.json({ started: false, reason: 'a sync is already running' }, 409);
    void app.pipeline('manual').catch(() => undefined);
    return c.json({ started: true }, 202);
  });

  http.post('/api/admin/sync-runs/:id/confirm', requirePasscode, async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'bad run id' }, 400);
    try {
      const run = confirmHeldRun(app.db, app.cfg, id);
      log.info('admin: held run confirmed', { run: id });
      void app.enrich().catch(() => undefined);
      return c.json(run);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  // Unknown /api paths are JSON 404s, never the SPA.
  http.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  const webDir = opts.webDir === undefined ? findWebDir() : opts.webDir;
  if (webDir) {
    const indexHtml = readFileSync(join(webDir, 'index.html'), 'utf8');
    http.get('/assets/*', async (c) => {
      const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^([/\\])+/, '');
      const file = join(webDir, rel);
      if (!file.startsWith(join(webDir, 'assets'))) return c.notFound();
      try {
        const body = await readFile(file);
        return c.body(body, 200, {
          'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',      // hashed file names
        });
      } catch { return c.notFound(); }
    });
    // History-mode routing: every other GET gets the app shell.
    http.get('*', (c) => c.html(indexHtml, 200, { 'Cache-Control': 'no-cache' }));
  } else {
    http.get('/', (c) => {
      const h = app.health();
      const s = h.stats;
      return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NetFlarrrx</title><body style="font:16px system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem">
<h1>NetFlarrrx</h1><p>The web UI isn't built. Run <code>npm run build</code>.</p>
<ul><li>Sync status: <b>${h.status}</b>${h.reason ? ` — ${escapeHtml(h.reason)}` : ''}</li>
<li>On Netflix: ${s.on_service}; shown: ${s.eligible}</li></ul></body>`);
    });
  }

  return http;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
