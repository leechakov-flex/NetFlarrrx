import { z } from 'zod';
import { HttpError, requestJson, type FetchFn } from './http.js';

const Named = z.object({ id: z.number().int(), name: z.string() });
const ImageRef = z.object({ file_path: z.string(), iso_639_1: z.string().nullable().optional(), vote_average: z.number().optional().default(0), vote_count: z.number().optional().default(0) });
type ImageRef = z.infer<typeof ImageRef>;

export interface Person { name: string; role: string; profilePath: string | null }
export interface WatchOptions { flatrate: string[]; rent: string[]; buy: string[]; providerIds: number[] }

const Video = z.object({
  key: z.string(),
  site: z.string(),
  type: z.string(),
  name: z.string().optional().default(''),
  official: z.boolean().optional().default(false),
  iso_639_1: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
});
export type TmdbVideo = z.infer<typeof Video>;

const Details = z.object({
  id: z.number().int(),
  title: z.string().optional(),            // movie
  name: z.string().optional(),             // tv
  original_language: z.string().nullable().optional(),
  overview: z.string().nullable().optional(),
  poster_path: z.string().nullable().optional(),
  backdrop_path: z.string().nullable().optional(),
  release_date: z.string().nullable().optional(),     // movie
  first_air_date: z.string().nullable().optional(),   // tv
  vote_average: z.number().nullable().optional(),
  vote_count: z.number().int().nullable().optional(),
  popularity: z.number().nullable().optional(),
  runtime: z.number().int().nullable().optional(),
  number_of_seasons: z.number().int().nullable().optional(),
  last_air_date: z.string().nullable().optional(),     // tv
  networks: z.array(Named).optional().default([]),     // tv
  production_companies: z.array(Named).optional().default([]),
  genres: z.array(Named).optional().default([]),
  keywords: z.object({
    keywords: z.array(Named).optional(),   // movie
    results: z.array(Named).optional(),    // tv
  }).optional(),
  videos: z.object({ results: z.array(z.unknown()).optional().default([]) }).optional(),
  release_dates: z.object({                // movie certification and US digital date
    results: z.array(z.object({
      iso_3166_1: z.string(),
      release_dates: z.array(z.object({
        certification: z.string().optional().default(''),
        type: z.number().int().optional(),
        release_date: z.string().optional(),
        note: z.string().optional().default(''),
      })).optional().default([]),
    })).optional().default([]),
  }).optional(),
  created_by: z.array(z.object({ name: z.string(), profile_path: z.string().nullable().optional() })).optional().default([]),
  images: z.object({
    logos: z.array(ImageRef).optional().default([]),
    posters: z.array(ImageRef).optional().default([]),
  }).optional(),
  credits: z.object({                      // movie
    cast: z.array(z.object({ name: z.string(), character: z.string().nullable().optional(), profile_path: z.string().nullable().optional(), order: z.number().optional() })).optional().default([]),
    crew: z.array(z.object({ name: z.string(), job: z.string().optional().default(''), profile_path: z.string().nullable().optional() })).optional().default([]),
  }).optional(),
  aggregate_credits: z.object({            // tv
    cast: z.array(z.object({ name: z.string(), profile_path: z.string().nullable().optional(), order: z.number().optional(),
      roles: z.array(z.object({ character: z.string().nullable().optional() })).optional().default([]) })).optional().default([]),
  }).optional(),
  'watch/providers': z.object({
    results: z.record(z.string(), z.object({
      flatrate: z.array(z.object({ provider_id: z.number().int(), provider_name: z.string() })).optional(),
      rent: z.array(z.object({ provider_id: z.number().int(), provider_name: z.string() })).optional(),
      buy: z.array(z.object({ provider_id: z.number().int(), provider_name: z.string() })).optional(),
    }).passthrough()).optional().default({}),
  }).optional(),
  recommendations: z.object({ results: z.array(z.object({ id: z.number().int(), media_type: z.string().optional() }).passthrough()).optional().default([]) }).optional(),
  content_ratings: z.object({              // tv certification
    results: z.array(z.object({ iso_3166_1: z.string(), rating: z.string().optional().default('') })).optional().default([]),
  }).optional(),
});

