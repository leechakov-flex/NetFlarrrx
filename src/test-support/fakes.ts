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
  /** Catalogs for other services, by Watchmode source id. */
  otherSources = new Map<number, WatchmodeTitle[]>();
  sourceList = [{ id: 203, name: 'Netflix', type: 'sub' }, { id: 387, name: 'Max', type: 'sub' }, { id: 157, name: 'Hulu', type: 'sub' }];
  constructor(catalog: WatchmodeTitle[] = realCatalog()) { this.catalog = catalog; }

  fetch: FetchFn = async (input) => {
    const url = new URL(String(input));
    this.calls.push(url.pathname + url.search);
    if (this.authFail) return json(401, { success: false, statusMessage: 'Invalid API key' });
    if (url.pathname.endsWith('/status/')) return json(200, { quota: this.quota, quotaUsed: this.used });
    if (url.pathname.endsWith('/sources/')) return json(200, this.sourceList);
    if (url.pathname.endsWith('/list-titles/')) {
      const page = Number(url.searchParams.get('page'));
      const limit = Number(url.searchParams.get('limit'));
      if (this.failPages.has(page)) return json(500, { statusMessage: 'boom' });
      if (this.flakyPages.has(page)) { this.flakyPages.delete(page); return json(429, {}, { 'retry-after': '0' }); }
      this.used += 1;
      const types = url.searchParams.get('types')?.split(',');
      const source = Number(url.searchParams.get('source_ids'));
      const base = this.otherSources.get(source) ?? this.catalog;
      const sorted = [...base].filter((t) => !types || types.includes(t.type)).sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id);
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
  /** TMDB's own Netflix list for /discover, by type; 20 per page like the real API. */
  discover: Record<'movie' | 'tv', { id: number; title: string; popularity?: number }[]> = { movie: [], tv: [] };
  discoverFailPage: number | null = null;
  /** Answer discover queries by their parameters (overrides `discover`). Items may carry a date. */
  discoverBy: ((type: 'movie' | 'tv', params: URLSearchParams) => { id: number; title: string; date?: string; popularity?: number }[] | undefined) | null = null;
  /** TMDB recommendations per title ("movie:123" -> ids), for library seeds. */
  recs = new Map<string, number[]>();
  /** TVDB -> TMDB series IDs for /find. */
  find = new Map<number, number>();
  private movie = fixture<Record<string, unknown>>('tmdb/movie-detail.json');
  private tv = fixture<Record<string, unknown>>('tmdb/tv-detail.json');

  fetch: FetchFn = async (input) => {
    this.calls += 1;
    const url = new URL(String(input));
    const find = url.pathname.match(/\/find\/(\d+)$/);
    if (find) {
      const id = this.find.get(Number(find[1]));
      return json(200, { movie_results: [], tv_results: id ? [{ id }] : [] });
    }
    const disc = url.pathname.match(/\/discover\/(movie|tv)$/);
    if (disc) {
      const page = Number(url.searchParams.get('page') ?? 1);
      if (page === this.discoverFailPage) return json(500, {});
      const list: { id: number; title: string; date?: string; popularity?: number }[] =
        this.discoverBy?.(disc[1] as 'movie' | 'tv', url.searchParams) ?? this.discover[disc[1] as 'movie' | 'tv'];
      return json(200, {
        page, total_pages: Math.max(1, Math.ceil(list.length / 20)), total_results: list.length,
        results: list.slice((page - 1) * 20, page * 20).map((r) => disc[1] === 'movie'
          ? { id: r.id, title: r.title, release_date: r.date ?? '2020-01-01', popularity: r.popularity ?? 1 }
          : { id: r.id, name: r.title, first_air_date: r.date ?? '2020-01-01', popularity: r.popularity ?? 1 }),
      });
    }
    const m = url.pathname.match(/\/(movie|tv)\/(\d+)$/);
    if (!m) return json(404, {});
    const key = `${m[1]}:${m[2]}`;
    if (this.missing.has(key)) return json(404, { status_code: 34, status_message: 'not found' });
    if (this.failOnce.has(key)) { this.failOnce.delete(key); return json(500, {}); }
    const base = m[1] === 'movie' ? this.movie : this.tv;
    // The M0 recording didn't request videos or ratings, so add realistic ones.
    const extras = m[1] === 'movie'
      ? {
          videos: { results: [
            { key: 'teaser123', site: 'YouTube', type: 'Teaser', name: 'Teaser', official: true, iso_639_1: 'en', published_at: '2025-01-01T00:00:00Z' },
            { key: 'trailer456', site: 'YouTube', type: 'Trailer', name: 'Official Trailer', official: true, iso_639_1: 'en', published_at: '2025-02-01T00:00:00Z' },
          ] },
          release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: '' }, { certification: 'PG-13' }] }] },
        }
      : {
          videos: { results: [{ key: 'tvtrailer789', site: 'YouTube', type: 'Trailer', name: 'Season 1 Trailer', official: true, iso_639_1: 'en' }] },
          content_ratings: { results: [{ iso_3166_1: 'GB', rating: '15' }, { iso_3166_1: 'US', rating: 'TV-MA' }] },
        };
    const recs = (url.searchParams.get('append_to_response') ?? '').includes('recommendations')
      ? { recommendations: { page: 1, results: (this.recs.get(key) ?? []).map((id) => ({ id, media_type: m[1] })) } }
      : {};
    return json(200, { ...base, ...extras, ...recs, id: Number(m[2]), ...(this.overrides.get(key) ?? {}) });
  };
}

