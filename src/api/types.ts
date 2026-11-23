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
  studios?: string[];              // movie studio group keys ("a24", "20th-century")
  networks?: string[];             // TV network group keys ("nbc", "fx"); with studios: either matches
}

/** A studio or network you can filter by, with how many titles on your services it has. */
export interface CompanyOption { key: string; name: string; count: number }
export interface CompaniesResponse { studios: CompanyOption[]; networks: CompanyOption[] }

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
  cast: { id?: number; name: string; role: string; profilePath: string | null }[];
  related: TitleCard[];
  watch: {
    services: ServiceInfo[];       // subscription services it's on now
    stores: string[];              // where it can be rented or bought (JustWatch via TMDB)
    soon: { date: string; service: ServiceKey | null } | null;
  };
  tmdbId: number | null;
  tmdbType: 'movie' | 'tv' | null;
  seerrSeasons: { seasonNumber: number; status: number }[];
  download?: TitleDownload | null;
  /** In Jellyfin already. */
  inLibrary?: boolean;
  /** Where your request stands (from Radarr/Sonarr), when it's requested but not downloaded. */
  request?: { state: RequestState; detail: string | null } | null;
  /** A series you have whose newest season you don't, and Sonarr isn't set to get. */
  newSeason?: { season: number; haveThrough: number } | null;
}

export interface MetaResponse {
  trackingSince: string | null;
  lastSyncAt: string | null;
  health: string;
  eligible: number;
  newThisWeek: number;
  languageRule: 'en' | 'all';
  passcodeRequired: boolean;       // requests need APP_PASSCODE
  downloads?: { configured: boolean; attention: number; downloading: number };
  library?: { configured: boolean; movies: number; series: number };
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

/** Downloads page (qBittorrent, Radarr/Sonarr queues and Seerr requests). */
export type DownloadState = 'downloading' | 'stalled' | 'metadata' | 'error' | 'queued' | 'paused' | 'importing';

export interface DownloadItem {
  hash: string | null;
  name: string;                    // torrent name
  title: string;                   // movie or series it's for (the torrent name when unknown)
  subtitle: string | null;         // "S7 E3 · Joan Is Awful", or null for movies
  year: number | null;
  source: 'radarr' | 'sonarr' | null;
  titleId: number | null;          // MonkeySee title, for the link
  posterUrl: string | null;
  state: DownloadState;
  progress: number;                // 0..1
  size: number;                    // bytes
  speed: number;                   // bytes/s down
  etaSeconds: number | null;
  seeds: number;
  peers: number;
  since: string | null;            // when it got stuck (ISO), for attention items
  message: string | null;          // Radarr/Sonarr's warning, if any
}

/** requested = searching (or awaiting approval); unreleased = not out yet; missing = out, but no copy found. */
export type RequestState = 'requested' | 'unreleased' | 'missing' | 'downloading' | 'available' | 'failed' | 'declined';

export interface RequestItem {
  id: number;
  tmdbType: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  year: number | null;
  titleId: number | null;
  posterUrl: string | null;
  state: RequestState;
  progress: number | null;
  requestedAt: string | null;
  updatedAt: string | null;
  seasons: number[];
  detail: string | null;           // the line under the title, e.g. "Out Dec 12" or "Radarr hasn’t found a copy in 15 days"
  releaseDate: string | null;      // not out yet: when it is
  missingSeasons?: number[];       // series: requested seasons Sonarr has no files for
  check?: { at: string; headline: string; total: number; accepted: number } | null;   // last release search (Not found)
  retried?: { at: string; count: number } | null;                                     // the daily retry asked Radarr/Sonarr to search
}

export interface DownloadsResponse {
  at: string;
  qbit: { configured: boolean; connected: boolean; error: string | null; downSpeed: number; upSpeed: number; seeding: number; vpn: string | null; states: Record<string, number> };
  attention: DownloadItem[];
  downloading: DownloadItem[];
  queued: DownloadItem[];
  requests: RequestItem[];
  errors: string[];                // sources that couldn't be reached
}

/** Download state for one title, shown on its Request button. */
export interface TitleDownload { state: DownloadState; progress: number; etaSeconds: number | null }

/** Library page: what's in Jellyfin. */
export interface LibraryItem {
  id: string;                      // Jellyfin item ID
  type: 'movie' | 'tv';
  title: string;
  year: number | null;
  addedAt: string | null;
  tmdbId: number | null;
  titleId: number | null;          // MonkeySee title, when it's on one of your services
  posterUrl: string | null;
  seasons: number | null;
  managed: boolean;                // Radarr/Sonarr has it (removing goes through them); otherwise Jellyfin deletes it
}
export interface LibraryResponse {
  configured: boolean;
  syncedAt: string | null;
  error: string | null;
  counts: { movie: number; tv: number };
  total: number; page: number; pageSize: number;
  items: LibraryItem[];
}

/** Person page: someone from Cast & Crew and what else they're in. */
export interface PersonResponse {
  id: number;
  name: string;
  profilePath: string | null;
  department: string | null;       // Acting, Directing, Writing...
  biography: string | null;
  onServices: (TitleCard & { role: string })[];      // on your services (or rent or buy), most popular first
  elsewhere: { tmdbType: 'movie' | 'tv'; tmdbId: number; title: string; year: number | null; posterPath: string | null; role: string }[];
}

/** Summary of an interactive search: how many results, how many would be taken, and why not. */
export interface ReleaseCheck {
  at: string;
  total: number;
  accepted: number;
  headline: string;                // "14 found (all 720p), none wanted: quality isn’t in your profile"
  reasons: { reason: string; count: number }[];
  qualities: { quality: string; count: number }[];
}
export interface ReleaseItem {
  guid: string; indexerId: number; indexer: string; title: string;
  quality: string; resolution: number | null; size: number; ageDays: number | null;
  seeders: number | null; leechers: number | null; protocol: string; languages: string[];
  rejected: boolean; rejections: string[]; customFormatScore: number | null;
}
export interface ReleasesResponse {
  requestId: number;
  title: string;
  arr: 'Radarr' | 'Sonarr';
  season: number | null;
  check: ReleaseCheck;
  releases: ReleaseItem[];         // ones it would take first, then rejected, most seeders first
}
