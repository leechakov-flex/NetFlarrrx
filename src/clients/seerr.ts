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

// Seerr media status values (Seerr 3.x).
export const MEDIA_STATUS = {
  UNKNOWN: 1, PENDING: 2, PROCESSING: 3, PARTIALLY_AVAILABLE: 4, AVAILABLE: 5, BLOCKLISTED: 6, DELETED: 7,
} as const;

export class SeerrClient {
  constructor(private base: string, private apiKey: string, private fetchFn: FetchFn = fetch) {}

  private url(path: string) { return `${this.base.replace(/\/$/, '')}${path}`; }

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
}
