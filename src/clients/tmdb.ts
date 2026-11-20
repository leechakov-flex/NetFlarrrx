import { z } from 'zod';
import { HttpError, requestJson, type FetchFn } from './http.js';

const Named = z.object({ id: z.number().int(), name: z.string() });

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
  genres: z.array(Named).optional().default([]),
  keywords: z.object({
    keywords: z.array(Named).optional(),   // movie
    results: z.array(Named).optional(),    // tv
  }).optional(),
  videos: z.object({ results: z.array(z.unknown()).optional().default([]) }).optional(),
  release_dates: z.object({                // movie certification
    results: z.array(z.object({
      iso_3166_1: z.string(),
      release_dates: z.array(z.object({ certification: z.string().optional().default('') })).optional().default([]),
    })).optional().default([]),
  }).optional(),
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
}

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

  /** Details, keywords, videos and US rating in one call. Returns null if TMDB has no such record. */
  async details(type: 'movie' | 'tv', id: number): Promise<TmdbDetails | null> {
    const appends = ['keywords', 'videos', type === 'movie' ? 'release_dates' : 'content_ratings'].join(',');
    let raw: unknown;
    try {
      raw = await requestJson<unknown>(this.fetchFn, 'tmdb',
        `${this.base.replace(/\/$/, '')}/${type}/${id}?append_to_response=${appends}&language=en-US`,
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
    return {
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
    };
  }
}
