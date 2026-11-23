// "Your library": a mirror of what's in Jellyfin, refreshed every 15 minutes. It's
// the cross-check for "do I already have this?", and Discover leaves these out.
import type { Config } from '../config.js';
import { all, get, getJobState, run, setJobState, tx, type Db } from '../db/db.js';
import type { JellyfinClient } from '../clients/jellyfin.js';
import type { LibraryItem, LibraryResponse } from '../api/types.js';
import { log } from '../log.js';

export interface JellyfinSync { at: string; ok: boolean; movies: number; series: number; error?: string }

export async function syncJellyfin(db: Db, jf: JellyfinClient, now = new Date()): Promise<JellyfinSync> {
  try {
    const items = await jf.items();
    tx(db, () => {
      run(db, 'DELETE FROM jellyfin_items');
      const ins = db.prepare(`INSERT OR REPLACE INTO jellyfin_items (jellyfin_id, media_type, tmdb_id, name, year, added_at, has_poster, seasons)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const i of items) ins.run(i.id, i.type, i.tmdbId, i.name, i.year, i.addedAt, i.hasPoster ? 1 : 0, i.seasons);
    });
    const r = { at: now.toISOString(), ok: true, movies: items.filter((i) => i.type === 'movie').length, series: items.filter((i) => i.type === 'tv').length };
    setJobState(db, 'jellyfin', r, r.at);
    return r;
  } catch (err) {
    const prev = lastJellyfin(db);
    const r = { at: now.toISOString(), ok: false, movies: prev?.movies ?? 0, series: prev?.series ?? 0, error: (err as Error).message };
    log.warn('jellyfin: sync failed', { error: r.error });
    setJobState(db, 'jellyfin', r, r.at);
    return r;
  }
}
export const lastJellyfin = (db: Db) => getJobState<JellyfinSync>(db, 'jellyfin')?.value ?? null;

const PAGE = 60;

export function libraryPage(db: Db, cfg: Config, q: { type?: 'movie' | 'tv'; q?: string; sort?: 'added' | 'title' | 'year'; page?: number }): LibraryResponse {
  const where: string[] = ['1'];
  const params: (string | number)[] = [];
  if (q.type) { where.push('j.media_type = ?'); params.push(q.type); }
  if (q.q?.trim()) { where.push("j.name LIKE ? ESCAPE '!'"); params.push(`%${q.q.trim().replace(/[!%_]/g, (m) => `!${m}`)}%`); }
  const order = q.sort === 'title' ? 'j.name COLLATE NOCASE ASC' : q.sort === 'year' ? 'j.year DESC, j.name COLLATE NOCASE' : 'j.added_at DESC';
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const total = get<{ n: number }>(db, `SELECT count(*) n FROM jellyfin_items j WHERE ${where.join(' AND ')}`, params)!.n;
  const rows = all<{ jellyfin_id: string; media_type: 'movie' | 'tv'; tmdb_id: number | null; name: string; year: number | null; added_at: string | null;
    has_poster: number; seasons: number | null; title_id: number | null; poster_path: string | null; managed: number }>(db, `
    SELECT j.*, (SELECT t.id FROM titles t WHERE t.tmdb_type = j.media_type AND t.tmdb_id = j.tmdb_id ORDER BY t.watchmode_id > 0 DESC LIMIT 1) AS title_id,
           (SELECT t.poster_path FROM titles t WHERE t.tmdb_type = j.media_type AND t.tmdb_id = j.tmdb_id AND t.poster_path IS NOT NULL LIMIT 1) AS poster_path,
           EXISTS (SELECT 1 FROM arr_titles a WHERE a.media_type = j.media_type AND a.tmdb_id = j.tmdb_id) AS managed
    FROM jellyfin_items j WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, PAGE, (page - 1) * PAGE]);
  const counts = all<{ media_type: string; n: number }>(db, 'SELECT media_type, count(*) n FROM jellyfin_items GROUP BY media_type');
  const s = lastJellyfin(db);
  const items: LibraryItem[] = rows.map((r) => ({
    id: r.jellyfin_id, type: r.media_type, title: r.name, year: r.year, addedAt: r.added_at, tmdbId: r.tmdb_id, titleId: r.title_id, seasons: r.seasons, managed: !!r.managed,
    // Jellyfin's own poster (passed through MonkeySee), or TMDB's if Jellyfin has none.
    posterUrl: r.has_poster ? `/api/library/${encodeURIComponent(r.jellyfin_id)}/poster` : r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : null,
  }));
  return {
    configured: Boolean(cfg.JELLYFIN_API_KEY), syncedAt: s?.at ?? null, error: s && !s.ok ? s.error ?? 'sync failed' : null,
    counts: { movie: counts.find((c) => c.media_type === 'movie')?.n ?? 0, tv: counts.find((c) => c.media_type === 'tv')?.n ?? 0 },
    total, page, pageSize: PAGE, items,
  };
}

/** For a title page: is it in Jellyfin? */
export const inJellyfin = (db: Db, type: 'movie' | 'tv' | null, tmdbId: number | null) =>
  !!(type && tmdbId && get(db, 'SELECT 1 x FROM jellyfin_items WHERE media_type = ? AND tmdb_id = ? LIMIT 1', [type, tmdbId]));
