import { Hono } from 'hono';
import { z } from 'zod';
import type { App } from '../app.js';
import type { MiddlewareHandler } from 'hono';
import { browse, companies, findTheme, genres, home, meta, themes, titleDetail, top } from '../catalog/queries.js';
import { RequestError, requestTitle, titleSeasons } from '../seerr/requests.js';
import { log } from '../log.js';
import { lastDownloads, resetDownloadsCache, titleDownload } from '../downloads/downloads.js';
import { inJellyfin, lastJellyfin, libraryPage } from '../library/jellyfin.js';
import { HttpError } from '../clients/http.js';
import { SERVICES } from '../services.js';
import type { How, ServiceKey } from './types.js';

const SERVICE_KEYS = new Set<string>(SERVICES.map((s) => s.key));
// Studio and network keys: "a24", "20th-century". At most 20 at once.
const keyList = (v: string) => v.split(',').filter((k) => /^[a-z0-9-]{1,80}$/.test(k)).slice(0, 20);

const kind = z.enum(['movie', 'series']);
const intList = z.string().transform((s) => s.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0));

const BrowseParams = z.object({
  kind: kind.optional(),
  genres: intList.optional(),
  added: z.enum(['7', '30', '90']).transform(Number).optional(),
  minRating: z.coerce.number().min(0).max(10).optional(),
  maxRating: z.coerce.number().min(0).max(10).optional(),
  minVotes: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['added', 'rating', 'popularity', 'release', 'title', 'match', 'soon']).optional(),
  services: z.string().transform((v) => v.split(',').filter((k) => SERVICE_KEYS.has(k)) as ServiceKey[]).optional(),
  how: z.string().transform((v) => v.split(',').filter((k) => k === 'sub' || k === 'digital' || k === 'soon') as How[]).optional(),
  because: z.string().regex(/^(movie|tv):\d{1,9}$/).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  q: z.string().max(100).optional(),
  hide: z.enum(['have']).optional(),
  theme: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
  studios: z.string().transform(keyList).optional(),
  networks: z.string().transform(keyList).optional(),
});

const RequestBody = z.object({ seasons: z.array(z.number().int().min(0).max(1000)).max(200).optional() }).strict();

