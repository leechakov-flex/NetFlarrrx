import { z } from 'zod';
import { requestJson, Throttle, type FetchFn } from './http.js';

export const WatchmodeTitle = z.object({
  id: z.number().int(),
  title: z.string(),
  year: z.number().int().nullable().optional(),
  imdb_id: z.string().nullable().optional(),
  tmdb_id: z.number().int().nullable().optional(),
  tmdb_type: z.enum(['movie', 'tv']).nullable().optional().catch(null),
  type: z.string(),
});
export type WatchmodeTitle = z.infer<typeof WatchmodeTitle>;

const ListTitlesPage = z.object({
  titles: z.array(z.unknown()),
  page: z.number().int(),
  total_pages: z.number().int(),
  total_results: z.number().int(),
});

const Status = z.object({ quota: z.number(), quotaUsed: z.number() });
export type WatchmodeStatus = z.infer<typeof Status>;

export interface ListPage {
  titles: WatchmodeTitle[];
  invalid: number;              // rows that failed validation and were skipped
  page: number;
  totalPages: number;
  totalResults: number;
}

export class WatchmodeClient {
  private throttle: Throttle;
  constructor(
    private base: string,
    private apiKey: string,
    private fetchFn: FetchFn = fetch,
    minIntervalMs = 600,
  ) {
    this.throttle = new Throttle(minIntervalMs);
  }

  private async get(path: string, retries?: number) {
    await this.throttle.wait();
    return requestJson<unknown>(this.fetchFn, 'watchmode', `${this.base.replace(/\/$/, '')}${path}`, {
      headers: { 'X-API-Key': this.apiKey },
      retries,
    });
  }

  /** Quota check. Costs 0 credits. */
  async status(): Promise<WatchmodeStatus> {
    return Status.parse(await this.get('/status/'));
  }

  /** One page of a source's catalog. Costs 1 credit. Sorted by title for stable paging. */
  async listTitlesPage(sourceId: number, region: string, page: number): Promise<ListPage> {
    const q = new URLSearchParams({
      source_ids: String(sourceId),
      regions: region,
      sort_by: 'title_asc',
      limit: '250',
      page: String(page),
    });
    const body = ListTitlesPage.parse(await this.get(`/list-titles/?${q}`));
    const titles: WatchmodeTitle[] = [];
    let invalid = 0;
    for (const raw of body.titles) {
      const t = WatchmodeTitle.safeParse(raw);
      if (t.success) titles.push(t.data); else invalid += 1;
    }
    return { titles, invalid, page: body.page, totalPages: body.total_pages, totalResults: body.total_results };
  }
}