/**
 * Seerr: a mutable media list, series details, public settings, and request
 * creation that behaves like Seerr (records the request, marks media pending).
 */
export class FakeSeerr {
  media: Record<string, unknown>[];
  fail = false;
  settings = { partialRequestsEnabled: true, enableSpecialEpisodes: false };
  /** Seasons per TMDB series ID; unknown series get seasons 0-3. */
  seasonCounts = new Map<number, number>();
  requests: { mediaType: string; mediaId: number; seasons?: number[]; is4k: boolean; headers: Record<string, string> }[] = [];
  /** What GET /request lists (the Downloads page's "Your requests"); DELETE and retry act on it. */
  requestList: Record<string, unknown>[] = [];
  actions: string[] = [];
  /** Force the next POST /request to answer with this status (403, 409, 500...). */
  nextRequestStatus: number | null = null;
  constructor(media?: unknown[]) {
    this.media = (media ?? fixture<{ results: unknown[] }>('seerr/media.page1.json').results) as Record<string, unknown>[];
  }
  private find(type: string, tmdbId: number) {
    return this.media.find((m) => m.mediaType === type && m.tmdbId === tmdbId) as
      { status: number; seasons?: { seasonNumber: number; status: number }[] } | undefined;
  }
  fetch: FetchFn = async (input, init) => {
    const url = new URL(String(input));
    if (this.fail) return json(500, {});
    if (url.pathname === '/api/v1/status') return json(200, { version: '3.3.0' });
    if (url.pathname === '/api/v1/settings/public') return json(200, { ...this.settings, applicationTitle: 'Seerr' });
    if (url.pathname === '/api/v1/media') {
      const take = Number(url.searchParams.get('take'));
      const skip = Number(url.searchParams.get('skip'));
      return json(200, {
        pageInfo: { pages: Math.ceil(this.media.length / take), pageSize: take, results: this.media.length, page: Math.floor(skip / take) + 1 },
        results: this.media.slice(skip, skip + take),
      });
    }
    const tv = url.pathname.match(/^\/api\/v1\/tv\/(\d+)$/);
    if (tv) {
      const id = Number(tv[1]);
      const n = this.seasonCounts.get(id) ?? 3;
      const m = this.find('tv', id);
      const reqs = this.requests.filter((r) => r.mediaType === 'tv' && r.mediaId === id)
        .map((r) => ({ status: 2, is4k: r.is4k, seasons: (r.seasons ?? []).map((sn) => ({ seasonNumber: sn, status: 2 })) }));
      return json(200, {
        id,
        name: `Series ${id}`,
        seasons: Array.from({ length: n + 1 }, (_, i) => ({ seasonNumber: i, episodeCount: 8 + i, name: i === 0 ? 'Specials' : `Season ${i}`, airDate: null })),
        mediaInfo: m ? { status: m.status, seasons: m.seasons ?? [], requests: reqs } : null,
      });
    }
    if (url.pathname === '/api/v1/request' && (init?.method ?? 'GET') === 'GET') {
      return json(200, { pageInfo: { pages: 1, results: this.requestList.length }, results: this.requestList.slice(0, Number(url.searchParams.get('take') ?? 20)) });
    }
    const one = url.pathname.match(/^\/api\/v1\/request\/(\d+)(\/retry)?$/);
    if (one) {
      const id = Number(one[1]);
      const r = this.requestList.find((x) => x.id === id);
      if (!r) return json(404, { message: 'Request not found.' });
      this.actions.push(`${one[2] ? 'retry' : init?.method} ${id}`);
      if (one[2]) { r.status = 2; return json(200, r); }
      this.requestList = this.requestList.filter((x) => x !== r);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/api/v1/request' && init?.method === 'POST') {
      if (this.nextRequestStatus) {
        const st = this.nextRequestStatus;
        this.nextRequestStatus = null;
        return json(st, { message: st === 403 ? 'Quota exceeded' : st === 409 ? 'Request for this media already exists.' : 'boom' });
      }
      const body = JSON.parse(String(init.body)) as { mediaType: string; mediaId: number; seasons?: number[]; is4k: boolean };
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      this.requests.push({ ...body, headers });
      const existing = this.find(body.mediaType, body.mediaId);
      if (existing) {
        if (existing.status < 2 || existing.status > 5) existing.status = 2;
        existing.seasons = [...(existing.seasons ?? []), ...(body.seasons ?? []).map((sn) => ({ seasonNumber: sn, status: 2 }))];
      } else {
        this.media.push({ id: 9000 + this.media.length, mediaType: body.mediaType, tmdbId: body.mediaId, status: 2,
          seasons: (body.seasons ?? []).map((sn) => ({ seasonNumber: sn, status: 2 })) });
      }
      return json(201, { id: this.requests.length, status: 2 });
    }
    return json(404, {});
  };
}

