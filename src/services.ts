// The streaming services MonkeySee tracks, and how each one is listed.
//
// `id` is what availability.provider_id stores. Netflix keeps 203 (Watchmode's
// id, used since M1). The others are MonkeySee's own stable ids; the Watchmode
// source id for a service is looked up by name at run time (see sync/sources.ts),
// so a guess here can never point a sync at the wrong catalog.
//
// Listing:
//  - watchmode: Watchmode's list-titles, 1 credit per 250 titles. Split into a
//    movies slice (movies, TV movies, specials, shorts) synced daily and a series
//    slice synced weekly: Sonarr already follows new episodes, so only brand-new
//    series need catching, and a week's delay is fine for those.
//  - tmdb: TMDB discover with the service's watch provider (JustWatch data). Free,
//    so both slices run daily. Used for Prime Video, whose catalog would cost
//    77 Watchmode credits a sync.
//
// Two more sources aren't services: "rent or buy" (new US digital releases) and
// "coming soon" (upcoming premieres). Both come from TMDB; see sync/tmdb-lists.ts.

export type ServiceKey = 'netflix' | 'prime' | 'hbomax' | 'hulu' | 'disney' | 'paramount' | 'peacock';

export interface Service {
  key: ServiceKey;
  id: number;
  name: string;
  /** Watchmode source names that mean this service (first match wins). */
  watchmodeNames: RegExp;
  source: 'watchmode' | 'tmdb';
  /** TMDB watch-provider ids (US) for this service. */
  tmdbProviders: number[];
  /** TMDB network ids, for "coming soon" series. */
  tmdbNetworks: number[];
  /** How the service names itself in TMDB release-date notes ("Netflix", "Max"...). */
  releaseNote: RegExp;
}

export const SERVICES: Service[] = [
  { key: 'netflix', id: 203, name: 'Netflix', watchmodeNames: /^netflix$/i, source: 'watchmode', tmdbProviders: [8], tmdbNetworks: [213], releaseNote: /\bnetflix\b/i },
  { key: 'prime', id: 1026, name: 'Prime Video', watchmodeNames: /^(amazon )?prime video$|^amazon prime$/i, source: 'tmdb', tmdbProviders: [9], tmdbNetworks: [1024], releaseNote: /\b(prime video|amazon)\b/i },
  { key: 'hbomax', id: 1387, name: 'HBO Max', watchmodeNames: /^(hbo )?max$/i, source: 'watchmode', tmdbProviders: [1899], tmdbNetworks: [3186, 49], releaseNote: /\b(hbo|max)\b/i },
  { key: 'hulu', id: 1157, name: 'Hulu', watchmodeNames: /^hulu$/i, source: 'watchmode', tmdbProviders: [15], tmdbNetworks: [453], releaseNote: /\bhulu\b/i },
  { key: 'disney', id: 1372, name: 'Disney+', watchmodeNames: /^disney\+$/i, source: 'watchmode', tmdbProviders: [337], tmdbNetworks: [2739], releaseNote: /\bdisney\+?/i },
  { key: 'paramount', id: 1444, name: 'Paramount+', watchmodeNames: /^paramount\+$|^paramount plus$/i, source: 'watchmode', tmdbProviders: [2303, 531], tmdbNetworks: [4330], releaseNote: /\bparamount\+?/i },
  { key: 'peacock', id: 1389, name: 'Peacock', watchmodeNames: /^peacock premium$|^peacock$/i, source: 'watchmode', tmdbProviders: [386, 387], tmdbNetworks: [3353], releaseNote: /\bpeacock\b/i },
];

/** Availability rows for new US digital releases (rent or buy) use this provider id. */
export const DIGITAL_ID = -1;

export const MOVIE_TYPES = ['movie', 'tv_movie', 'tv_special', 'short_film'] as const;
export const SERIES_TYPES = ['tv_series', 'tv_miniseries'] as const;
export type Slice = 'all' | 'movies' | 'series';

export const serviceByKey = (key: string) => SERVICES.find((s) => s.key === key);
export const serviceById = (id: number) => SERVICES.find((s) => s.id === id);

/** The services this install tracks, from SERVICES in the env (comma list). Netflix is always on. */
export function enabledServices(list: string): Service[] {
  const keys = new Set(list.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  keys.add('netflix');
  return SERVICES.filter((s) => keys.has(s.key));
}

/** Synthetic Watchmode id for a title known only from TMDB. Negative, so it never clashes. */
export const tmdbOnlyId = (type: 'movie' | 'tv', tmdbId: number) => -(tmdbId * 2 + (type === 'tv' ? 1 : 0));
