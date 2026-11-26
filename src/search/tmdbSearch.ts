// Search beyond the catalog: TMDB's own search (what Seerr uses), minus anything MonkeySee
// already has. Results are ordinary title cards with a negative ID that encodes the TMDB
// type and ID, so they blend into search, open a title page and can be requested.
import { all, get, type Db } from '../db/db.js';
import type { TmdbClient } from '../clients/tmdb.js';
import type { TitleCard, TitleDetail } from '../api/types.js';
import { seerrState } from '../catalog/queries.js';
import { inJellyfin } from '../library/jellyfin.js';

/** -(tmdbId × 2 + 1 for series): never collides with catalog IDs, which are positive. */
export const tmdbCardId = (type: 'movie' | 'tv', tmdbId: number) => -(tmdbId * 2 + (type === 'tv' ? 1 : 0));
export function fromTmdbCardId(id: number): { type: 'movie' | 'tv'; tmdbId: number } | null {
  if (!Number.isInteger(id) || id >= 0) return null;
  const n = -id;
  return { type: n % 2 ? 'tv' : 'movie', tmdbId: Math.floor(n / 2) };
}

// Titles seen in recent searches, so a request or the title page can name them.
const names = new Map<number, string>();
export const tmdbTitleName = (id: number) => names.get(id) ?? null;

type Hit = Awaited<ReturnType<TmdbClient['search']>>[number];
const cache = new Map<string, { at: number; value: Hit[] }>();
const TTL = 10 * 60_000;

export async function searchTmdb(db: Db, tmdb: TmdbClient, query: string, now = Date.now()): Promise<TitleCard[]> {
  const key = query.trim().toLowerCase();
  const c = cache.get(key);
  let hits = c && now - c.at < TTL ? c.value : null;
  if (!hits) {
    hits = await tmdb.search(query);
    cache.set(key, { at: now, value: hits });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  if (!hits.length) return [];
  const ids = hits.map((h) => h.id);
  const ph = ids.map(() => '?').join(',');
  const inCatalog = new Set(all<{ k: string }>(db, `SELECT tmdb_type || ':' || tmdb_id AS k FROM titles WHERE tmdb_id IN (${ph})`, ids).map((r) => r.k));
  const seerr = new Map(all<{ k: string; status: number }>(db, `SELECT media_type || ':' || tmdb_id AS k, status FROM seerr_media WHERE tmdb_id IN (${ph})`, ids).map((r) => [r.k, r.status]));
  const today = new Date(now).toISOString().slice(0, 10);
  return hits
    .filter((h) => !inCatalog.has(`${h.type}:${h.id}`))
    .filter((h) => h.posterPath || h.popularity >= 2)     // skip TMDB's long tail of empty stubs
    .slice(0, 24)
    .map((h): TitleCard => {
      const id = tmdbCardId(h.type, h.id);
      names.set(id, h.title);
      if (names.size > 2000) names.delete(names.keys().next().value!);
      const have = inJellyfin(db, h.type, h.id);
      return {
        id, kind: h.type === 'movie' ? 'movie' : 'series', title: h.title, year: h.date ? Number(h.date.slice(0, 4)) || null : null,
        posterPath: h.posterPath, addedAt: null, backOnNetflix: false, voteAverage: h.voteAverage, voteCount: h.voteCount,
        seerr: have ? 'available' : seerrState(seerr.get(`${h.type}:${h.id}`)),
        services: [], digital: false,
        // Not out yet: the card shows the date, like any coming-soon title.
        soon: h.date && h.date > today ? { date: h.date, service: null, release: true } : null,
        logoPath: null, textlessPosterPath: null,
      };
    });
}

/** The title page for a search result outside the catalog, built from TMDB. */
export async function tmdbTitleDetail(db: Db, tmdb: TmdbClient, id: number, now = new Date()): Promise<TitleDetail | null> {
  const ref = fromTmdbCardId(id);
  if (!ref) return null;
  const d = await tmdb.details(ref.type, ref.tmdbId);
  if (!d) return null;
  const title = d.tmdbTitle ?? names.get(id) ?? 'Untitled';
  names.set(id, title);
  const sm = get<{ status: number; seasons_json: string | null }>(db, 'SELECT status, seasons_json FROM seerr_media WHERE media_type = ? AND tmdb_id = ?', [ref.type, ref.tmdbId]);
  const have = inJellyfin(db, ref.type, ref.tmdbId);
  const today = now.toISOString().slice(0, 10);
  const soon = d.releaseDate && d.releaseDate > today ? { date: d.releaseDate, service: null, release: true } : null;
  return {
    id, kind: ref.type === 'movie' ? 'movie' : 'series', title, year: d.releaseDate ? Number(d.releaseDate.slice(0, 4)) || null : null,
    posterPath: d.posterPath, addedAt: null, backOnNetflix: false, voteAverage: d.voteAverage, voteCount: d.voteCount,
    seerr: have ? 'available' : seerrState(sm?.status), services: [], digital: false, soon,
    logoPath: d.logoPath, textlessPosterPath: d.textlessPosterPath,
    overview: d.overview, backdropPath: d.backdropPath, releaseDate: d.releaseDate, runtime: d.runtime, seasons: d.seasons,
    certification: d.certification, originalLanguage: d.originalLanguage, genres: d.genres, trailer: d.trailer,
    onNetflix: false, firstSeenAt: null,
    cast: d.credits.map((p) => ({ id: p.id, name: p.name, role: p.role, profilePath: p.profilePath })),
    related: [],
    watch: { services: [], stores: [...new Set([...(d.watch?.rent ?? []), ...(d.watch?.buy ?? [])])], soon },
    tmdbId: ref.tmdbId, tmdbType: ref.type,
    seerrSeasons: sm?.seasons_json ? JSON.parse(sm.seasons_json) : [],
    inLibrary: have,
  };
}
