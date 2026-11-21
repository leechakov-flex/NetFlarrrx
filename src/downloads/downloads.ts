// The Downloads page: qBittorrent's torrents, matched to the movie or series
// Radarr or Sonarr is getting with them, plus your Seerr requests. Read only,
// except cancelling and retrying requests (which go through Seerr).
import type { Config } from '../config.js';
import { all, getJobState, setJobState, type Db } from '../db/db.js';
import type { QbitClient, QbitTorrent } from '../clients/qbittorrent.js';
import type { ArrClient, QueueItem } from '../clients/arr.js';
import type { SeerrClient, SeerrRequest } from '../clients/seerr.js';
import type { TmdbClient } from '../clients/tmdb.js';
import type { DownloadItem, DownloadState, DownloadsResponse, RequestItem, RequestState, TitleDownload } from '../api/types.js';
import { log } from '../log.js';

export interface DownloadDeps { db: Db; cfg: Config; qbit?: QbitClient; radarr?: ArrClient; sonarr?: ArrClient; seerr: SeerrClient; tmdb: TmdbClient }

const ETA_UNKNOWN = 8_640_000;
const CACHE_MS = 8_000;

/** qBittorrent state -> what the page shows. null = finished (seeding) or not a download. */
export function stateOf(t: Pick<QbitTorrent, 'state' | 'progress'>): DownloadState | null {
  switch (t.state) {
    case 'downloading': case 'forcedDL': return 'downloading';
    case 'stalledDL': return 'stalled';
    case 'metaDL': case 'forcedMetaDL': return 'metadata';
    case 'error': case 'missingFiles': return 'error';
    case 'queuedDL': case 'checkingDL': case 'checkingResumeData': case 'allocating': return 'queued';
    case 'pausedDL': case 'stoppedDL': return 'paused';
    case 'moving': return 'importing';
    default: return t.progress < 1 && !/UP$/.test(t.state) ? 'queued' : null;
  }
}
const isAttention = (s: DownloadState) => s === 'stalled' || s === 'metadata' || s === 'error';
const isSeeding = (t: QbitTorrent) => /UP$/.test(t.state) || t.state === 'uploading';

/** Our title row for a TMDB id: its id (for the link) and poster. */
function titleIndex(db: Db, pairs: { type: 'movie' | 'tv'; id: number }[]) {
  const out = new Map<string, { id: number; poster: string | null; title: string; year: number | null }>();
  const uniq = [...new Map(pairs.map((p) => [`${p.type}:${p.id}`, p])).values()];
  for (let i = 0; i < uniq.length; i += 200) {
    const chunk = uniq.slice(i, i + 200);
    if (!chunk.length) break;
    for (const r of all<{ id: number; tmdb_type: string; tmdb_id: number; poster_path: string | null; title: string; year: number | null }>(db,
      `SELECT id, tmdb_type, tmdb_id, poster_path, COALESCE(tmdb_title, title) title, year FROM titles
       WHERE ${chunk.map(() => '(tmdb_type = ? AND tmdb_id = ?)').join(' OR ')} ORDER BY watchmode_id > 0 DESC`, chunk.flatMap((p) => [p.type, p.id]))) {
      const k = `${r.tmdb_type}:${r.tmdb_id}`;
      if (!out.has(k)) out.set(k, { id: r.id, poster: r.poster_path, title: r.title, year: r.year });
    }
  }
  return out;
}
const poster = (path: string | null) => (path ? `https://image.tmdb.org/t/p/w185${path}` : null);

let cache: { at: number; value: DownloadsResponse } | null = null;
const tmdbNames = new Map<string, { title: string; year: number | null; posterPath: string | null } | null>();
export const resetDownloadsCache = () => { cache = null; };

