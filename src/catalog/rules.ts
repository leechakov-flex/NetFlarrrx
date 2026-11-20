import type { Config } from '../config.js';
import { get, type Db } from '../db/db.js';

/**
 * SQL fragment for titles the app shows: currently on the service, a supported
 * kind (tv_special excluded via the title_kinds view), and passing the language rule.
 * Applied at query time, so changing LANGUAGE_RULE needs no re-sync.
 * Expects `tk` = title_kinds and `a` = availability in the query.
 */
export function eligibleWhere(cfg: Config): { sql: string; params: (string | number)[] } {
  const parts = ['a.provider_id = ?', 'a.region = ?', 'a.removed_at IS NULL', 'tk.kind IS NOT NULL'];
  const params: (string | number)[] = [cfg.NETFLIX_SOURCE_ID, cfg.REGION];
  if (cfg.LANGUAGE_RULE === 'en') parts.push(`tk.original_language = 'en'`);
  return { sql: parts.join(' AND '), params };
}

export interface CatalogStats {
  on_service: number;
  eligible: number;
  eligible_movies: number;
  eligible_series: number;
  dated: number;               // eligible titles with a real date added
  enrichment: { ok: number; pending: number; missing: number; error: number; no_tmdb_id: number };
  language_rule: Config['LANGUAGE_RULE'];
}

export function catalogStats(db: Db, cfg: Config): CatalogStats {
  const where = eligibleWhere(cfg);
  const on = get<{ n: number }>(db, `SELECT count(*) n FROM availability a WHERE a.provider_id = ? AND a.region = ? AND a.removed_at IS NULL`,
    [cfg.NETFLIX_SOURCE_ID, cfg.REGION])!.n;
  const e = get<{ n: number; movies: number; series: number; dated: number }>(db, `
    SELECT count(*) n, sum(tk.kind = 'movie') movies, sum(tk.kind = 'series') series, sum(a.added_at IS NOT NULL) dated
    FROM availability a JOIN title_kinds tk ON tk.id = a.title_id WHERE ${where.sql}`, where.params)!;
  const s = get<Record<string, number>>(db, `
    SELECT sum(tmdb_status = 'ok') ok, sum(tmdb_status = 'pending') pending, sum(tmdb_status = 'missing') missing,
           sum(tmdb_status = 'error') error, sum(tmdb_status = 'no_tmdb_id') no_tmdb_id
    FROM titles t JOIN availability a ON a.title_id = t.id AND a.removed_at IS NULL`)!;
  return {
    on_service: on,
    eligible: e.n,
    eligible_movies: e.movies ?? 0,
    eligible_series: e.series ?? 0,
    dated: e.dated ?? 0,
    enrichment: { ok: s.ok ?? 0, pending: s.pending ?? 0, missing: s.missing ?? 0, error: s.error ?? 0, no_tmdb_id: s.no_tmdb_id ?? 0 },
    language_rule: cfg.LANGUAGE_RULE,
  };
}
