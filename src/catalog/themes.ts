import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import { log } from '../log.js';

/**
 * Thematic rows (F-rule schema in the plan). A title is in a theme when it
 * matches at least one *signal* (a keyword, genre or Watchmode type) and passes
 * every *limit*. A theme with no signals is defined by its limits alone
 * (e.g. Hidden gems = rating and vote bounds).
 *
 * Names are matched case-insensitively against TMDB keyword and genre names,
 * so rules read like English and survive TMDB re-numbering.
 */
const range = z.object({ min: z.number().optional(), max: z.number().optional() }).strict();

export const ThemeRule = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1).max(60),
  kind: z.enum(['movie', 'series']).optional(),
  signals: z.object({
    keywords: z.array(z.string()).optional(),
    genres: z.array(z.string()).optional(),
    types: z.array(z.enum(['movie', 'tv_movie', 'short_film', 'tv_special', 'tv_series', 'tv_miniseries'])).optional(),
  }).strict().optional(),
  require: z.object({ genres: z.array(z.string()).min(1) }).strict().optional(),   // must have one of these genres
  exclude: z.object({
    keywords: z.array(z.string()).optional(),
    genres: z.array(z.string()).optional(),
    types: z.array(z.string()).optional(),
  }).strict().optional(),
  year: range.optional(),
  rating: range.optional(),         // TMDB vote average, 0-10
  votes: range.optional(),          // TMDB vote count
  runtime: range.optional(),        // minutes; applies to movies only
  seasons: range.optional(),        // season count; applies to series only
  released: z.object({ withinDays: z.number().int().positive() }).strict().optional(),  // first release (movie) or premiere (series)
  // movie release, or a series' latest episode: within the last N days, and/or longer ago than N days
  aired: z.object({ withinDays: z.number().int().positive().optional(), olderThanDays: z.number().int().positive().optional() }).strict()
    .refine((a) => a.withinDays || a.olderThanDays, 'aired needs withinDays or olderThanDays').optional(),
  originals: z.boolean().optional(),  // true = Netflix originals only (TMDB network or studio), false = none
  addedWithin: z.number().int().positive().optional(),  // days since it arrived on a service in scope (needs tracking history)
  sort: z.enum(['added', 'rating', 'popularity', 'release', 'title', 'match', 'soon']).default('added'),
  // Which availability the row looks at. Default: every tracked service, subscription only.
  services: z.array(z.enum(['netflix', 'prime', 'hbomax', 'hulu', 'disney', 'paramount', 'peacock'])).min(1).optional(),
  how: z.array(z.enum(['sub', 'digital', 'soon'])).min(1).optional(),
  home: z.boolean().default(true),  // show as a row on Discover
  // The most Discover rows a title may appear in, counting this one. Rows are built
  // in order and skip titles that are already in `repeat` earlier rows, so 1 (the
  // default) means "only titles no earlier row has shown". Genre rows that overlap
  // by nature (a thriller that is also a drama) allow 2.
  repeat: z.number().int().min(1).max(10).optional(),
  // Rows built from your library instead of filters. "because" rows each take
  // the next of your titles with the most Netflix matches.
  special: z.enum(['for-you', 'because']).optional(),
}).strict();
export type ThemeRule = z.infer<typeof ThemeRule>;

const ThemeFile = z.array(ThemeRule).refine((a) => new Set(a.map((t) => t.slug)).size === a.length, 'theme slugs must be unique');

/** A title appears in one Discover row unless the row's theme says `repeat`. */
export const HOME_REPEAT_DEFAULT = 1;
/** A row that dedupe thinned out below this many titles is dropped, not shown half empty. */
export const MIN_THINNED_ROW = 4;

export const STANDUP =["stand-up comedy", "stand-up special", "stand up comedy", "stand-up comedian", "comedy special"];

/**
 * Every Discover row, in order: new arrivals first, then a long mixed scroll of
 * recommendations, comedy, recent genre picks and themes. Genre rows only take
 * titles from the last few years, so old catalogue hits don't crowd out new ones.
 * Rows with nothing to show are skipped (the "new on Netflix" ones fill in as
 * tracking history builds; "for you" needs titles available in Seerr).
 */
