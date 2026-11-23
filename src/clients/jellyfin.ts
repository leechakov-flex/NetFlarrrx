import { z } from 'zod';
import { HttpError, requestJson, type FetchFn } from './http.js';

/**
 * Jellyfin API: every movie and series in your libraries, with their TMDB IDs, and
 * their poster images. The only changes it makes are a library rescan and, when you
 * remove something Radarr/Sonarr don't know about, deleting that item.
 */
const Item = z.object({
  Id: z.string(),
  Name: z.string().optional().default(''),
  Type: z.string(),
  ProductionYear: z.number().int().nullable().optional(),
  DateCreated: z.string().nullable().optional(),
  ProviderIds: z.record(z.string(), z.string().nullable()).nullable().optional(),
  ImageTags: z.record(z.string(), z.string()).nullable().optional(),
  ChildCount: z.number().int().nullable().optional(),      // series: seasons
}).passthrough();

export interface JellyfinItem {
  id: string; type: 'movie' | 'tv'; name: string; year: number | null; addedAt: string | null;
  tmdbId: number | null; hasPoster: boolean; seasons: number | null;
}

export class JellyfinClient {
  constructor(private base: string, private apiKey: string, private fetchFn: FetchFn = fetch) {}
  private url(p: string) { return `${this.base.replace(/\/$/, '')}${p}`; }
  private get headers() { return { Authorization: `MediaBrowser Token="${this.apiKey}"`, Accept: 'application/json' }; }

  /** All movies and series, a page at a time. */
  async items(): Promise<JellyfinItem[]> {
    const out: JellyfinItem[] = [];
    for (let start = 0; ; start += 500) {
      const q = new URLSearchParams({ IncludeItemTypes: 'Movie,Series', Recursive: 'true', Fields: 'ProviderIds,DateCreated,ChildCount',
        StartIndex: String(start), Limit: '500', SortBy: 'DateCreated', SortOrder: 'Descending' });
      const body = z.object({ Items: z.array(z.unknown()).optional().default([]), TotalRecordCount: z.number().optional() }).passthrough()
        .parse(await requestJson<unknown>(this.fetchFn, 'jellyfin', this.url(`/Items?${q}`), { headers: this.headers, timeoutMs: 60_000, retries: 1 }));
      for (const raw of body.Items) {
        const r = Item.safeParse(raw);
        if (!r.success || (r.data.Type !== 'Movie' && r.data.Type !== 'Series')) continue;
        const tmdb = Number(r.data.ProviderIds?.Tmdb ?? r.data.ProviderIds?.tmdb ?? NaN);
        out.push({
          id: r.data.Id, type: r.data.Type === 'Movie' ? 'movie' : 'tv', name: r.data.Name, year: r.data.ProductionYear ?? null,
          addedAt: r.data.DateCreated ?? null, tmdbId: Number.isInteger(tmdb) && tmdb > 0 ? tmdb : null,
          hasPoster: !!r.data.ImageTags?.Primary, seasons: r.data.Type === 'Series' ? r.data.ChildCount ?? null : null,
        });
      }
      if (body.Items.length < 500) break;
    }
    return out;
  }

  /** Delete an item and its files. Only for things Radarr/Sonarr don't manage. */
  async deleteItem(id: string): Promise<void> {
    await requestJson<unknown>(this.fetchFn, 'jellyfin', this.url(`/Items/${encodeURIComponent(id)}`), { method: 'DELETE', headers: this.headers, timeoutMs: 60_000, retries: 0 });
  }

  /** Rescan the libraries, so removed files disappear from Jellyfin promptly. */
  async refresh(): Promise<void> {
    await requestJson<unknown>(this.fetchFn, 'jellyfin', this.url('/Library/Refresh'), { method: 'POST', headers: this.headers, timeoutMs: 30_000, retries: 0 });
  }

  /** A poster image, for MonkeySee to pass on (Jellyfin isn't reachable from your phone by its Docker name). */
  async poster(id: string): Promise<Response> {
    const res = await this.fetchFn(this.url(`/Items/${encodeURIComponent(id)}/Images/Primary?maxHeight=480&quality=85`), { headers: this.headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new HttpError('jellyfin', res.status, this.url(`/Items/${id}/Images/Primary`), '');
    return res;
  }
}
