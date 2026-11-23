import { z } from 'zod';
import { requestJson, type FetchFn } from './http.js';

/**
 * MDBList (api.mdblist.com): public, curated and auto-updating movie and TV lists.
 * Read-only. The key goes in the query string, as MDBList expects. The free tier
 * allows 1,000 requests a day; MonkeySee uses about one per list per day.
 */
const List = z.object({
  id: z.number().int(), name: z.string(), slug: z.string().nullish(), description: z.string().nullish(),
  mediatype: z.string().nullish(), items: z.number().int().nullish(), likes: z.number().int().nullish(),
  user_name: z.string().nullish(),
}).passthrough();
const Item = z.object({
  id: z.number().int().nullish(),            // TMDB ID
  rank: z.number().int().nullish(),
  title: z.string().nullish(),
  imdb_id: z.string().nullish(),
  mediatype: z.string().nullish(),           // "movie" or "show"
  release_year: z.number().int().nullish(),
}).passthrough();

export interface MdbList { id: number; name: string; userName: string | null; slug: string | null; description: string | null; mediatype: string | null; items: number | null; likes: number | null }
export interface MdbItem { tmdbType: 'movie' | 'tv'; tmdbId: number; rank: number; title: string | null }

const toList = (l: z.infer<typeof List>): MdbList => ({
  id: l.id, name: l.name, userName: l.user_name ?? null, slug: l.slug ?? null, description: l.description ?? null,
  mediatype: l.mediatype ?? null, items: l.items ?? null, likes: l.likes ?? null,
});

export class MdbListClient {
  constructor(private apiKey: string, private fetchFn: FetchFn = fetch, private base = 'https://api.mdblist.com') {}
  private url(path: string, q: Record<string, string> = {}) {
    return `${this.base.replace(/\/$/, '')}${path}?${new URLSearchParams({ ...q, apikey: this.apiKey })}`;
  }
  private async lists(path: string, q?: Record<string, string>): Promise<MdbList[]> {
    const raw = await requestJson<unknown>(this.fetchFn, 'mdblist', this.url(path, q), { timeoutMs: 30_000, retries: 1 });
    return z.array(z.unknown()).parse(raw).flatMap((x) => { const l = List.safeParse(x); return l.success ? [toList(l.data)] : []; });
  }
  /** Public lists whose title matches. */
  search(query: string) { return this.lists('/lists/search', { query }); }
  /** The most-liked public lists. */
  top() { return this.lists('/lists/top'); }
  async list(id: number): Promise<MdbList | null> { return (await this.lists(`/lists/${id}`))[0] ?? null; }

  /** A list's titles in its own order. Answers either { movies, shows } or a flat array. */
  async items(id: number): Promise<MdbItem[]> {
    const raw = await requestJson<unknown>(this.fetchFn, 'mdblist', this.url(`/lists/${id}/items`), { timeoutMs: 60_000, retries: 1 });
    const flat = Array.isArray(raw) ? raw
      : [...((raw as { movies?: unknown[] }).movies ?? []), ...((raw as { shows?: unknown[] }).shows ?? [])];
    const out: MdbItem[] = [];
    flat.forEach((x, i) => {
      const r = Item.safeParse(x);
      if (!r.success || !r.data.id) return;
      const type = r.data.mediatype === 'show' || r.data.mediatype === 'tv' ? 'tv' : r.data.mediatype === 'movie' ? 'movie' : null;
      if (!type) return;
      out.push({ tmdbType: type, tmdbId: r.data.id, rank: r.data.rank ?? i + 1, title: r.data.title ?? null });
    });
    return out;
  }
}
