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
}).passthrough();

const SonarrSeries = z.object({
  title: z.string(),
  tvdbId: z.number().int().optional(),
  tmdbId: z.number().int().optional(),       // Sonarr v4
  added: z.string().nullable().optional(),
  statistics: z.object({ episodeFileCount: z.number().int().optional().default(0) }).passthrough().optional(),
}).passthrough();

export interface ArrItem { title: string; tmdbId: number | null; tvdbId?: number | null; added: string | null }

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

  /** Series with at least one episode on disk. */
  async series(): Promise<ArrItem[]> {
    const raw = await requestJson<unknown[]>(this.fetchFn, this.name, this.url('/api/v3/series'), { headers: { 'X-Api-Key': this.apiKey }, timeoutMs: 60_000 });
    return z.array(z.unknown()).parse(raw).flatMap((r) => {
      const s = SonarrSeries.safeParse(r);
      if (!s.success || (s.data.statistics?.episodeFileCount ?? 0) === 0) return [];
      return [{ title: s.data.title, tmdbId: s.data.tmdbId || null, tvdbId: s.data.tvdbId ?? null, added: s.data.added ?? null }];
    });
  }
}