export async function downloadsSnapshot(d: DownloadDeps, now = new Date()): Promise<DownloadsResponse> {
  if (cache && now.getTime() - cache.at < CACHE_MS) return cache.value;
  const errors: string[] = [];
  const soft = async <T>(name: string, p: Promise<T> | undefined, fallback: T): Promise<T> => {
    if (!p) return fallback;
    try { return await p; } catch (err) { if (!errors.includes(name)) log.warn(`downloads: ${name} unreachable`, { error: (err as Error).message, ...(typeof (err as { body?: unknown }).body === 'string' && (err as { body: string }).body ? { detail: (err as { body: string }).body.slice(0, 200) } : {}) }); errors.push(name); return fallback; }
  };
  const [torrents, transfer, rq, sq, reqs] = await Promise.all([
    soft('qBittorrent', d.qbit?.torrents(), [] as QbitTorrent[]),
    soft('qBittorrent', d.qbit?.transfer(), null),
    soft('Radarr', d.radarr?.queue(), [] as QueueItem[]),
    soft('Sonarr', d.sonarr?.queue(), [] as QueueItem[]),
    soft('Seerr', d.seerr.requests(50), [] as SeerrRequest[]),
  ]);
  const queue = [...rq, ...sq];
  const byHash = new Map(queue.filter((q) => q.downloadId).map((q) => [q.downloadId!, q]));
  const titles = titleIndex(db(d), [
    ...queue.filter((q) => q.tmdbId).map((q) => ({ type: (q.source === 'radarr' ? 'movie' : 'tv') as 'movie' | 'tv', id: q.tmdbId! })),
    ...reqs.map((r) => ({ type: r.media.mediaType, id: r.media.tmdbId })),
  ]);

  const items: DownloadItem[] = [];
  const seenHashes = new Set<string>();
  for (const t of torrents) {
    const state = stateOf(t);
    if (!state) continue;
    const hash = t.hash.toUpperCase();
    seenHashes.add(hash);
    const q = byHash.get(hash);
    const tk = q?.tmdbId ? titles.get(`${q.source === 'radarr' ? 'movie' : 'tv'}:${q.tmdbId}`) : undefined;
    const lastActive = Number((t as Record<string, unknown>).last_activity ?? 0);
    items.push({
      hash, name: t.name, title: q?.title ?? t.name, year: q?.year ?? null,
      subtitle: q?.season != null ? `S${q.season} E${q.episode}${q.episodeTitle ? ` · ${q.episodeTitle}` : ''}` : null,
      source: q?.source ?? null, titleId: tk?.id ?? null, posterUrl: poster(tk?.poster ?? null) ?? q?.posterUrl ?? null,
      state, progress: t.progress, size: t.size, speed: t.dlspeed,
      etaSeconds: t.eta > 0 && t.eta < ETA_UNKNOWN ? t.eta : null, seeds: t.num_seeds, peers: t.num_leechs,
      // Stuck since the last time any data moved; a torrent that never started, since it was added.
      since: isAttention(state) ? new Date(1000 * (state !== 'metadata' && lastActive > 0 ? lastActive : t.added_on)).toISOString() : null,
      message: q && q.trackedStatus && q.trackedStatus !== 'ok' ? q.messages[0] ?? null : null,
    });
  }
  // Radarr/Sonarr warnings for downloads qBittorrent no longer lists (e.g. failed imports).
  for (const q of queue) {
    if (!q.downloadId || seenHashes.has(q.downloadId) || q.trackedStatus !== 'warning' && q.trackedStatus !== 'error') continue;
    const tk = q.tmdbId ? titles.get(`${q.source === 'radarr' ? 'movie' : 'tv'}:${q.tmdbId}`) : undefined;
    items.push({ hash: q.downloadId, name: q.title, title: q.title, year: q.year, subtitle: q.season != null ? `S${q.season} E${q.episode}` : null,
      source: q.source, titleId: tk?.id ?? null, posterUrl: poster(tk?.poster ?? null) ?? q.posterUrl, state: 'error',
      progress: q.size ? 1 - q.sizeLeft / q.size : 1, size: q.size, speed: 0, etaSeconds: null, seeds: 0, peers: 0, since: null, message: q.messages[0] ?? null });
  }

  // A torrent Radarr/Sonarr flags is a problem too, whatever qBittorrent says.
  const attention = items.filter((i) => isAttention(i.state) || i.message);
  const rest = items.filter((i) => !attention.includes(i));
  const byTmdb = new Map<string, DownloadItem>();
  for (const q of queue) {
    const it = items.find((i) => i.hash === q.downloadId);
    if (it && q.tmdbId) byTmdb.set(`${q.source === 'radarr' ? 'movie' : 'tv'}:${q.tmdbId}`, it);
  }

  const requests: RequestItem[] = [];
  for (const r of reqs) {
    const key = `${r.media.mediaType}:${r.media.tmdbId}`;
    let tk = titles.get(key);
    let name = tk ? { title: tk.title, year: tk.year, posterPath: tk.poster } : tmdbNames.get(key);
    if (!tk && name === undefined) {
      name = await d.tmdb.basic(r.media.mediaType, r.media.tmdbId).catch(() => null);
      tmdbNames.set(key, name);
    }
    const dl = byTmdb.get(key);
    const state: RequestState = r.status === 3 ? 'declined' : r.status === 4 ? 'failed'
      : r.media.status === 5 || r.media.status === 4 ? 'available' : dl ? 'downloading' : 'requested';
    requests.push({
      id: r.id, tmdbType: r.media.mediaType, tmdbId: r.media.tmdbId, title: name?.title ?? `TMDB ${r.media.tmdbId}`, year: name?.year ?? null,
      titleId: tk?.id ?? null, posterUrl: poster(name?.posterPath ?? null), state, progress: dl ? dl.progress : null,
      requestedAt: r.createdAt ?? null, updatedAt: r.updatedAt ?? null, seasons: r.seasons.map((s) => s.seasonNumber),
    });
  }

  const value: DownloadsResponse = {
    at: now.toISOString(),
    qbit: {
      configured: !!d.qbit, connected: !!d.qbit && !errors.includes('qBittorrent'), error: errors.includes('qBittorrent') ? d.qbit?.loginProblem ?? 'Can’t reach qBittorrent' : null,
      downSpeed: transfer?.dl_info_speed ?? 0, upSpeed: transfer?.up_info_speed ?? 0, seeding: torrents.filter(isSeeding).length,
      vpn: transfer ? transfer.connection_status : null,
    },
    attention: attention.sort((a, b) => (a.since ?? '').localeCompare(b.since ?? '')),
    downloading: rest.filter((i) => i.state === 'downloading' || i.state === 'importing').sort((a, b) => b.progress - a.progress),
    queued: rest.filter((i) => i.state === 'queued' || i.state === 'paused'),
    requests,
    errors: [...new Set(errors)],
  };
  cache = { at: now.getTime(), value };
  return value;
}
const db = (d: DownloadDeps) => d.db;