export interface TmdbDetails {
  tmdbTitle: string | null;
  originalLanguage: string | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  voteAverage: number | null;
  voteCount: number | null;
  popularity: number | null;
  runtime: number | null;
  seasons: number | null;
  certification: string | null;
  trailer: { key: string; name: string } | null;
  genres: { id: number; name: string }[];
  keywords: { id: number; name: string }[];
  lastAirDate: string | null;
  netflixOriginal: boolean;
  logoPath: string | null;
  textlessPosterPath: string | null;
  credits: Person[];
  watch: WatchOptions | null;
  recommendations: { type: 'movie' | 'tv'; id: number }[];
  digitalDate: string | null;
  /** TMDB's note on the US digital release, often the service ("Netflix", "Max"). */
  digitalNote: string | null;
}

/** Best-voted image, ties to more votes. TMDB lists images unsorted. */
const bestImage = (list: ImageRef[]) => [...list].sort((a, b) => b.vote_average - a.vote_average || b.vote_count - a.vote_count)[0]?.file_path ?? null;
const CREW_JOBS = ['Director', 'Screenplay', 'Writer', 'Creator'];

/**
 * Picks the trailer to show: YouTube only (the player embeds YouTube), then
 * official English trailers first, then any trailer, then teasers; newest wins ties.
 */
