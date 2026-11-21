import { z } from 'zod';

// Trims whitespace and one pair of surrounding quotes. `docker run --env-file`
// and compose `env_file` pass quotes through literally.
const clean = (v: unknown) => {
  if (typeof v !== 'string') return v;
  let s = v.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1).trim();
  }
  return s === '' ? undefined : s;
};

const str = () => z.preprocess(clean, z.string());
const optStr = () => z.preprocess(clean, z.string().optional());
const num = (d: number) => z.preprocess(clean, z.coerce.number().default(d));
const bool = (d: boolean) =>
  z.preprocess(clean, z.enum(['true', 'false', '1', '0']).optional()).transform((v) => (v === undefined ? d : v === 'true' || v === '1'));

const schema = z.object({
  WATCHMODE_API_KEY: str(),
  TMDB_READ_TOKEN: str(),
  SEERR_API_KEY: str(),
  SEERR_URL: z.preprocess(clean, z.url().default('http://seerr:5055')),
  APP_PASSCODE: optStr(),
  // Request as this Seerr user (X-API-User). Unset = the API key's owner (the admin), so requests auto-approve.
  SEERR_USER_ID: z.preprocess(clean, z.coerce.number().int().positive().optional()),

  WATCHMODE_BASE: z.preprocess(clean, z.url().default('https://api.watchmode.com/v1')),
  TMDB_BASE: z.preprocess(clean, z.url().default('https://api.themoviedb.org/3')),

  DATA_DIR: z.preprocess(clean, z.string().default('/data')),
  PORT: num(8484),
  TZ: z.preprocess(clean, z.string().default('America/New_York')),

  NETFLIX_SOURCE_ID: num(203),
  // Services to track (comma list; Netflix is always on). See src/services.ts.
  SERVICES: z.preprocess(clean, z.string().default('netflix,prime,hbomax,hulu,disney,paramount,peacock')),
  TRACK_DIGITAL: bool(true),        // "Available from theaters" (new to rent or buy) from TMDB (free)
  TRACK_UPCOMING: bool(true),       // "Coming soon" from TMDB (free)
  REGION: z.preprocess(clean, z.string().default('US')),
  LANGUAGE_RULE: z.preprocess(clean, z.enum(['en', 'all']).default('en')),

  SYNC_CRON: z.preprocess(clean, z.string().default('23 6 * * *')),
  SEERR_MIRROR_CRON: z.preprocess(clean, z.string().default('*/10 * * * *')),
  RUN_SCHEDULER: bool(true),

  // Noise guards (see "Date added" in the plan).
  REMOVE_AFTER_MISSES: num(2),
  RETURN_WINDOW_DAYS: num(14),
  MAX_SWING_PCT: num(10),
  ENRICH_STALE_DAYS: num(30),

  // Backups (M5): a verified SQLite snapshot every night. BACKUP_DIR defaults to <DATA_DIR>/backups;
  // point it at a second disk (mounted into the container) so a dead drive doesn't take both.
  BACKUP_DIR: optStr(),
  BACKUP_KEEP: num(14),
  BACKUP_CRON: z.preprocess(clean, z.string().default('41 3 * * *')),

  // Alerts (M5): an ntfy topic URL (https://ntfy.sh/<topic> or self-hosted) or a Discord webhook URL.
  ALERT_URL: z.preprocess(clean, z.url().optional()),
  ALERT_TOKEN: optStr(),            // ntfy access token, for protected topics
  APP_URL: z.preprocess(clean, z.url().optional()),   // link in alerts, e.g. http://monkeyserver.local:8484
  ALERT_CHECK_CRON: z.preprocess(clean, z.string().default('7 * * * *')),

  // TMDB cross-check (M5): weekly compare with TMDB's own Netflix list (JustWatch data).
  CROSSCHECK_CRON: z.preprocess(clean, z.string().default('17 5 * * 0')),
  // Baseline Nov 20 on MonkeyServer: we had 82.2% of TMDB's list; TMDB had 97% of ours.
  CROSSCHECK_MIN_PCT: num(70),      // alert if fewer than this % of TMDB's Netflix titles are in ours
  CROSSCHECK_MIN_AGREE_PCT: num(85), // alert if fewer than this % of ours are on TMDB's list (stale entries)
  CROSSCHECK_MAX_DROP: num(10),     // or if that share falls this many points since the last run
  TMDB_NETFLIX_PROVIDER_ID: num(8),

  // Library for recommendations: Radarr and Sonarr when their keys are set (read only), plus Seerr.
  RADARR_URL: z.preprocess(clean, z.url().default('http://radarr:7878')),
  RADARR_API_KEY: optStr(),
  SONARR_URL: z.preprocess(clean, z.url().default('http://sonarr:8989')),
  SONARR_API_KEY: optStr(),

  // qBittorrent (read only), for the Downloads page. It runs behind the VPN container, so
  // it's reached through that container's name. Unset QBIT_PASSWORD = no torrent view.
  QBIT_URL: z.preprocess(clean, z.url().default('http://gluetun:8080')),
  QBIT_USERNAME: optStr(),
  QBIT_PASSWORD: optStr(),
  DOWNLOADS_CRON: z.preprocess(clean, z.string().default('*/5 * * * *')),
  STALL_ALERT_HOURS: num(2),        // push an alert when a download has been stuck this long

  // Jellyfin (read only), for the Library page and to leave what you have out of Discover.
  // Create a key in Jellyfin: Dashboard -> API Keys. Unset = no library view.
  JELLYFIN_URL: z.preprocess(clean, z.url().default('http://jellyfin:8096')),
  JELLYFIN_API_KEY: optStr(),
  JELLYFIN_CRON: z.preprocess(clean, z.string().default('*/15 * * * *')),

  WATCHMODE_MIN_INTERVAL_MS: num(600),
  TMDB_CONCURRENCY: num(8),
  LOG_LEVEL: z.preprocess(clean, z.enum(['debug', 'info', 'warn', 'error']).default('info')),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}

// For tests: a full config with keys filled in and overrides applied.
export function testConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  return loadConfig({
    WATCHMODE_API_KEY: 'test-watchmode',
    TMDB_READ_TOKEN: 'test-tmdb',
    SEERR_API_KEY: 'test-seerr',
    DATA_DIR: ':memory:',
    RUN_SCHEDULER: 'false',
    WATCHMODE_MIN_INTERVAL_MS: '0',
    SERVICES: 'netflix',
    TRACK_DIGITAL: 'false',
    TRACK_UPCOMING: 'false',
    ...overrides,
  });
}
