import { z } from 'zod';
import { requestJson, type FetchFn } from './http.js';

export const SeerrMedia = z.object({
  id: z.number().int(),
  mediaType: z.enum(['movie', 'tv']),
  tmdbId: z.number().int(),
  status: z.number().int(),
  status4k: z.number().int().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  seasons: z.array(z.object({
    seasonNumber: z.number().int(),
    status: z.number().int(),
    status4k: z.number().int().nullable().optional(),
  }).passthrough()).optional().default([]),
});
export type SeerrMedia = z.infer<typeof SeerrMedia>;

const MediaPage = z.object({
  pageInfo: z.object({ pages: z.number().int(), pageSize: z.number().int(), results: z.number().int(), page: z.number().int() }),
  results: z.array(z.unknown()),
});

const Status = z.object({ version: z.string() }).passthrough();

const PublicSettings = z.object({
  partialRequestsEnabled: z.boolean().optional().default(true),
  enableSpecialEpisodes: z.boolean().optional().default(false),
}).passthrough();
export type SeerrPublicSettings = z.infer<typeof PublicSettings>;

const SeasonStatus = z.object({ seasonNumber: z.number().int(), status: z.number().int() }).passthrough();
const TvDetail = z.object({
  id: z.number().int(),
  seasons: z.array(z.object({
    seasonNumber: z.number().int(),
    episodeCount: z.number().int().optional().default(0),
    name: z.string().optional(),
    airDate: z.string().nullable().optional(),
  }).passthrough()).optional().default([]),
  mediaInfo: z.object({
    status: z.number().int(),
    seasons: z.array(SeasonStatus).optional().default([]),
    requests: z.array(z.object({
      status: z.number().int(),
      is4k: z.boolean().optional().default(false),
      seasons: z.array(SeasonStatus).optional().default([]),
    }).passthrough()).optional().default([]),
  }).passthrough().nullable().optional(),
}).passthrough();
export type SeerrTvDetail = z.infer<typeof TvDetail>;

// Seerr media status values (Seerr 3.x).
export const MEDIA_STATUS = {
  UNKNOWN: 1, PENDING: 2, PROCESSING: 3, PARTIALLY_AVAILABLE: 4, AVAILABLE: 5, BLOCKLISTED: 6, DELETED: 7,
} as const;
// Seerr request status values.
export const REQUEST_STATUS = { PENDING: 1, APPROVED: 2, DECLINED: 3, FAILED: 4, COMPLETED: 5 } as const;

const RequestRow = z.object({
  id: z.number().int(),
  status: z.number().int(),                // 1 pending approval, 2 approved, 3 declined, 4 failed, 5 completed
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  type: z.enum(['movie', 'tv']).optional(),
  seasons: z.array(z.object({ seasonNumber: z.number().int() }).passthrough()).optional().default([]),
  media: z.object({
    tmdbId: z.number().int(),
    mediaType: z.enum(['movie', 'tv']),
    status: z.number().int(),              // 1 unknown, 2 pending, 3 processing, 4 partial, 5 available
  }).passthrough(),
}).passthrough();
export type SeerrRequest = z.infer<typeof RequestRow>;

export interface CreateRequest { mediaType: 'movie' | 'tv'; mediaId: number; seasons?: number[] }

export class SeerrClient {
  constructor(
    private base: string,
    private apiKey: string,
    private fetchFn: FetchFn = fetch,
    /** Seerr user to request as (X-API-User). Without it, requests belong to the API key's owner, the admin. */
    private userId?: number,
  ) {}

  private url(path: string) { return `${this.base.replace(/\/$/, '')}${path}`; }
  private headers() { return { 'X-Api-Key': this.apiKey, ...(this.userId ? { 'X-API-User': String(this.userId) } : {}) }; }

  async status() {
    return Status.parse(await requestJson<unknown>(this.fetchFn, 'seerr', this.url('/api/v1/status'), {
      headers: { 'X-Api-Key': this.apiKey }, retries: 1,
    }));
  }

  /** One page of tracked media. `skip` is an offset, `take` up to 100. */
  async mediaPage(skip: number, take = 100) {
    const q = new URLSearchParams({ take: String(take), skip: String(skip), filter: 'all', sort: 'added' });
    const body = MediaPage.parse(await requestJson<unknown>(this.fetchFn, 'seerr', this.url(`/api/v1/media?${q}`), {
      headers: { 'X-Api-Key': this.apiKey },
    }));
    const media: SeerrMedia[] = [];
    let invalid = 0;
    for (const raw of body.results) {
      const m = SeerrMedia.safeParse(raw);
      if (m.success) media.push(m.data); else invalid += 1;
    }
    return { media, invalid, total: body.pageInfo.results, pageSize: body.pageInfo.pageSize };
  }

  async publicSettings(): Promise<SeerrPublicSettings> {
    return PublicSettings.parse(await requestJson<unknown>(this.fetchFn, 'seerr', this.url('/api/v1/settings/public'), {
      headers: { 'X-Api-Key': this.apiKey }, retries: 1,
    }));
  }

  /** Seerr's series page data: seasons plus what's available or requested. */
  async tv(tmdbId: number): Promise<SeerrTvDetail> {
    return TvDetail.parse(await requestJson<unknown>(this.fetchFn, 'seerr', this.url(`/api/v1/tv/${tmdbId}`), {
      headers: { 'X-Api-Key': this.apiKey }, retries: 1,
    }));
  }

  /** Recent requests, newest first. */
  async requests(take = 50): Promise<SeerrRequest[]> {
    const q = new URLSearchParams({ take: String(take), skip: '0', filter: 'all', sort: 'added' });
    const body = z.object({ results: z.array(z.unknown()) }).passthrough().parse(
      await requestJson<unknown>(this.fetchFn, 'seerr', this.url(`/api/v1/request?${q}`), { headers: { 'X-Api-Key': this.apiKey }, retries: 1 }));
    return body.results.flatMap((r) => { const x = RequestRow.safeParse(r); return x.success ? [x.data] : []; });
  }

  /** Cancels (deletes) a request. Never retried. */
  async deleteRequest(id: number) {
    return requestJson<unknown>(this.fetchFn, 'seerr', this.url(`/api/v1/request/${id}`), { method: 'DELETE', headers: this.headers(), retries: 0 });
  }

  /** Sends a failed request to Radarr or Sonarr again. Never retried. */
  async retryRequest(id: number) {
    return requestJson<unknown>(this.fetchFn, 'seerr', this.url(`/api/v1/request/${id}/retry`), { method: 'POST', headers: this.headers(), retries: 0, timeoutMs: 30_000 });
  }

  /**
   * Creates a request. Seerr answers 201 (created), 202 (nothing left to request),
   * 403 (permission, quota or blocklist) or 409 (already requested). Never retried:
   * a timed-out POST may have gone through.
   */
  async createRequest(body: CreateRequest): Promise<unknown> {
    return requestJson<unknown>(this.fetchFn, 'seerr', this.url('/api/v1/request'), {
      method: 'POST',
      headers: this.headers(),
      body: { ...body, is4k: false },
      retries: 0,
      timeoutMs: 30_000,
    });
  }
}