export const DEFAULT_THEMES: ThemeRule[] = ThemeFile.parse([
  // Just released: new on your services AND actually new (out, or a new episode, in the last 6 months).
  // Older films and shows a service just picked up go to "Just added" further down.
  { slug: 'new-week', title: 'Just released', addedWithin: 7, aired: { withinDays: 180 } },
  { slug: 'new-digital', title: 'Available from theaters', kind: 'movie', how: ['digital'], addedWithin: 45, sort: 'added' },
  { slug: 'coming-soon', title: 'Coming soon', how: ['soon'], sort: 'soon' },
  { slug: 'new-month', title: 'New this month', addedWithin: 30, aired: { withinDays: 365 } },
  { slug: 'new-movies', title: 'New movies', kind: 'movie', released: { withinDays: 120 }, sort: 'release',
    exclude: { types: ['tv_special'] } },
  // Sonarr follows new episodes of shows you have; this row is for shows that are new.
  { slug: 'new-episodes', title: 'New series', kind: 'series', released: { withinDays: 120 }, sort: 'release' },
  { slug: 'new-originals', title: 'New Netflix originals', services: ['netflix'], originals: true, aired: { withinDays: 180 } },
  { slug: 'for-you', title: 'Recommended for you', special: 'for-you', sort: 'match' },
  { slug: 'just-added', title: 'Just added', addedWithin: 14, aired: { olderThanDays: 180 }, sort: 'added' },

  // Comedy, up top
  { slug: 'standup', title: 'Stand-up specials', kind: 'movie',
    signals: { keywords: STANDUP, types: ['tv_special'] }, require: { genres: ['Comedy'] }, sort: 'release' },
  { slug: 'new-comedies', title: 'New comedy movies', kind: 'movie', require: { genres: ['Comedy'] }, released: { withinDays: 730 },
    exclude: { keywords: STANDUP, types: ['tv_special'], genres: ['Documentary'] }, sort: 'release' },
  { slug: 'comedy-series', title: 'Comedy series', kind: 'series', require: { genres: ['Comedy'] }, aired: { withinDays: 730 },
    exclude: { genres: ['Kids', 'Talk', 'News'] }, sort: 'popularity' },
  { slug: 'because-1', title: 'Because you have', special: 'because' },

  // One row per other service: what's new there.
  { slug: 'new-hbomax', title: 'New on HBO Max', services: ['hbomax'], addedWithin: 30, repeat: 2 },
  { slug: 'new-prime', title: 'New on Prime Video', services: ['prime'], addedWithin: 30, repeat: 2 },
  { slug: 'new-hulu', title: 'New on Hulu', services: ['hulu'], addedWithin: 30, repeat: 2 },
  { slug: 'new-disney', title: 'New on Disney+', services: ['disney'], addedWithin: 30, repeat: 2 },
  { slug: 'new-paramount', title: 'New on Paramount+', services: ['paramount'], addedWithin: 30, repeat: 2 },
  { slug: 'new-peacock', title: 'New on Peacock', services: ['peacock'], addedWithin: 30, repeat: 2 },

  // Popular now, by genre (recent titles only)
  { slug: 'trending', title: 'Popular right now', aired: { withinDays: 365 }, sort: 'popularity' },
  { slug: 'action', title: 'Action and adventure', require: { genres: ['Action', 'Adventure', 'Action & Adventure'] },
    aired: { withinDays: 1095 }, exclude: { genres: ['Kids', 'Family'] }, sort: 'popularity', repeat: 2 },
  { slug: 'thrillers', title: 'Thrillers and mysteries', require: { genres: ['Thriller', 'Mystery'] },
    aired: { withinDays: 1095 }, exclude: { genres: ['Documentary', 'Kids'] }, sort: 'popularity', repeat: 2 },
  { slug: 'crime', title: 'Crime', require: { genres: ['Crime'] }, aired: { withinDays: 1095 },
    exclude: { genres: ['Documentary'] }, sort: 'popularity', repeat: 2 },
  { slug: 'new-for-you', title: 'New for you', special: 'for-you', aired: { withinDays: 365 }, sort: 'added' },
  { slug: 'scifi', title: 'Sci-fi and fantasy', require: { genres: ['Science Fiction', 'Fantasy', 'Sci-Fi & Fantasy'] },
    aired: { withinDays: 1095 }, exclude: { genres: ['Kids'] }, sort: 'popularity', repeat: 2 },
  { slug: 'horror', title: 'Horror', require: { genres: ['Horror'] }, aired: { withinDays: 1095 }, sort: 'popularity' },
  {
    slug: 'true-stories', title: 'Based on a true story',
    signals: { keywords: ['based on true story', 'based on a true story', 'based on real events', 'based on real person', 'true story', 'biography', 'true crime', 'historical figure'] },
    exclude: { genres: ['Documentary', 'Reality'] }, repeat: 2,
  },
  { slug: 'dramas', title: 'Dramas', require: { genres: ['Drama'] }, aired: { withinDays: 730 },
    exclude: { genres: ['Comedy', 'Kids', 'Soap'] }, sort: 'popularity', repeat: 2 },
  { slug: 'because-2', title: 'Because you have', special: 'because' },
  { slug: 'romance', title: 'Romance', require: { genres: ['Romance'] }, aired: { withinDays: 1095 }, sort: 'popularity' },
  { slug: 'docs', title: 'Documentaries and docuseries', require: { genres: ['Documentary'] }, aired: { withinDays: 730 }, sort: 'popularity' },
  { slug: 'reality', title: 'Reality and competition', kind: 'series', require: { genres: ['Reality'] }, aired: { withinDays: 730 }, sort: 'popularity' },
  {
    // "thief", "robbery" and "scam" pulled in Wicked, Conan and Saw X, so only heist and con keywords.
    slug: 'heists', title: 'Heists and cons',
    signals: { keywords: ['heist', 'bank robbery', 'art heist', 'jewel heist', 'casino heist', 'heist movie', 'con artist', 'con man', 'swindle', 'grifter', 'master thief'] },
    exclude: { genres: ['Documentary', 'Animation', 'Family'] },
  },
  { slug: 'animation', title: 'Anime and animation', require: { genres: ['Animation'] }, aired: { withinDays: 1095 },
    exclude: { genres: ['Kids', 'Family'] }, sort: 'popularity' },
  {
    slug: 'limited-series', title: 'Limited series',
    kind: 'series',
    signals: { types: ['tv_miniseries'], keywords: ['miniseries', 'limited series', 'mini-series'] },
    seasons: { max: 1 },
    exclude: { genres: ['Documentary', 'Reality', 'Talk', 'Kids'] },
  },
  { slug: 'because-3', title: 'Because you have', special: 'because' },
  { slug: 'family', title: 'Family and kids', require: { genres: ['Family', 'Kids'] }, aired: { withinDays: 1095 }, sort: 'popularity' },
  {
    // Tuned Nov 20 on the real catalog: 150+ votes keeps out brand-new titles rated
    // on a handful of votes; a 60-minute floor drops trailer specials and ambient videos.
    slug: 'hidden-gems', title: 'Hidden gems',
    rating: { min: 7.2 }, votes: { min: 150, max: 999 }, runtime: { min: 60 }, sort: 'rating',
    exclude: { genres: ['Documentary', 'Talk', 'News', 'Reality', 'Kids', 'Family'] },
  },
  {
    // A floor on rating and votes drops the stream of low-vote TV movies.
    slug: 'short-movies', title: 'Short movies', kind: 'movie',
    runtime: { min: 40, max: 89 }, rating: { min: 6 }, votes: { min: 100 },
    exclude: { genres: ['Documentary'], types: ['tv_special'] },
  },
  { slug: 'acclaimed', title: 'Critically acclaimed', rating: { min: 7.5 }, votes: { min: 1000 }, sort: 'rating' },
  { slug: 'popular', title: 'All-time popular', sort: 'popularity' },
]);

