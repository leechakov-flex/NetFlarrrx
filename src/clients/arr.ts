import { z } from 'zod';
import { requestJson, type FetchFn } from './http.js';

/**
 * Read-only access to Radarr and Sonarr, for what's in your library.
 * Only GET /api/v3/movie and /api/v3/series are used; nothing is changed.
 */
const RadarrMovie = z.object({
  title: z.string(),
  tmdbId: z.number().int().optional(),
  hasFile: z.boolean().optional().default(false),
  added: z.string().nullable().optional(),
  isAvailable: z.boolean().optional(),                 // past Radarr's "minimum availability"
  inCinemas: z.string().nullable().optional(),
  digitalRelease: z.string().nullable().optional(),
  physicalRelease: z.string().nullable().optional(),
}).passthrough();

const SonarrSeries = z.object({
  title: z.string(),
  tvdbId: z.number().int().optional(),
  tmdbId: z.number().int().optional(),       // Sonarr v4
  added: z.string().nullable().optional(),
  statistics: z.object({ episodeFileCount: z.number().int().optional().default(0) }).passthrough().optional(),
  seasons: z.array(z.object({
    seasonNumber: z.number().int(), monitored: z.boolean().optional().default(false),
    statistics: z.object({
      episodeFileCount: z.number().int().optional().default(0),
      previousAiring: z.string().nullable().optional(),   // latest episode that has aired
      nextAiring: z.string().nullable().optional(),
    }).passthrough().optional(),
  }).passthrough()).optional().default([]),
}).passthrough();

export interface ArrItem {
  title: string; tmdbId: number | null; tvdbId?: number | null; added: string | null;
  /** Series: the highest season with files, and the seasons Sonarr is set to download. */
  haveSeason?: number | null; haveSeasons?: number[]; monitoredSeasons?: number[];
}

/** Release and file state per title, for request statuses. */
export interface MovieStatus { hasFile: boolean; isAvailable: boolean; nextRelease: string | null; releasedAt: string | null }
export interface SeasonStatus { files: number; aired: boolean; nextAiring: string | null; lastAired: string | null }

/** One download Radarr or Sonarr is tracking (GET /api/v3/queue). */
export interface QueueItem {
  downloadId: string | null;       // the torrent hash, upper case
  source: 'radarr' | 'sonarr';
  title: string;                   // movie or series title
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  posterUrl: string | null;
  status: string;                  // downloading, queued, paused, completed, warning, failed, delay
  trackedStatus: string | null;    // ok, warning, error
  messages: string[];
  sizeLeft: number;
  size: number;
}

const QueueRecord = z.object({
  downloadId: z.string().nullable().optional(),
  status: z.string().optional().default(''),
  trackedDownloadStatus: z.string().nullable().optional(),
  statusMessages: z.array(z.object({ title: z.string().optional(), messages: z.array(z.string()).optional().default([]) })).optional().default([]),
  errorMessage: z.string().nullable().optional(),
  size: z.number().optional().default(0),
  sizeleft: z.number().optional().default(0),
  movie: z.object({ title: z.string(), year: z.number().int().nullable().optional(), tmdbId: z.number().int().optional(),
    images: z.array(z.object({ coverType: z.string(), remoteUrl: z.string().nullable().optional() })).optional().default([]) }).passthrough().optional(),
  series: z.object({ title: z.string(), year: z.number().int().nullable().optional(), tvdbId: z.number().int().optional(), tmdbId: z.number().int().optional(),
    images: z.array(z.object({ coverType: z.string(), remoteUrl: z.string().nullable().optional() })).optional().default([]) }).passthrough().optional(),
  episode: z.object({ seasonNumber: z.number().int(), episodeNumber: z.number().int(), title: z.string().nullable().optional() }).passthrough().optional(),
}).passthrough();

export class ArrClient {
  constructor(private base: string, private apiKey: string, private fetchFn: FetchFn = fetch, private name: 'radarr' | 'sonarr') {}
  private url(path: string) { return `${this.base.replace(/\/$/, '')}${path}`; }

  /** Movies with a file on disk. */
  async movies(): Promise<ArrItem[]> {
    const raw = await requestJson<unknown[]>(this.fetchFn, this.name, this.url('/api/v3/movie'), { headers: { 'X-Api-Key': this.apiKey }, timeoutMs: 60_000 });
    return z.array(z.unknown()).parse(raw).flatMap((r) => {
      const m = RadarrMovie.safeParse(r);
      return m.success && m.data.hasFile ? [{ title: m.data.title, tmdbId: m.data.tmdbId || null, added: m.data.added ?? null }] : [];
    });
  }

