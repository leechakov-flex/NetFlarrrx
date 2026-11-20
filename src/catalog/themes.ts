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
    types: z.array(z.enum(['movie', 'tv_movie', 'short_film', 'tv_series', 'tv_miniseries'])).optional(),
  }).strict().optional(),
  exclude: z.object({
    keywords: z.array(z.string()).optional(),
    genres: z.array(z.string()).optional(),
  }).strict().optional(),
  year: range.optional(),
  rating: range.optional(),         // TMDB vote average, 0-10
  votes: range.optional(),          // TMDB vote count
  runtime: range.optional(),        // minutes, movies
  seasons: range.optional(),        // season count, series
  sort: z.enum(['added', 'rating', 'popularity', 'release', 'title']).default('added'),
  home: z.boolean().default(true),  // show as a row on Discover
}).strict();
export type ThemeRule = z.infer<typeof ThemeRule>;

const ThemeFile = z.array(ThemeRule).refine((a) => new Set(a.map((t) => t.slug)).size === a.length, 'theme slugs must be unique');

/** The six starter rows from the PRD, tuned on first use. Order = order on Discover. */
export const DEFAULT_THEMES: ThemeRule[] = ThemeFile.parse([
  {
    slug: 'acclaimed', title: 'Critically acclaimed',
    rating: { min: 7.5 }, votes: { min: 1000 }, sort: 'rating',
  },
  {
    slug: 'hidden-gems', title: 'Hidden gems',
    rating: { min: 7.2 }, votes: { min: 50, max: 999 }, sort: 'rating',
    exclude: { genres: ['Documentary', 'Talk', 'News', 'Reality'] },
  },
  {
    slug: 'true-stories', title: 'Based on a true story',
    signals: { keywords: ['based on true story', 'based on a true story', 'based on real events', 'based on real person', 'true story', 'biography', 'true crime', 'historical figure'] },
    exclude: { genres: ['Documentary', 'Reality'] },
  },
  {
    slug: 'heists', title: 'Heists and cons',
    signals: { keywords: ['heist', 'bank robbery', 'robbery', 'art heist', 'jewel heist', 'casino heist', 'heist movie', 'con artist', 'con man', 'swindle', 'scam', 'grifter', 'master thief', 'thief'] },
    exclude: { genres: ['Documentary', 'Animation', 'Family'] },
  },
  {
    slug: 'limited-series', title: 'Limited series',
    kind: 'series',
    signals: { types: ['tv_miniseries'], keywords: ['miniseries', 'limited series', 'mini-series'] },
    seasons: { max: 1 },
    exclude: { genres: ['Documentary', 'Reality', 'Talk', 'Kids'] },
  },
  {
    slug: 'short-movies', title: 'Short movies',
    kind: 'movie',
    runtime: { min: 40, max: 89 },
    exclude: { genres: ['Documentary'] },
  },
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
export function themeWhere(t: ThemeRule): { sql: string; params: (string | number)[] } {
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

  const x = t.exclude ?? {};
  if (x.keywords?.length) {
    where.push(`NOT EXISTS (SELECT 1 FROM title_keywords tkx JOIN keywords kx ON kx.id = tkx.keyword_id WHERE tkx.title_id = tk.id AND lower(kx.name) IN (${qs(x.keywords.length)}))`);
    params.push(...lower(x.keywords));
  }
  if (x.genres?.length) {
    where.push(`NOT EXISTS (SELECT 1 FROM title_genres tgx JOIN genres gx ON gx.id = tgx.genre_id WHERE tgx.title_id = tk.id AND lower(gx.name) IN (${qs(x.genres.length)}))`);
    params.push(...lower(x.genres));
  }

  const bound = (col: string, r?: { min?: number; max?: number }) => {
    if (r?.min !== undefined) { where.push(`${col} >= ?`); params.push(r.min); }
    if (r?.max !== undefined) { where.push(`${col} <= ?`); params.push(r.max); }
  };
  bound('tk.year', t.year);
  bound('tk.vote_average', t.rating);
  bound('tk.vote_count', t.votes);
  bound('tk.runtime', t.runtime);
  bound('tk.seasons', t.seasons);
  return { sql: where.length ? where.join(' AND ') : '1 = 1', params };
}
