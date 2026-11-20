import type { Config } from '../config.js';
import { all, getJobState, setJobState, type Db } from '../db/db.js';
import { mapLimit } from '../clients/http.js';
import type { DiscoverItem, TmdbClient } from '../clients/tmdb.js';
import { log } from '../log.js';

export interface CrossCheckSample { tmdbId: number; type: 'movie' | 'tv'; title: string; year: number | null }

export interface CrossCheckState {
  ok: boolean;
  at: string;
  error?: string;
  tmdbTotal?: number;        // titles TMDB lists on Netflix US
  oursTotal?: number;        // titles we list, with a TMDB ID
  both?: number;
  coveragePct?: number;      // share of TMDB's list we also have
  agreementPct?: number;     // share of ours that TMDB also has
  byType?: Record<'movie' | 'tv', { tmdb: number; ours: number; both: number }>;
  onlyTmdb?: CrossCheckSample[];   // most popular titles TMDB has and we don't
  onlyOurs?: CrossCheckSample[];   // most popular titles we have and TMDB doesn't
  durationMs?: number;
}

const MAX_PAGES = 500;      // TMDB discover stops at page 500

/**
 * Lists every title TMDB (JustWatch data) has on Netflix US and compares it with
 * our catalog, by TMDB ID. Two independent sources agreeing is the check that
 * Watchmode's list hasn't drifted. Read-only and free (TMDB has no quota).
 */
export async function runCrossCheck(db: Db, cfg: Config, tmdb: TmdbClient, now = new Date()): Promise<CrossCheckState> {
  const started = Date.now();
  const at = now.toISOString();
  try {
    const theirs = new Map<string, DiscoverItem & { type: 'movie' | 'tv' }>();
    for (const type of ['movie', 'tv'] as const) {
      const first = await tmdb.discover(type, cfg.TMDB_NETFLIX_PROVIDER_ID, cfg.REGION, 1);
      const pages = Math.min(first.totalPages, MAX_PAGES);
      const rest = await mapLimit(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2), 6,
        (page) => tmdb.discover(type, cfg.TMDB_NETFLIX_PROVIDER_ID, cfg.REGION, page));
      for (const r of [first, ...rest]) for (const item of r.results) theirs.set(`${type}:${item.id}`, { ...item, type });
    }

    const oursRows = all<{ tmdb_type: 'movie' | 'tv'; tmdb_id: number; title: string; year: number | null; popularity: number | null }>(db, `
      SELECT t.tmdb_type, t.tmdb_id, COALESCE(t.tmdb_title, t.title) title, t.year, max(t.popularity) popularity
      FROM availability a JOIN titles t ON t.id = a.title_id
      WHERE a.provider_id = ? AND a.region = ? AND a.removed_at IS NULL AND t.tmdb_id IS NOT NULL AND t.tmdb_type IS NOT NULL
      GROUP BY t.tmdb_type, t.tmdb_id`, [cfg.NETFLIX_SOURCE_ID, cfg.REGION]);
    const ours = new Map(oursRows.map((r) => [`${r.tmdb_type}:${r.tmdb_id}`, r]));

    const byType = { movie: { tmdb: 0, ours: 0, both: 0 }, tv: { tmdb: 0, ours: 0, both: 0 } };
    for (const [k, v] of theirs) { byType[v.type].tmdb++; if (ours.has(k)) byType[v.type].both++; }
    for (const v of ours.values()) byType[v.tmdb_type].ours++;
    const both = byType.movie.both + byType.tv.both;
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

    const onlyTmdb = [...theirs.entries()].filter(([k]) => !ours.has(k)).map(([, v]) => v)
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)).slice(0, 25)
      .map((v) => ({ tmdbId: v.id, type: v.type, title: v.title, year: v.year }));
    const onlyOurs = [...ours.entries()].filter(([k]) => !theirs.has(k)).map(([, v]) => v)
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)).slice(0, 25)
      .map((v) => ({ tmdbId: v.tmdb_id, type: v.tmdb_type, title: v.title, year: v.year }));

    const state: CrossCheckState = {
      ok: true, at, tmdbTotal: theirs.size, oursTotal: ours.size, both,
      coveragePct: pct(both, theirs.size), agreementPct: pct(both, ours.size),
      byType, onlyTmdb, onlyOurs, durationMs: Date.now() - started,
    };
    log.info('crosscheck: done', { tmdb: state.tmdbTotal, ours: state.oursTotal, both, coveragePct: state.coveragePct, agreementPct: state.agreementPct });
    return record(db, state);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('crosscheck: failed', { error });
    return record(db, { ok: false, at, error, durationMs: Date.now() - started });
  }
}

function record(db: Db, state: CrossCheckState): CrossCheckState {
  const prev = getJobState<CrossCheckState & { previousCoveragePct?: number | null }>(db, 'crosscheck')?.value;
  // Remember the last good coverage so a sudden drop can be spotted.
  const previousCoveragePct = prev?.ok ? prev.coveragePct ?? null : prev?.previousCoveragePct ?? null;
  setJobState(db, 'crosscheck', { ...state, previousCoveragePct });
  return state;
}

export function lastCrossCheck(db: Db) {
  return getJobState<CrossCheckState & { previousCoveragePct?: number | null }>(db, 'crosscheck')?.value ?? null;
}
