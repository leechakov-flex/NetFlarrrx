import { Hono, type Context, type Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { App } from './app.js';
import { confirmHeldRun, recentRuns } from './sync/catalog.js';
import { getJobState } from './db/db.js';
import { log } from './log.js';

export function createServer(app: App) {
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

  // Placeholder home page until the browse UI lands in M2.
  http.get('/', (c) => {
    const h = app.health();
    const s = h.stats;
    return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NetFlarrrx</title><body style="font:16px system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem">
<h1>NetFlarrrx</h1><p>Ingest is running. The browse UI arrives in M2.</p>
<ul><li>Sync status: <b>${h.status}</b>${h.reason ? ` — ${escapeHtml(h.reason)}` : ''}</li>
<li>Last applied sync: ${h.last_applied_sync_at ?? 'none yet'}</li>
<li>On Netflix US: ${s.on_service}; shown (${s.language_rule === 'en' ? 'English-original' : 'all languages'}): ${s.eligible}
(${s.eligible_movies} movies, ${s.eligible_series} series); with a date added: ${s.dated}</li>
<li>TMDB: ${s.enrichment.ok} enriched, ${s.enrichment.pending} pending, ${s.enrichment.missing} not found, ${s.enrichment.error} errors</li></ul>
<p><small>Data from <a href="https://www.watchmode.com">Watchmode</a> and <a href="https://www.themoviedb.org">TMDB</a>.
This product uses the TMDB API but is not endorsed or certified by TMDB.</small></p></body>`);
  });

  return http;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
