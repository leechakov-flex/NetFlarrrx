import type { Config } from '../config.js';
import { all, get, run, type Db } from '../db/db.js';
import { DIGITAL_ID, enabledServices, serviceByKey, type ServiceKey } from '../services.js';

/** Where a title can be watched, for the "how to watch" filter. */
export type How = 'sub' | 'digital' | 'soon';

/** Which availability a query looks at: some services, rent or buy, coming soon. */
/** `servicesOnly`: picked services mean only those, so rent or buy (no service) drops out. */
export interface Scope { services?: ServiceKey[]; how?: How[]; servicesOnly?: boolean }

/**
 * The `a` table every catalog query reads: one row per title, across the
 * services in scope. `added_at` is the newest arrival among them (a title new on
 * Max but old on Netflix is new), `providers` lists where it is, and `soon_date`
 * is set for upcoming premieres. Join it as `FROM <sql>` with `tk` = title_kinds.
 */
export function scopeFrom(cfg: Config, scope: Scope = {}, now = new Date()): { sql: string; params: (string | number)[] } {
  const how = new Set<How>(scope.how?.length ? scope.how : ['sub']);
  const enabled = enabledServices(cfg.SERVICES);
  const chosen = scope.services?.length ? enabled.filter((s) => scope.services!.includes(s.key)) : enabled;
  const providers: number[] = [];
  if (how.has('sub')) providers.push(...chosen.map((s) => s.id));
  const strict = !!(scope.servicesOnly && scope.services?.length);
  if (how.has('digital') && !strict) providers.push(DIGITAL_ID);
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (providers.length) {
    parts.push(`SELECT av.title_id, av.added_at, av.back_on_service, av.first_seen_at, av.provider_id, NULL AS soon_date, NULL AS soon_service
      FROM availability av WHERE av.region = ? AND av.removed_at IS NULL AND av.provider_id IN (${providers.map(() => '?').join(',')})`);
    params.push(cfg.REGION, ...providers);
  }
  if (how.has('soon')) {
    // Series premieres name their service; movies are matched to one later, from TMDB's note.
    const keys = chosen.map((s) => s.key);
    parts.push(`SELECT u.title_id, NULL AS added_at, 0 AS back_on_service, NULL AS first_seen_at, NULL AS provider_id, u.date AS soon_date, u.service AS soon_service FROM upcoming u
      WHERE u.date > ? AND (${strict ? '' : 'u.service IS NULL OR '}u.service IN (${keys.map(() => '?').join(',')}))`);
    params.push(now.toISOString().slice(0, 10), ...keys);
  }
  if (!parts.length) return { sql: `(SELECT NULL AS title_id, NULL AS added_at, 0 AS back_on_service, NULL AS first_seen_at, NULL AS providers, NULL AS soon_date, NULL AS soon_service WHERE 0) a`, params: [] };
  return {
    sql: `(SELECT title_id, max(added_at) AS added_at, max(back_on_service) AS back_on_service, min(first_seen_at) AS first_seen_at,
             group_concat(DISTINCT provider_id) AS providers, min(soon_date) AS soon_date, max(soon_service) AS soon_service
           FROM (${parts.join(' UNION ALL ')}) GROUP BY title_id) a`,
    params,
  };
}

/** Service keys for a `providers` list ("203,1387"), Netflix first; rent or buy is reported separately. */
export function providerKeys(providers: string | null): { services: ServiceKey[]; digital: boolean } {
  const ids = (providers ?? '').split(',').filter(Boolean).map(Number);
  const services = enabledOrder.filter((s) => ids.includes(s.id)).map((s) => s.key);
  return { services, digital: ids.includes(DIGITAL_ID) };
}
const enabledOrder = enabledServices('netflix,prime,hbomax,hulu,disney,paramount,peacock');

/** The service a coming-soon movie is for, from TMDB's release note; null = rent or buy. */
export function soonService(cfg: Config, service: string | null, note: string | null, netflixOriginal: number): ServiceKey | null {
  if (service && serviceByKey(service)) return service as ServiceKey;
  const enabled = enabledServices(cfg.SERVICES);
  if (note) { const hit = enabled.find((s) => s.releaseNote.test(note)); if (hit) return hit.key; }
  if (netflixOriginal) return 'netflix';
  return null;
}