/** For a title's Request button: is it downloading, and how far along. */
export function titleDownload(snapshot: DownloadsResponse, tmdbType: 'movie' | 'tv' | null, tmdbId: number | null, titleId: number): TitleDownload | null {
  const it = [...snapshot.attention, ...snapshot.downloading, ...snapshot.queued].find((i) => i.titleId === titleId);
  if (!it) return null;
  void tmdbType; void tmdbId;
  return { state: it.state, progress: it.progress, etaSeconds: it.etaSeconds };
}

export interface StuckSummary { at: string; configured: boolean; attention: { key: string; title: string; since: string | null; state: DownloadState; message: string | null }[]; downloading: number }

/** Every few minutes: remember what's stuck, for the More badge and the alert check. */
export async function watchDownloads(d: DownloadDeps, now = new Date()): Promise<StuckSummary> {
  resetDownloadsCache();
  const s = await downloadsSnapshot(d, now);
  const summary: StuckSummary = {
    at: s.at, configured: s.qbit.configured,
    attention: s.attention.map((i) => ({ key: i.hash ?? i.name, title: i.subtitle ? `${i.title} ${i.subtitle.split(' · ')[0]}` : i.title, since: i.since, state: i.state, message: i.message })),
    downloading: s.downloading.length,
  };
  setJobState(d.db, 'downloads', summary, now.toISOString());
  return summary;
}

export const lastDownloads = (db: Db) => getJobState<StuckSummary>(db, 'downloads')?.value ?? null;