/**
 * Themes from `<DATA_DIR>/themes.json` when present (edit it, restart the
 * container), else the defaults. A broken file is logged and ignored, so a
 * typo never takes the app down.
 */
export function loadThemes(cfg: Config): ThemeRule[] {
  const file = cfg.DATA_DIR === ':memory:' ? null : join(cfg.DATA_DIR, 'themes.json');
  if (!file || !existsSync(file)) return DEFAULT_THEMES;
  try {
    const themes = ThemeFile.parse(JSON.parse(readFileSync(file, 'utf8')));
    log.info('themes: loaded from file', { file, count: themes.length });
    return themes;
  } catch (err) {
    log.error('themes: themes.json is invalid; using the built-in rows', { file, error: err instanceof Error ? err.message : String(err) });
    return DEFAULT_THEMES;
  }
}

const lower = (a: string[]) => a.map((s) => s.toLowerCase());
const qs = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** SQL for a theme, on top of the eligibility rule. Expects `tk` = title_kinds. */
const daysAgo = (now: Date, d: number) => new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);
const today = (now: Date) => now.toISOString().slice(0, 10);

export function themeWhere(t: ThemeRule, now = new Date()): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (t.kind) { where.push('tk.kind = ?'); params.push(t.kind); }

  const sig: string[] = [];
  const s = t.signals ?? {};
  if (s.keywords?.length) {
    sig.push(`EXISTS (SELECT 1 FROM title_keywords tkw JOIN keywords k ON k.id = tkw.keyword_id WHERE tkw.title_id = tk.id AND lower(k.name) IN (${qs(s.keywords.length)}))`);
    params.push(...lower(s.keywords));
  }
  if (s.genres?.length) {
    sig.push(`EXISTS (SELECT 1 FROM title_genres tgs JOIN genres g ON g.id = tgs.genre_id WHERE tgs.title_id = tk.id AND lower(g.name) IN (${qs(s.genres.length)}))`);
    params.push(...lower(s.genres));
  }
  if (s.types?.length) {
    sig.push(`tk.watchmode_type IN (${qs(s.types.length)})`);
    params.push(...s.types);
  }
  if (sig.length) where.push(`(${sig.join(' OR ')})`);

  if (t.require?.genres.length) {
    where.push(`EXISTS (SELECT 1 FROM title_genres tgr JOIN genres gr ON gr.id = tgr.genre_id WHERE tgr.title_id = tk.id AND lower(gr.name) IN (${qs(t.require.genres.length)}))`);
    params.push(...lower(t.require.genres));
  }
  const x = t.exclude ?? {};
  if (x.keywords?.length) {
    where.push(`NOT EXISTS (SELECT 1 FROM title_keywords tkx JOIN keywords kx ON kx.id = tkx.keyword_id WHERE tkx.title_id = tk.id AND lower(kx.name) IN (${qs(x.keywords.length)}))`);
    params.push(...lower(x.keywords));
  }
  if (x.genres?.length) {
    where.push(`NOT EXISTS (SELECT 1 FROM title_genres tgx JOIN genres gx ON gx.id = tgx.genre_id WHERE tgx.title_id = tk.id AND lower(gx.name) IN (${qs(x.genres.length)}))`);
    params.push(...lower(x.genres));
  }

  if (x.types?.length) { where.push(`tk.watchmode_type NOT IN (${qs(x.types.length)})`); params.push(...x.types); }

  const bound = (col: string, r?: { min?: number; max?: number }) => {
    if (r?.min !== undefined) { where.push(`${col} >= ?`); params.push(r.min); }
    if (r?.max !== undefined) { where.push(`${col} <= ?`); params.push(r.max); }
  };
  bound('tk.year', t.year);
  bound('tk.vote_average', t.rating);
  bound('tk.vote_count', t.votes);
  // Runtime is a movie property and season count a series one, so each limit
  // only constrains its own kind (a mixed theme keeps its series).
  const scoped = (kind: 'movie' | 'series', col: string, r?: { min?: number; max?: number }) => {
    if (r?.min !== undefined) { where.push(`(tk.kind <> '${kind}' OR ${col} >= ?)`); params.push(r.min); }
    if (r?.max !== undefined) { where.push(`(tk.kind <> '${kind}' OR ${col} <= ?)`); params.push(r.max); }
  };
  scoped('movie', 'tk.runtime', t.runtime);
  scoped('series', 'tk.seasons', t.seasons);
  if (t.released) { where.push('tk.release_date >= ? AND tk.release_date <= ?'); params.push(daysAgo(now, t.released.withinDays), today(now)); }
  if (t.aired?.withinDays) {
    where.push(`COALESCE(tk.last_air_date, tk.release_date) >= ? AND COALESCE(tk.last_air_date, tk.release_date) <= ?`);
    params.push(daysAgo(now, t.aired.withinDays), today(now));
  }
  if (t.aired?.olderThanDays) {                    // no date at all counts as old
    where.push(`COALESCE(tk.last_air_date, tk.release_date, '0000') < ?`);
    params.push(daysAgo(now, t.aired.olderThanDays));
  }
  if (t.originals !== undefined) where.push(t.originals ? 'tk.netflix_original = 1' : 'tk.netflix_original = 0');
  if (t.addedWithin) { where.push('a.added_at >= ?'); params.push(new Date(now.getTime() - t.addedWithin * 86_400_000).toISOString()); }
  return { sql: where.length ? where.join(' AND ') : '1 = 1', params };
}