  /** Every movie in Radarr: has it a file, and is it out yet (by tmdbId). */
  async movieStatus(now = new Date()): Promise<Map<number, MovieStatus>> {
    const raw = await requestJson<unknown[]>(this.fetchFn, this.name, this.url('/api/v3/movie'), { headers: { 'X-Api-Key': this.apiKey }, timeoutMs: 60_000 });
    const out = new Map<number, MovieStatus>();
    for (const r of z.array(z.unknown()).parse(raw)) {
      const m = RadarrMovie.safeParse(r);
      if (!m.success || !m.data.tmdbId) continue;
      const home = [m.data.digitalRelease, m.data.physicalRelease].filter((x): x is string => !!x).sort();
      const past = home.filter((x) => Date.parse(x) <= now.getTime());
      out.set(m.data.tmdbId, {
        hasFile: m.data.hasFile,
        // Without Radarr's flag, out means a digital or disc release has happened.
        isAvailable: m.data.isAvailable ?? past.length > 0,
        nextRelease: home.find((x) => Date.parse(x) > now.getTime()) ?? null,
        releasedAt: past[0] ?? null,
      });
    }
    return out;
  }

  /** Every series in Sonarr, per season: files on disk and whether it has started airing (by tmdbId). */
  async seasonStatus(): Promise<Map<number, Map<number, SeasonStatus>>> {
    const raw = await requestJson<unknown[]>(this.fetchFn, this.name, this.url('/api/v3/series'), { headers: { 'X-Api-Key': this.apiKey }, timeoutMs: 60_000 });
    const out = new Map<number, Map<number, SeasonStatus>>();
    for (const r of z.array(z.unknown()).parse(raw)) {
      const s = SonarrSeries.safeParse(r);
      if (!s.success || !s.data.tmdbId) continue;
      out.set(s.data.tmdbId, new Map(s.data.seasons.filter((x) => x.seasonNumber > 0).map((x) => [x.seasonNumber, {
        files: x.statistics?.episodeFileCount ?? 0, aired: !!x.statistics?.previousAiring,
        nextAiring: x.statistics?.nextAiring ?? null, lastAired: x.statistics?.previousAiring ?? null,
      }])));
    }
    return out;
  }

  /** Series with at least one episode on disk. */
  async series(): Promise<ArrItem[]> {
    const raw = await requestJson<unknown[]>(this.fetchFn, this.name, this.url('/api/v3/series'), { headers: { 'X-Api-Key': this.apiKey }, timeoutMs: 60_000 });
    return z.array(z.unknown()).parse(raw).flatMap((r) => {
      const s = SonarrSeries.safeParse(r);
      if (!s.success || (s.data.statistics?.episodeFileCount ?? 0) === 0) return [];
      const real = s.data.seasons.filter((x) => x.seasonNumber > 0);
      const have = real.filter((x) => (x.statistics?.episodeFileCount ?? 0) > 0).map((x) => x.seasonNumber);
      return [{ title: s.data.title, tmdbId: s.data.tmdbId || null, tvdbId: s.data.tvdbId ?? null, added: s.data.added ?? null,
        haveSeason: have.length ? Math.max(...have) : null, haveSeasons: have, monitoredSeasons: real.filter((x) => x.monitored).map((x) => x.seasonNumber) }];
    });
  }

  /** What's downloading right now, with the movie or series it's for. Read only. */
  async queue(): Promise<QueueItem[]> {
    const include = this.name === 'radarr' ? 'includeMovie=true' : 'includeSeries=true&includeEpisode=true';
    const raw = await requestJson<unknown>(this.fetchFn, this.name, this.url(`/api/v3/queue?page=1&pageSize=200&${include}`),
      { headers: { 'X-Api-Key': this.apiKey }, timeoutMs: 20_000, retries: 1 });
    const records = z.object({ records: z.array(z.unknown()).optional().default([]) }).passthrough().parse(raw).records;
    return records.flatMap((r) => {
      const q = QueueRecord.safeParse(r);
      if (!q.success) return [];
      const d = q.data, m = d.movie, s = d.series;
      const media = m ?? s;
      return [{
        downloadId: d.downloadId?.toUpperCase() ?? null, source: this.name,
        title: media?.title ?? 'Unknown', year: media?.year ?? null,
        tmdbId: m?.tmdbId ?? s?.tmdbId ?? null, tvdbId: s?.tvdbId ?? null,
        season: d.episode?.seasonNumber ?? null, episode: d.episode?.episodeNumber ?? null, episodeTitle: d.episode?.title ?? null,
        posterUrl: media?.images.find((i) => i.coverType === 'poster')?.remoteUrl ?? null,
        status: d.status, trackedStatus: d.trackedDownloadStatus ?? null,
        messages: [...d.statusMessages.flatMap((x) => x.messages), ...(d.errorMessage ? [d.errorMessage] : [])].slice(0, 4),
        size: d.size, sizeLeft: d.sizeleft,
      }];
    });
  }
}
