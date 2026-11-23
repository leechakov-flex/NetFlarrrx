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

/** One result of an interactive search (what Radarr/Sonarr's "Interactive Search" shows). */
export interface Release {
  guid: string; indexerId: number; indexer: string; title: string;
  quality: string; resolution: number | null; size: number; ageDays: number | null;
  seeders: number | null; leechers: number | null; protocol: string; languages: string[];
  rejected: boolean; rejections: string[]; customFormatScore: number | null;
}
const ReleaseSchema = z.object({
  guid: z.string(), indexerId: z.number().int(), indexer: z.string().nullable().optional(), title: z.string().nullable().optional(),
  quality: z.object({ quality: z.object({ name: z.string().optional(), resolution: z.number().optional() }).passthrough().optional() }).passthrough().optional(),
  size: z.number().optional(), age: z.number().optional(), ageHours: z.number().optional(),
  seeders: z.number().nullable().optional(), leechers: z.number().nullable().optional(), protocol: z.string().optional(),
  languages: z.array(z.object({ name: z.string().optional() }).passthrough()).optional(),
  rejected: z.boolean().optional(), downloadAllowed: z.boolean().optional(),
  // Strings in Radarr/Sonarr v4-v5; objects ({ reason }) in some builds.
  rejections: z.array(z.union([z.string(), z.object({ reason: z.string().optional(), message: z.string().optional() }).passthrough()])).optional(),
  customFormatScore: z.number().nullable().optional(),
}).passthrough();

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

  /** Radarr's or Sonarr's own ID for a TMDB title, or null if it isn't in there. */
  async findId(tmdbId: number): Promise<number | null> {
    const path = this.name === 'radarr' ? `/api/v3/movie?tmdbId=${tmdbId}` : '/api/v3/series';
    const raw = await requestJson<unknown[]>(this.fetchFn, this.name, this.url(path), { headers: { 'X-Api-Key': this.apiKey }, timeoutMs: 60_000 });
    const hit = z.array(z.object({ id: z.number().int(), tmdbId: z.number().int().nullable().optional() }).passthrough()).parse(raw)
      .find((x) => x.tmdbId === tmdbId);
    return hit?.id ?? null;
  }

  /**
   * Interactive search: asks every indexer and returns what it found, with the reasons
   * Radarr/Sonarr would skip each result. Grabs nothing. Can take a minute.
   */
  async releases(arrId: number, season?: number): Promise<Release[]> {
    const q = this.name === 'radarr' ? `movieId=${arrId}` : `seriesId=${arrId}${season != null ? `&seasonNumber=${season}` : ''}`;
    const raw = await requestJson<unknown[]>(this.fetchFn, this.name, this.url(`/api/v3/release?${q}`), { headers: { 'X-Api-Key': this.apiKey }, timeoutMs: 150_000, retries: 0 });
    return z.array(z.unknown()).parse(raw).flatMap((r) => {
      const x = ReleaseSchema.safeParse(r);
      if (!x.success) return [];
      const d = x.data;
      const rejections = (d.rejections ?? []).map((j) => (typeof j === 'string' ? j : j.reason ?? j.message ?? '')).filter(Boolean);
      return [{
        guid: d.guid, indexerId: d.indexerId, indexer: d.indexer ?? '', title: d.title ?? '',
        quality: d.quality?.quality?.name ?? 'Unknown', resolution: d.quality?.quality?.resolution ?? null, size: d.size ?? 0,
        ageDays: d.age ?? (d.ageHours != null ? d.ageHours / 24 : null), seeders: d.seeders ?? null, leechers: d.leechers ?? null,
        protocol: d.protocol ?? 'torrent', languages: (d.languages ?? []).map((l) => l.name ?? '').filter(Boolean),
        rejected: d.rejected ?? rejections.length > 0, rejections, customFormatScore: d.customFormatScore ?? null,
      }];
    });
  }

  /** Grab one release from an interactive search (even one it would skip). */
  async grab(guid: string, indexerId: number): Promise<void> {
    await requestJson<unknown>(this.fetchFn, this.name, this.url('/api/v3/release'),
      { method: 'POST', body: { guid, indexerId }, headers: { 'X-Api-Key': this.apiKey }, timeoutMs: 60_000, retries: 0 });
  }

  /** The normal automatic search: grabs the best release it would accept, if any. */
  async search(arrId: number, season?: number): Promise<void> {
    const body = this.name === 'radarr' ? { name: 'MoviesSearch', movieIds: [arrId] }
      : season != null ? { name: 'SeasonSearch', seriesId: arrId, seasonNumber: season } : { name: 'SeriesSearch', seriesId: arrId };
    await requestJson<unknown>(this.fetchFn, this.name, this.url('/api/v3/command'),
      { method: 'POST', body, headers: { 'X-Api-Key': this.apiKey }, timeoutMs: 30_000, retries: 1 });
  }

  /**
   * Remove a title from Radarr/Sonarr and delete its files from disk. It stops being
   * watched for new releases. No import exclusion, so it can be requested again later.
   */
  async remove(arrId: number): Promise<void> {
    const path = this.name === 'radarr' ? `/api/v3/movie/${arrId}?deleteFiles=true&addImportExclusion=false`
      : `/api/v3/series/${arrId}?deleteFiles=true&addImportListExclusion=false`;
    await requestJson<unknown>(this.fetchFn, this.name, this.url(path), { method: 'DELETE', headers: { 'X-Api-Key': this.apiKey }, timeoutMs: 120_000, retries: 0 });
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
