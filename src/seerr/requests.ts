import type { Config } from '../config.js';
import { get, run, type Db } from '../db/db.js';
import { HttpError } from '../clients/http.js';
import { MEDIA_STATUS, REQUEST_STATUS, type SeerrClient, type SeerrPublicSettings, type SeerrTvDetail } from '../clients/seerr.js';
import type { RequestResult, SeasonInfo, SeasonState, SeasonsResponse } from '../api/types.js';
import { log } from '../log.js';

// Seerr's public settings rarely change; cache them for ten minutes.
let settingsCache: { at: number; value: SeerrPublicSettings } | null = null;
export async function seerrSettings(seerr: SeerrClient, now = Date.now()): Promise<SeerrPublicSettings> {
  if (settingsCache && now - settingsCache.at < 10 * 60_000) return settingsCache.value;
  const value = await seerr.publicSettings();
  settingsCache = { at: now, value };
  return value;
}
export function resetSeerrSettingsCache() { settingsCache = null; }

function seasonState(status: number | undefined): SeasonState {
  switch (status) {
    case MEDIA_STATUS.AVAILABLE: return 'available';
    case MEDIA_STATUS.PARTIALLY_AVAILABLE: return 'partial';
    case MEDIA_STATUS.PROCESSING: return 'processing';
    case MEDIA_STATUS.PENDING: return 'requested';
    default: return null;
  }
}

