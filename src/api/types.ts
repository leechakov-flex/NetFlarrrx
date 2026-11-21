// Response shapes shared by the server and the web UI (type-only imports in web/).

export type Kind = 'movie' | 'series';

export type ServiceKey = 'netflix' | 'prime' | 'hbomax' | 'hulu' | 'disney' | 'paramount' | 'peacock';
export type How = 'sub' | 'digital' | 'soon';
export interface ServiceInfo { key: ServiceKey; name: string }

/** Seerr media status, collapsed to what the UI shows. */
export type SeerrState = 'available' | 'partial' | 'requested' | 'processing' | null;

export interface TitleCard {
  id: number;
  kind: Kind;
  title: string;
  year: number | null;
  posterPath: string | null;
  addedAt: string | null;          // ISO; null = on Netflix before tracking began
  backOnNetflix: boolean;
  voteAverage: number | null;
  voteCount: number | null;
  seerr: SeerrState;
  services: ServiceKey[];          // subscription services it's on, in scope
  digital: boolean;                // new to rent or buy
  soon: { date: string; service: ServiceKey | null } | null;   // not out yet; service null = rent or buy
  logoPath: string | null;         // English title logo
  textlessPosterPath: string | null;
}

export interface HomeRow {
  slug: string;
  title: string;
  total: number;                   // titles matching the row, not just those returned
  link: string | null;             // browse URL for "see all"
  items: TitleCard[];
  /** "logo": textless posters with the title logo (Apple TV style), when nearly every card has both. */
  art: 'logo' | 'poster';
}

export interface HomeResponse {
  trackingSince: string | null;    // first applied sync
  showTrackingNotice: boolean;     // under 7 days of history
  rows: HomeRow[];
}

export type SortKey = 'added' | 'rating' | 'popularity' | 'release' | 'title' | 'match' | 'soon';
export type AddedWithin = 7 | 30 | 90 | null;

export interface BrowseQuery {
  kind?: Kind;
  genres?: number[];
  added?: AddedWithin;
  minRating?: number;              // 0-10
  maxRating?: number;              // 0-10
  minVotes?: number;
  sort?: SortKey;
  page?: number;                   // 1-based
  q?: string;                      // title search
  hideHave?: boolean;              // drop titles already available, partial, processing or requested in Seerr
  theme?: string;                  // thematic row slug
  because?: string;                // "movie:123": titles TMDB recommends for that library title
  services?: ServiceKey[];         // only these services (default: all tracked)
  how?: How[];                     // subscription, rent or buy, coming soon (default: subscription)
}

export interface BrowseResponse {
  total: number;
  page: number;
  pageSize: number;
  items: TitleCard[];
  theme?: { slug: string; title: string; sort: SortKey };
}

export interface ThemeSummary { slug: string; title: string; kind: Kind | null; sort: SortKey; home: boolean; count: number }

export interface Genre { id: number; name: string; count: number }

export interface TopResponse { kind: Kind; minVotes: number; items: (TitleCard & { rank: number; runtime: number | null })[] }

export interface TitleDetail extends TitleCard {
  overview: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  runtime: number | null;
  seasons: number | null;
  certification: string | null;
  originalLanguage: string | null;
  genres: { id: number; name: string }[];
  trailer: { key: string; name: string | null } | null;
  onNetflix: boolean;              // still on any tracked service (or rent or buy)
  firstSeenAt: string | null;
  cast: { name: string; role: string; profilePath: string | null }[];
  related: TitleCard[];
  watch: {
    services: ServiceInfo[];       // subscription services it's on now
    stores: string[];              // where it can be rented or bought (JustWatch via TMDB)
    soon: { date: string; service: ServiceKey | null } | null;
  };
  tmdbId: number | null;
  tmdbType: 'movie' | 'tv' | null;
  seerrSeasons: { seasonNumber: number; status: number }[];
}

export interface MetaResponse {
  trackingSince: string | null;
  lastSyncAt: string | null;
  health: string;
  eligible: number;
  newThisWeek: number;
  languageRule: 'en' | 'all';
  passcodeRequired: boolean;       // requests need APP_PASSCODE
  services: ServiceInfo[];         // tracked services, in display order
  ops?: {
    lastBackupAt: string | null;   // null with backups on = none yet; undefined section = backups off
    backupError: string | null;
    crosscheck: { at: string; ok: boolean; coveragePct: number | null } | null;
    alerts: boolean;               // ALERT_URL set
  };
}

/** One season as Seerr sees it. null = nothing yet, so it can be requested. */
export type SeasonState = 'available' | 'partial' | 'processing' | 'requested' | null;

export interface SeasonInfo { seasonNumber: number; name: string; episodeCount: number; state: SeasonState }

export interface SeasonsResponse { partialRequestsEnabled: boolean; seasons: SeasonInfo[] }

export interface RequestBody { seasons?: number[] }

export interface RequestResult { ok: true; state: 'requested'; seasons: number[] | null; message: string }

export interface ApiError { error: string; code?: string }