/** JSON API for the web UI. Writes go through `requirePasscode`. */
export function apiRoutes(app: App, requirePasscode: MiddlewareHandler) {
  const api = new Hono();
  const { db, cfg } = app;

  api.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');   // posters set their own
  });

  api.get('/meta', (c) => {
    const h = app.health();
    return c.json({
      ...meta(db, cfg, h.status),
      ops: {
        lastBackupAt: h.backup?.last_ok_at ?? null,
        backupError: h.backup?.last_error ?? null,
        crosscheck: h.crosscheck ? { at: h.crosscheck.at, ok: h.crosscheck.ok, coveragePct: h.crosscheck.coverage_pct } : null,
        alerts: app.notifier.enabled,
      },
      library: (() => {
        const j = lastJellyfin(db);
        return { configured: Boolean(cfg.JELLYFIN_API_KEY), movies: j?.movies ?? 0, series: j?.series ?? 0 };
      })(),
      downloads: (() => {
        const d = lastDownloads(db);
        return { configured: Boolean(cfg.QBIT_PASSWORD), attention: d?.attention.length ?? 0, downloading: d?.downloading ?? 0 };
      })(),
    });
  });
  api.get('/home', (c) => {
    const only = (c.req.query('services') ?? '').split(',').filter((k) => SERVICE_KEYS.has(k)) as ServiceKey[];
    return c.json(home(db, cfg, new Date(), only, { studios: keyList(c.req.query('studios') ?? ''), networks: keyList(c.req.query('networks') ?? '') }));
  });

  api.get('/titles', (c) => {
    const p = BrowseParams.safeParse(c.req.query());
    if (!p.success) return c.json({ error: 'bad query', issues: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
    const { hide, ...q } = p.data;
    if (q.theme && !findTheme(cfg, q.theme)) return c.json({ error: 'unknown theme' }, 404);
    return c.json(browse(db, cfg, { ...(q as Parameters<typeof browse>[2]), hideHave: hide === 'have' }));
  });

  api.get('/titles/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: 'bad id' }, 400);
    const t = titleDetail(db, cfg, id);
    if (!t) return c.json({ error: 'not found' }, 404);
    t.inLibrary = inJellyfin(db, t.tmdbType, t.tmdbId);
    // Download progress for the Request button, only when something of it is requested.
    if (t.seerr === 'requested' || t.seerr === 'processing' || t.seerr === 'partial') {
      const snap = await app.downloads().catch(() => null);
      t.download = snap ? titleDownload(snap, t.tmdbType, t.tmdbId, id) : null;
      const req = snap?.requests.find((r) => r.tmdbType === t.tmdbType && r.tmdbId === t.tmdbId && r.state !== 'declined');
      t.request = req ? { state: req.state, detail: req.detail } : null;
    }
    return c.json(t);
  });

  const LibraryParams = z.object({
    type: z.enum(['movie', 'tv']).optional(), q: z.string().max(100).optional(),
    sort: z.enum(['added', 'title', 'year']).optional(), page: z.coerce.number().int().min(1).max(10_000).optional(),
  });
  api.get('/library', (c) => {
    const p = LibraryParams.safeParse(c.req.query());
    if (!p.success) return c.json({ error: 'bad query' }, 400);
    return c.json(libraryPage(db, cfg, p.data));
  });
  // Jellyfin's poster, passed through (Jellyfin is only reachable inside Docker). Cached a day by the browser.
  api.get('/library/:id/poster', async (c) => {
    const id = c.req.param('id');
    if (!app.jellyfin || !/^[a-f0-9]{32}$/i.test(id)) return c.body(null, 404);
    try {
      const res = await app.jellyfin.poster(id);
      return new Response(res.body, { headers: { 'Content-Type': res.headers.get('content-type') ?? 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
    } catch {
      return c.body(null, 404);
    }
  });

  api.get('/downloads', async (c) => c.json(await app.downloads()));

  // Cancel (delete) or retry a Seerr request. Single-user app, so no approve/decline.
  for (const action of ['cancel', 'retry'] as const) {
    api.post(`/requests/:id/${action}`, requirePasscode, async (c) => {
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id < 1) return c.json({ error: 'bad id' }, 400);
      try {
        if (action === 'cancel') await app.seerr.deleteRequest(id); else await app.seerr.retryRequest(id);
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return c.json({ error: 'Seerr doesn’t have that request any more.', code: 'not_found' }, 404);
        log.warn(`requests: ${action} failed`, { id, error: (err as Error).message });
        return c.json({ error: 'Couldn’t reach Seerr. Try again in a moment.', code: 'seerr_unreachable' }, 502);
      }
      log.info(`requests: ${action}`, { id });
      resetDownloadsCache();
      void app.mirror().catch(() => undefined);
      return c.json({ ok: true });
    });
  }

  // Per-season state for the season picker. Live from Seerr, so always current.
  api.get('/titles/:id/seasons', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: 'bad id' }, 400);
    try {
      const s = await titleSeasons(db, cfg, app.seerr, id);
      return s ? c.json(s) : c.json({ error: 'not a series in the catalog' }, 404);
    } catch (err) {
      log.warn('seasons: Seerr lookup failed', { id, error: (err as Error).message });
      return c.json({ error: 'Couldn’t reach Seerr. Try again in a moment.', code: 'seerr_unreachable' }, 502);
    }
  });

  api.post('/titles/:id/request', requirePasscode, async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: 'bad id' }, 400);
    const raw = await c.req.json().catch(() => ({}));
    const body = RequestBody.safeParse(raw ?? {});
    if (!body.success) return c.json({ error: 'bad request body', code: 'bad_body' }, 400);
    try {
      const result = await requestTitle(db, cfg, app.seerr, id, body.data.seasons);
      void app.mirror().catch(() => undefined);     // pick up Seerr's own view soon after
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof RequestError) {
        if (err.code === 'already_requested' || err.code === 'nothing_left') void app.mirror().catch(() => undefined);
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      throw err;
    }
  });

  // Lets the UI check a passcode before saving it on the device.
  api.post('/passcode/check', requirePasscode, (c) => c.json({ ok: true }));

  api.get('/companies', (c) => c.json(companies(db, cfg)));

  api.get('/themes', (c) => c.json(themes(db, cfg)));

  api.get('/genres', (c) => {
    const k = kind.optional().safeParse(c.req.query('kind'));
    return c.json(genres(db, cfg, k.success ? k.data : undefined));
  });

  api.get('/top', (c) => {
    const k = kind.safeParse(c.req.query('kind') ?? 'movie');
    if (!k.success) return c.json({ error: 'kind must be movie or series' }, 400);
    return c.json(top(db, cfg, k.data));
  });

  return api;
}