/** qBittorrent Web API: login, torrents/info and transfer/info. */
export class FakeQbit {
  torrents: Record<string, unknown>[] = [];
  password = 'qbit-pass';
  logins = 0;
  down = false;
  /** Like a qBittorrent whose cross-site check only passes with a matching Referer. */
  requireReferer = false;
  /** qBittorrent 5.x answers a good login with 204 and no body. */
  v5 = false;
  fetch: FetchFn = async (input, init) => {
    const url = new URL(String(input));
    if (this.down) throw new TypeError('fetch failed');
    if (url.pathname === '/api/v2/auth/login') {
      this.logins++;
      const lh = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      if (this.requireReferer && !lh.referer) return new Response('Unauthorized', { status: 401 });
      const body = new URLSearchParams(String(init?.body));
      if (body.get('password') !== this.password) return new Response('Fails.', { status: 200 });
      return new Response(this.v5 ? null : 'Ok.', { status: this.v5 ? 204 : 200, headers: { 'set-cookie': `${this.v5 ? 'QBT_SID_8080' : 'SID'}=abc123; HttpOnly; SameSite=Strict; path=/` } });
    }
    const h = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    if (h.cookie !== (this.v5 ? 'QBT_SID_8080=abc123' : 'SID=abc123')) return new Response('Forbidden', { status: 403 });
    if (url.pathname === '/api/v2/torrents/info') return json(200, this.torrents);
    if (url.pathname === '/api/v2/transfer/info') return json(200, { dl_info_speed: 2_500_000, up_info_speed: 100_000, connection_status: 'connected' });
    return json(404, {});
  };
}

/** Radarr or Sonarr GET /api/v3/queue (and the library endpoints, empty). */
export class FakeArrQueue {
  records: Record<string, unknown>[] = [];
  fetch: FetchFn = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v3/queue') return json(200, { page: 1, totalRecords: this.records.length, records: this.records });
    return json(200, []);
  };
}
