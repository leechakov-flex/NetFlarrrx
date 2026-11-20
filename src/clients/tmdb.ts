import { z } from 'zod';
import { HttpError, requestJson, type FetchFn } from './http.js';

const Named = z.object({ id: z.number().int(), name: z.string() });

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
  genres: { id: number; name: string }[];
  keywords: { id: number; name: string }[];
}

export class TmdbClient {
  constructor(private base: string, private token: string, private fetchFn: FetchFn = fetch) {}

  /** Details plus keywords in one call. Returns null if TMDB has no such record. */
  async details(type: 'movie' | 'tv', id: number): Promise<TmdbDetails | null> {
    let raw: unknown;
    try {
      raw = await requestJson<unknown>(this.fetchFn, 'tmdb',
        `${this.base.replace(/\/$/, '')}/${type}/${id}?append_to_response=keywords&language=en-US`,
        { headers: { Authorization: `Bearer ${this.token}` } });
    } catch (err) {
      if (err instanceof HttpError && err.isNotFound) return null;
      throw err;
    }
    const d = Details.parse(raw);
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
      genres: d.genres,
      keywords: d.keywords?.keywords ?? d.keywords?.results ?? [],
    };
  }
}
