import { Hono } from 'hono';
import { z } from 'zod';
import type { App } from '../app.js';
import { browse, genres, home, meta, titleDetail, top } from '../catalog/queries.js';

const kind = z.enum(['movie', 'series']);
const intList = z.string().transform((s) => s.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0));

const BrowseParams = z.object({
  kind: kind.optional(),
  genres: intList.optional(),
  added: z.enum(['7', '30', '90']).transform(Number).optional(),
  minRating: z.coerce.number().min(0).max(10).optional(),
  minVotes: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['added', 'rating', 'popularity', 'release', 'title']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  q: z.string().max(100).optional(),
});

/** Read-only JSON API for the web UI. */
export function apiRoutes(app: App) {
  const api = new Hono();
  const { db, cfg } = app;

  api.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  api.get('/meta', (c) => c.json(meta(db, cfg, app.health().status)));
  api.get('/home', (c) => c.json(home(db, cfg)));

  api.get('/titles', (c) => {
    const p = BrowseParams.safeParse(c.req.query());
    if (!p.success) return c.json({ error: 'bad query', issues: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
    return c.json(browse(db, cfg, p.data as Parameters<typeof browse>[2]));
  });

  api.get('/titles/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: 'bad id' }, 400);
    const t = titleDetail(db, cfg, id);
    return t ? c.json(t) : c.json({ error: 'not found' }, 404);
  });

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