export function pickTrailer(videos: TmdbVideo[]): { key: string; name: string } | null {
  const score = (v: TmdbVideo) =>
    (v.type === 'Trailer' ? 100 : v.type === 'Teaser' ? 10 : 0) +
    (v.official ? 20 : 0) +
    (v.iso_639_1 === 'en' || !v.iso_639_1 ? 5 : 0);
  const usable = videos.filter((v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
  if (!usable.length) return null;
  usable.sort((a, b) => score(b) - score(a) || (b.published_at ?? '').localeCompare(a.published_at ?? ''));
  const best = usable[0]!;
  return { key: best.key, name: best.name };
}

const Recs = z.object({
  title: z.string().optional(), name: z.string().optional(),
  runtime: z.number().int().nullable().optional(),
  genres: z.array(Named).optional().default([]),
  keywords: z.object({ keywords: z.array(Named).optional(), results: z.array(Named).optional() }).optional(),
  recommendations: z.object({ results: z.array(z.object({ id: z.number().int() }).passthrough()).optional().default([]) }).optional(),
});

export interface DiscoverItem { id: number; title: string; year: number | null; popularity: number | null }

const DiscoverPage = z.object({
  page: z.number().int(),
  total_pages: z.number().int(),
  total_results: z.number().int(),
  results: z.array(z.object({
    id: z.number().int(),
    title: z.string().optional(), name: z.string().optional(),
    release_date: z.string().optional(), first_air_date: z.string().optional(),
    popularity: z.number().optional(),
  }).passthrough()),
});

export class TmdbClient {
  constructor(private base: string, private token: string, private fetchFn: FetchFn = fetch) {}

  /** Just a title's name, year and poster, for requests of titles outside the catalog. */
  async basic(type: 'movie' | 'tv', id: number): Promise<{ title: string; year: number | null; posterPath: string | null } | null> {
    try {
      const d = z.object({ title: z.string().optional(), name: z.string().optional(), release_date: z.string().nullable().optional(),
        first_air_date: z.string().nullable().optional(), poster_path: z.string().nullable().optional() }).passthrough().parse(
        await requestJson<unknown>(this.fetchFn, 'tmdb', `${this.base.replace(/\/$/, '')}/${type}/${id}?language=en-US`, { headers: { Authorization: `Bearer ${this.token}` }, retries: 1 }));
      const date = d.release_date || d.first_air_date || '';
      return { title: d.title ?? d.name ?? `#${id}`, year: date ? Number(date.slice(0, 4)) || null : null, posterPath: d.poster_path ?? null };
    } catch (err) {
      if (err instanceof HttpError && err.isNotFound) return null;
      throw err;
    }
  }

  /** TMDB series ID for a TVDB ID (Sonarr v3 lists only TVDB IDs). */
  async tvByTvdb(tvdbId: number): Promise<number | null> {
    const d = z.object({ tv_results: z.array(z.object({ id: z.number().int() }).passthrough()).optional().default([]) }).parse(
      await requestJson<unknown>(this.fetchFn, 'tmdb', `${this.base.replace(/\/$/, '')}/find/${tvdbId}?external_source=tvdb_id`,
        { headers: { Authorization: `Bearer ${this.token}` } }));
    return d.tv_results[0]?.id ?? null;
  }

  /** A library title's name and TMDB's recommendations for it (one page, about 20). */
  async recommendations(type: 'movie' | 'tv', id: number): Promise<{ title: string | null; genres: string[]; keywords: string[]; runtime: number | null; recs: { id: number; rank: number }[] } | null> {
    let raw: unknown;
    try {
      raw = await requestJson<unknown>(this.fetchFn, 'tmdb', `${this.base.replace(/\/$/, '')}/${type}/${id}?append_to_response=recommendations,keywords&language=en-US`,
        { headers: { Authorization: `Bearer ${this.token}` } });
    } catch (err) {
      if (err instanceof HttpError && err.isNotFound) return null;
      throw err;
    }
    const d = Recs.parse(raw);
    return { title: d.title ?? d.name ?? null, genres: d.genres.map((g) => g.name), keywords: (d.keywords?.keywords ?? d.keywords?.results ?? []).map((k) => k.name), runtime: d.runtime ?? null, recs: (d.recommendations?.results ?? []).map((r, i) => ({ id: r.id, rank: i + 1 })) };
  }

  /** One page of titles TMDB lists on a streaming service (flat-rate) in a region. */
  async discover(type: 'movie' | 'tv', providerId: number, region: string, page: number) {
    const q = new URLSearchParams({
      with_watch_providers: String(providerId), watch_region: region, with_watch_monetization_types: 'flatrate',
      sort_by: 'popularity.desc', include_adult: 'false', page: String(page),
    });
    const d = DiscoverPage.parse(await requestJson<unknown>(this.fetchFn, 'tmdb', `${this.base.replace(/\/$/, '')}/discover/${type}?${q}`,
      { headers: { Authorization: `Bearer ${this.token}` } }));
    return {
      totalPages: d.total_pages,
      totalResults: d.total_results,
      results: d.results.map((r): DiscoverItem => {
        const date = r.release_date || r.first_air_date || '';
        return { id: r.id, title: r.title ?? r.name ?? `#${r.id}`, year: date ? Number(date.slice(0, 4)) || null : null, popularity: r.popularity ?? null };
      }),
    };
  }

  /**
   * One page of any TMDB discover query (20 results). `params` are TMDB's own
   * discover filters, e.g. with_watch_providers or with_release_type.
   */
  async discoverPage(type: 'movie' | 'tv', params: Record<string, string>, page: number) {
    const q = new URLSearchParams({ include_adult: 'false', ...params, page: String(page) });
    const d = DiscoverPage.parse(await requestJson<unknown>(this.fetchFn, 'tmdb', `${this.base.replace(/\/$/, '')}/discover/${type}?${q}`,
      { headers: { Authorization: `Bearer ${this.token}` } }));
    return {
      totalPages: d.total_pages,
      totalResults: d.total_results,
      results: d.results.map((r) => ({ id: r.id, title: r.title ?? r.name ?? `#${r.id}`, date: (r.release_date || r.first_air_date || null) as string | null })),
    };
  }

  /** Details, keywords, videos and US rating in one call. Returns null if TMDB has no such record. */
  async details(type: 'movie' | 'tv', id: number): Promise<TmdbDetails | null> {
    const appends = ['keywords', 'videos', type === 'movie' ? 'release_dates' : 'content_ratings', 'images',
      type === 'movie' ? 'credits' : 'aggregate_credits', 'watch/providers', 'recommendations'].join(',');
    let raw: unknown;
    try {
      raw = await requestJson<unknown>(this.fetchFn, 'tmdb',
        `${this.base.replace(/\/$/, '')}/${type}/${id}?append_to_response=${appends}&language=en-US&include_image_language=en,null`,
        { headers: { Authorization: `Bearer ${this.token}` } });
    } catch (err) {
      if (err instanceof HttpError && err.isNotFound) return null;
      throw err;
    }
    const d = Details.parse(raw);
    const videos = (d.videos?.results ?? []).flatMap((v) => { const p = Video.safeParse(v); return p.success ? [p.data] : []; });
    let certification: string | null = null;
    if (type === 'movie') {
      const us = d.release_dates?.results.find((r) => r.iso_3166_1 === 'US');
      certification = us?.release_dates.map((r) => r.certification.trim()).find(Boolean) ?? null;
    } else {
      certification = d.content_ratings?.results.find((r) => r.iso_3166_1 === 'US')?.rating.trim() || null;
    }
    const usRelease = d.release_dates?.results.find((r) => r.iso_3166_1 === 'US')?.release_dates ?? [];
    const digitalRow = usRelease.filter((r) => r.type === 4 && r.release_date).sort((a, b) => a.release_date!.localeCompare(b.release_date!))[0];
    const digital = digitalRow?.release_date?.slice(0, 10) ?? null;
    const cast: Person[] = type === 'movie'
      ? (d.credits?.cast ?? []).slice(0, 12).map((c) => ({ name: c.name, role: c.character || '', profilePath: c.profile_path ?? null }))
      : (d.aggregate_credits?.cast ?? []).slice(0, 12).map((c) => ({ name: c.name, role: c.roles[0]?.character || '', profilePath: c.profile_path ?? null }));
    const crewSeen = new Set<string>();
    const crew: Person[] = [
      ...d.created_by.map((c) => ({ name: c.name, role: 'Creator', profilePath: c.profile_path ?? null })),
      ...(d.credits?.crew ?? []).filter((c) => CREW_JOBS.includes(c.job)).map((c) => ({ name: c.name, role: c.job, profilePath: c.profile_path ?? null })),
    ].filter((p) => (crewSeen.has(p.name) ? false : (crewSeen.add(p.name), true))).slice(0, 4);
    const us = d['watch/providers']?.results.US;
    const names = (l?: { provider_name: string }[]) => [...new Set((l ?? []).map((p) => p.provider_name))];
    const watch: WatchOptions | null = us ? {
      flatrate: names(us.flatrate), rent: names(us.rent), buy: names(us.buy),
      providerIds: [...new Set([...(us.flatrate ?? []), ...(us.rent ?? []), ...(us.buy ?? [])].map((p) => p.provider_id))],
    } : null;
    return {
      logoPath: bestImage((d.images?.logos ?? []).filter((l) => l.iso_639_1 === 'en' && !l.file_path.endsWith('.svg'))),
      textlessPosterPath: bestImage((d.images?.posters ?? []).filter((p) => p.iso_639_1 == null)),
      credits: [...crew.filter((p) => p.role === 'Director' || p.role === 'Creator'), ...cast, ...crew.filter((p) => p.role !== 'Director' && p.role !== 'Creator')],
      watch,
      recommendations: (d.recommendations?.results ?? []).slice(0, 20).map((r) => ({ type: (r.media_type === 'tv' ? 'tv' : r.media_type === 'movie' ? 'movie' : type) as 'movie' | 'tv', id: r.id })),
      digitalDate: type === 'movie' ? digital : null,
      digitalNote: type === 'movie' ? (digitalRow?.note || null) : null,
      tmdbTitle: d.title ?? d.name ?? null,
      originalLanguage: d.original_language ?? null,
      overview: d.overview || null,
      posterPath: d.poster_path ?? null,
      backdropPath: d.backdrop_path ?? null,
      releaseDate: (type === 'movie' ? d.release_date : d.first_air_date) || null,
      voteAverage: d.vote_average ?? null,
      voteCount: d.vote_count ?? null,
      popularity: d.popularity ?? null,
      runtime: type === 'movie' ? (d.runtime ?? null) : null,
      seasons: type === 'tv' ? (d.number_of_seasons ?? null) : null,
      certification,
      trailer: pickTrailer(videos),
      genres: d.genres,
      keywords: d.keywords?.keywords ?? d.keywords?.results ?? [],
      lastAirDate: type === 'tv' ? (d.last_air_date || null) : null,
      // Series: Netflix is the network. Films and specials: a Netflix studio made it.
      netflixOriginal: type === 'tv'
        ? d.networks.some((n) => n.name === 'Netflix')
        : d.production_companies.some((c) => /^Netflix\b/.test(c.name)),
    };
  }
}