/** Merges Seerr's per-season media status with open (pending or approved, non-4K) requests. */
export function seasonStates(tv: SeerrTvDetail, settings: SeerrPublicSettings): SeasonInfo[] {
  const fromMedia = new Map((tv.mediaInfo?.seasons ?? []).map((s) => [s.seasonNumber, seasonState(s.status)]));
  const requested = new Set<number>();
  for (const r of tv.mediaInfo?.requests ?? []) {
    if (r.is4k) continue;
    if (r.status !== REQUEST_STATUS.PENDING && r.status !== REQUEST_STATUS.APPROVED) continue;
    for (const s of r.seasons) requested.add(s.seasonNumber);
  }
  return tv.seasons
    .filter((s) => s.seasonNumber > 0 || settings.enableSpecialEpisodes)
    .sort((a, b) => a.seasonNumber - b.seasonNumber)
    .map((s) => ({
      seasonNumber: s.seasonNumber,
      name: s.name || (s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`),
      episodeCount: s.episodeCount,
      state: fromMedia.get(s.seasonNumber) ?? (requested.has(s.seasonNumber) ? 'requested' : null),
    }));
}

function titleTmdb(db: Db, cfg: Config, id: number) {
  return get<{ tmdb_id: number | null; tmdb_type: 'movie' | 'tv' | null; title: string }>(db, `
    SELECT tk.tmdb_id, tk.tmdb_type, COALESCE(tk.tmdb_title, tk.title) AS title
    FROM title_kinds tk JOIN availability a ON a.title_id = tk.id
    WHERE tk.id = ? AND a.provider_id = ? AND a.region = ? AND tk.kind IS NOT NULL`, [id, cfg.NETFLIX_SOURCE_ID, cfg.REGION]);
}

export async function titleSeasons(db: Db, cfg: Config, seerr: SeerrClient, id: number): Promise<SeasonsResponse | null> {
  const t = titleTmdb(db, cfg, id);
  if (!t || t.tmdb_type !== 'tv' || !t.tmdb_id) return null;
  const [tv, settings] = await Promise.all([seerr.tv(t.tmdb_id), seerrSettings(seerr)]);
  return { partialRequestsEnabled: settings.partialRequestsEnabled, seasons: seasonStates(tv, settings) };
}

export class RequestError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 502, public code: string, message: string) { super(message); }
}

/**
 * Requests a title in Seerr. Movies need no options. Series request the given
 * seasons, or every season not already available or requested. On success the
 * local Seerr mirror is updated at once so posters show "Requested" immediately.
 */
export async function requestTitle(db: Db, cfg: Config, seerr: SeerrClient, id: number, seasons?: number[], now = new Date()): Promise<RequestResult> {
  const t = titleTmdb(db, cfg, id);
  if (!t) throw new RequestError(404, 'not_found', 'That title isn’t in the Netflix catalog.');
  if (!t.tmdb_id || !t.tmdb_type) throw new RequestError(400, 'no_tmdb', 'This title has no TMDB match, so Seerr can’t request it.');

  let requestSeasons: number[] | undefined;
  if (t.tmdb_type === 'tv') {
    let info: SeasonInfo[];
    let settings: SeerrPublicSettings;
    try {
      const [tv, s] = await Promise.all([seerr.tv(t.tmdb_id), seerrSettings(seerr)]);
      settings = s;
      info = seasonStates(tv, settings);
    } catch (err) {
      throw seerrDown(err);
    }
    const open = info.filter((s) => s.state === null).map((s) => s.seasonNumber);
    if (seasons?.length) {
      const valid = new Set(info.map((s) => s.seasonNumber));
      const bad = seasons.filter((n) => !valid.has(n));
      if (bad.length) throw new RequestError(400, 'bad_seasons', `Season ${bad.join(', ')} isn’t available to request.`);
      if (!settings.partialRequestsEnabled && seasons.length < open.length) {
        throw new RequestError(400, 'partial_disabled', 'Seerr is set to request whole series only.');
      }
      requestSeasons = seasons.filter((n) => open.includes(n));
    } else {
      requestSeasons = open;
    }
    if (!requestSeasons.length) throw new RequestError(409, 'nothing_left', 'Every season is already available or requested.');
  }

  try {
    await seerr.createRequest({ mediaType: t.tmdb_type, mediaId: t.tmdb_id, ...(requestSeasons ? { seasons: requestSeasons } : {}) });
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) throw new RequestError(409, 'already_requested', 'Seerr says this is already requested.');
    if (err instanceof HttpError && err.status === 403) {
      const msg = typeof err.body === 'object' && err.body && 'message' in err.body ? String((err.body as { message: unknown }).message) : '';
      throw new RequestError(403, 'refused', msg ? `Seerr refused the request: ${msg}` : 'Seerr refused the request (permission, quota or blocklist).');
    }
    throw seerrDown(err);
  }

  markRequested(db, t.tmdb_type, t.tmdb_id, requestSeasons, now);
  log.info('request: sent to Seerr', { title: t.title, mediaType: t.tmdb_type, tmdbId: t.tmdb_id, seasons: requestSeasons ?? null });
  return {
    ok: true,
    state: 'requested',
    seasons: requestSeasons ?? null,
    message: requestSeasons
      ? `Requested ${requestSeasons.length === 1 ? `season ${requestSeasons[0]}` : `${requestSeasons.length} seasons`} of ${t.title}.`
      : `Requested ${t.title}.`,
  };
}

function seerrDown(err: unknown) {
  if (err instanceof RequestError) return err;
  log.warn('request: Seerr unreachable', { error: err instanceof Error ? err.message : String(err) });
  if (err instanceof HttpError && err.isAuth) return new RequestError(502, 'seerr_auth', 'Seerr rejected the API key. Check SEERR_API_KEY.');
  return new RequestError(502, 'seerr_unreachable', 'Couldn’t reach Seerr. Try again in a moment.');
}

/** Optimistic mirror update; the next 10-minute mirror run replaces it with Seerr's truth. */
function markRequested(db: Db, mediaType: 'movie' | 'tv', tmdbId: number, seasons: number[] | undefined, now: Date) {
  const existing = get<{ status: number; seasons_json: string | null }>(db,
    'SELECT status, seasons_json FROM seerr_media WHERE media_type = ? AND tmdb_id = ?', [mediaType, tmdbId]);
  const keep = existing && [MEDIA_STATUS.PROCESSING, MEDIA_STATUS.PARTIALLY_AVAILABLE, MEDIA_STATUS.AVAILABLE].includes(existing.status as 3 | 4 | 5);
  const status = keep ? existing.status : MEDIA_STATUS.PENDING;
  const prevSeasons: { seasonNumber: number; status: number }[] = existing?.seasons_json ? JSON.parse(existing.seasons_json) : [];
  const merged = new Map(prevSeasons.map((s) => [s.seasonNumber, s]));
  for (const n of seasons ?? []) if (!merged.has(n)) merged.set(n, { seasonNumber: n, status: MEDIA_STATUS.PENDING });
  run(db, `INSERT INTO seerr_media (media_type, tmdb_id, seerr_id, status, status4k, seasons_json, updated_at, mirrored_at)
           VALUES (?, ?, 0, ?, NULL, ?, ?, ?)
           ON CONFLICT (media_type, tmdb_id) DO UPDATE SET status = excluded.status, seasons_json = excluded.seasons_json, mirrored_at = excluded.mirrored_at`,
  [mediaType, tmdbId, status, JSON.stringify([...merged.values()]), now.toISOString(), now.toISOString()]);
}
