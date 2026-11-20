// Fake upstream APIs for tests. Built on the M0 fixtures recorded from the
// real services on MonkeyServer (scrubbed), so shapes match production.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchFn } from '../clients/http.js';
import type { WatchmodeTitle } from '../clients/watchmode.js';

export const FIXTURES = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'm0');

export function fixture<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8')) as T;
}

export function realCatalog(): WatchmodeTitle[] {
  return fixture<WatchmodeTitle[]>('watchmode/catalog-snapshot.json');
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Watchmode with a mutable catalog, a credit counter, and fault injection. */
export class FakeWatchmode {
  catalog: WatchmodeTitle[];
  quota = 2500;
  used = 58;
  failPages = new Set<number>();      // these pages always return 500
  flakyPages = new Set<number>();     // these pages fail once with 429, then work
  authFail = false;
  calls: string[] = [];
  constructor(catalog: WatchmodeTitle[] = realCatalog()) { this.catalog = catalog; }

  fetch: FetchFn = async (input) => {
    const url = new URL(String(input));
    this.calls.push(url.pathname + url.search);
    if (this.authFail) return json(401, { success: false, statusMessage: 'Invalid API key' });
    if (url.pathname.endsWith('/status/')) return json(200, { quota: this.quota, quotaUsed: this.used });
    if (url.pathname.endsWith('/list-titles/')) {
      const page = Number(url.searchParams.get('page'));
      const limit = Number(url.searchParams.get('limit'));
      if (this.failPages.has(page)) return json(500, { statusMessage: 'boom' });
      if (this.flakyPages.has(page)) { this.flakyPages.delete(page); return json(429, {}, { 'retry-after': '0' }); }
      this.used += 1;
      const sorted = [...this.catalog].sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id);
      const totalPages = Math.max(1, Math.ceil(sorted.length / limit));
      return json(200, { titles: sorted.slice((page - 1) * limit, page * limit), page, total_results: sorted.length, total_pages: totalPages });
    }
    return json(404, {});
  };
}

/** TMDB serving the recorded movie and TV details for any id, with overrides. */
export class FakeTmdb {
  calls = 0;
  missing = new Set<string>();                         // "movie:123" -> 404
  overrides = new Map<string, Record<string, unknown>>();
  failOnce = new Set<string>();                        // 500 once, then ok
  private movie = fixture<Record<string, unknown>>('tmdb/movie-detail.json');
  private tv = fixture<Record<string, unknown>>('tmdb/tv-detail.json');

  fetch: FetchFn = async (input) => {
    this.calls += 1;
    const url = new URL(String(input));
    const m = url.pathname.match(/\/(movie|tv)\/(\d+)$/);
    if (!m) return json(404, {});
    const key = `${m[1]}:${m[2]}`;
    if (this.missing.has(key)) return json(404, { status_code: 34, status_message: 'not found' });
    if (this.failOnce.has(key)) { this.failOnce.delete(key); return json(500, {}); }
    const base = m[1] === 'movie' ? this.movie : this.tv;
    return json(200, { ...base, id: Number(m[2]), ...(this.overrides.get(key) ?? {}) });
  };
}

/** Seerr /api/v1/media over a fixed list, paged like the real server. */
export class FakeSeerr {
  media: unknown[];
  fail = false;
  constructor(media?: unknown[]) {
    this.media = media ?? fixture<{ results: unknown[] }>('seerr/media.page1.json').results;
  }
  fetch: FetchFn = async (input) => {
    const url = new URL(String(input));
    if (this.fail) return json(500, {});
    if (url.pathname === '/api/v1/status') return json(200, { version: '3.3.0' });
    if (url.pathname === '/api/v1/media') {
      const take = Number(url.searchParams.get('take'));
      const skip = Number(url.searchParams.get('skip'));
      return json(200, {
        pageInfo: { pages: Math.ceil(this.media.length / take), pageSize: take, results: this.media.length, page: Math.floor(skip / take) + 1 },
        results: this.media.slice(skip, skip + take),
      });
    }
    return json(404, {});
  };
}
