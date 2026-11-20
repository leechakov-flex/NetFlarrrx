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

  WATCHMODE_BASE: z.preprocess(clean, z.url().default('https://api.watchmode.com/v1')),
  TMDB_BASE: z.preprocess(clean, z.url().default('https://api.themoviedb.org/3')),

  DATA_DIR: z.preprocess(clean, z.string().default('/data')),
  PORT: num(8484),
  TZ: z.preprocess(clean, z.string().default('America/New_York')),

  NETFLIX_SOURCE_ID: num(203),
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
    ...overrides,
  });
}