/**
 * SQL fragment for titles the app shows: a supported kind and passing the
 * language rule. Which services count is set by the scope (see scopeFrom).
 * Applied at query time, so changing LANGUAGE_RULE needs no re-sync.
 */
export function eligibleWhere(cfg: Config): { sql: string; params: (string | number)[] } {
  const parts = ['tk.kind IS NOT NULL'];
  if (cfg.LANGUAGE_RULE === 'en') parts.push(`tk.original_language = 'en'`);
  return { sql: parts.join(' AND '), params: [] };
}

export interface CatalogStats {
  on_service: number;
  eligible: number;
  eligible_movies: number;
  eligible_series: number;
  dated: number;               // eligible titles with a real date added
  enrichment: { ok: number; pending: number; missing: number; error: number; no_tmdb_id: number };
  language_rule: Config['LANGUAGE_RULE'];
  services: { key: ServiceKey; name: string; on_service: number; dated: number }[];
  digital: number;
  upcoming: number;
}

export function catalogStats(db: Db, cfg: Config, now = new Date()): CatalogStats {
  const where = eligibleWhere(cfg);
  const netflix = scopeFrom(cfg, { services: ['netflix'] }, now);
  const on = get<{ n: number }>(db, `SELECT count(*) n FROM availability a WHERE a.provider_id = ? AND a.region = ? AND a.removed_at IS NULL`,
    [cfg.NETFLIX_SOURCE_ID, cfg.REGION])!.n;
  const e = get<{ n: number; movies: number; series: number; dated: number }>(db, `
    SELECT count(*) n, sum(tk.kind = 'movie') movies, sum(tk.kind = 'series') series, sum(a.added_at IS NOT NULL) dated
    FROM ${netflix.sql} JOIN title_kinds tk ON tk.id = a.title_id WHERE ${where.sql}`, [...netflix.params, ...where.params])!;
  const s = get<Record<string, number>>(db, `
    SELECT sum(tmdb_status = 'ok') ok, sum(tmdb_status = 'pending') pending, sum(tmdb_status = 'missing') missing,
           sum(tmdb_status = 'error') error, sum(tmdb_status = 'no_tmdb_id') no_tmdb_id
    FROM titles t WHERE EXISTS (SELECT 1 FROM availability a WHERE a.title_id = t.id AND a.removed_at IS NULL)
       OR EXISTS (SELECT 1 FROM upcoming u WHERE u.title_id = t.id)`)!;
  const per = all<{ provider_id: number; n: number; dated: number }>(db, `
    SELECT provider_id, count(*) n, sum(added_at IS NOT NULL) dated FROM availability WHERE region = ? AND removed_at IS NULL GROUP BY provider_id`, [cfg.REGION]);
  const by = new Map(per.map((r) => [r.provider_id, r]));
  return {
    on_service: on,
    eligible: e.n,
    eligible_movies: e.movies ?? 0,
    eligible_series: e.series ?? 0,
    dated: e.dated ?? 0,
    enrichment: { ok: s.ok ?? 0, pending: s.pending ?? 0, missing: s.missing ?? 0, error: s.error ?? 0, no_tmdb_id: s.no_tmdb_id ?? 0 },
    language_rule: cfg.LANGUAGE_RULE,
    services: enabledServices(cfg.SERVICES).map((sv) => ({ key: sv.key, name: sv.name, on_service: by.get(sv.id)?.n ?? 0, dated: by.get(sv.id)?.dated ?? 0 })),
    digital: by.get(DIGITAL_ID)?.n ?? 0,
    upcoming: get<{ n: number }>(db, 'SELECT count(*) n FROM upcoming WHERE date > ?', [now.toISOString().slice(0, 10)])!.n,
  };
}

/**
 * Fills in the service for coming-soon movies once TMDB's release note is in, so a
 * service chip can tell a Netflix premiere from a rent-or-buy one. Runs after enrich.
 */
export function resolveUpcomingServices(db: Db, cfg: Config): number {
  const rows = all<{ title_id: number; digital_note: string | null; netflix_original: number }>(db,
    'SELECT u.title_id, t.digital_note, t.netflix_original FROM upcoming u JOIN titles t ON t.id = u.title_id WHERE u.service IS NULL');
  let n = 0;
  for (const r of rows) {
    const key = soonService(cfg, null, r.digital_note, r.netflix_original);
    if (key) { run(db, 'UPDATE upcoming SET service = ? WHERE title_id = ?', [key, r.title_id]); n++; }
  }
  return n;
}
