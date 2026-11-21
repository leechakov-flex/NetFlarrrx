import type { Config } from '../config.js';
import { all, get, run, tx, type Db } from '../db/db.js';
import { HttpError } from '../clients/http.js';
import type { WatchmodeClient, WatchmodeTitle } from '../clients/watchmode.js';
import { diffSnapshot, summarize, type AvailabilityState } from './diff.js';
import { log } from '../log.js';
import { MOVIE_TYPES, SERIES_TYPES, tmdbOnlyId, type Slice } from '../services.js';

export type Trigger = 'schedule' | 'manual' | 'cli';
export type RunStatus = 'running' | 'complete' | 'partial' | 'held' | 'failed' | 'skipped';

export interface SyncRunRow {
  id: number;
  provider_id: number;
  region: string;
  trigger: Trigger;
  status: RunStatus;
  applied: number;
  baseline: number;
  started_at: string;
  finished_at: string | null;
  confirmed_at: string | null;
  pages_total: number | null;
  pages_fetched: number | null;
  failed_pages: string | null;
  titles_seen: number | null;
  previous_count: number | null;
  added: number | null;
  returned: number | null;
  back_on_service: number | null;
  missed: number | null;
  removed: number | null;
  quota: number | null;
  quota_used_before: number | null;
  quota_used_after: number | null;
  note: string | null;
  slice: Slice;
  source: 'watchmode' | 'tmdb';
}

export interface SyncDeps {
  db: Db;
  cfg: Config;
  watchmode: WatchmodeClient;
  now?: () => Date;
}

const STALE_RUN_MS = 2 * 3600_000;
const OBSERVATION_KEEP_DAYS = 30;

/** What one run lists: a service's whole catalog, or just its movies or series. */
export interface SliceTarget {
  providerId: number;              // availability.provider_id
  slice: Slice;
  source: 'watchmode' | 'tmdb';
  /** Watchmode source id to list (watchmode only). */
  watchmodeSourceId?: number;
  /** TMDB listing (tmdb only): every title the service has in this slice. */
  tmdbList?: () => Promise<{ titles: WatchmodeTitle[]; pages: number; failedPages: number[] }>;
  label?: string;
}

export const sliceTypes = (slice: Slice): readonly string[] | undefined =>
  slice === 'movies' ? MOVIE_TYPES : slice === 'series' ? SERIES_TYPES : undefined;

/** Netflix's whole catalog from Watchmode, as M1 did. Kept for the CLI and tests. */
export function runCatalogSync(deps: SyncDeps, trigger: Trigger): Promise<SyncRunRow> {
  return runSliceSync(deps, trigger, { providerId: deps.cfg.NETFLIX_SOURCE_ID, slice: 'all', source: 'watchmode', watchmodeSourceId: deps.cfg.NETFLIX_SOURCE_ID });
}

export async function runSliceSync(deps: SyncDeps, trigger: Trigger, target: SliceTarget): Promise<SyncRunRow> {
  const { db, cfg, watchmode } = deps;
  const now = deps.now ?? (() => new Date());
  const provider = target.providerId;
  const { slice, source } = target;
  const region = cfg.REGION;
  const startedAt = now().toISOString();
  const types = sliceTypes(slice);

  // One sync at a time per slice. A "running" row older than 2 hours is a crashed run.
  const running = get<{ id: number; started_at: string }>(db,
    `SELECT id, started_at FROM sync_runs WHERE provider_id = ? AND region = ? AND slice = ? AND status = 'running' ORDER BY id DESC LIMIT 1`,
    [provider, region, slice]);
  if (running) {
    if (Date.parse(startedAt) - Date.parse(running.started_at) < STALE_RUN_MS) {
      return insertRun(db, { provider, region, slice, source, trigger, status: 'skipped', startedAt, finishedAt: startedAt, note: `run ${running.id} still in progress` });
    }
    run(db, `UPDATE sync_runs SET status = 'failed', finished_at = ?, note = 'abandoned: process stopped mid-run' WHERE id = ?`, [startedAt, running.id]);
  }

  const runRow = insertRun(db, { provider, region, slice, source, trigger, status: 'running', startedAt });
  const runId = runRow.id;
  const finish = (fields: Partial<SyncRunRow>) => updateRun(db, runId, { finished_at: now().toISOString(), ...fields });

  const titles = new Map<number, WatchmodeTitle>();
  const failedPages: number[] = [];
  let totalPages = 1;
  let fetched = 0;
  let invalidRows = 0;
  let quota: number | null = null;
  let usedBefore: number | null = null;
  let usedAfter: number | null = null;

  if (source === 'watchmode') {
    const sourceId = target.watchmodeSourceId;
    if (!sourceId) return finish({ status: 'failed', note: 'no Watchmode source id for this service' });
    // 1. Credit check (free).
    const last = lastRun(db, provider, region, slice, `status IN ('complete', 'partial', 'held') AND pages_total IS NOT NULL`);
    const expectedPages = last?.pages_total ?? 30;
    try {
      const s = await watchmode.status();
      quota = s.quota; usedBefore = s.quotaUsed;
    } catch (err) {
      log.error('sync: Watchmode status check failed', { run: runId, error: describe(err) });
      return finish({ status: 'failed', note: `status check failed: ${describe(err)}` });
    }
    const needed = Math.ceil(expectedPages * 1.2);
    if (quota - usedBefore < needed) {
      log.warn('sync: not enough Watchmode credits', { run: runId, left: quota - usedBefore, needed });
      return finish({ status: 'failed', quota, quota_used_before: usedBefore, note: `not enough credits: ${quota - usedBefore} left, ${needed} needed` });
    }

    // 2. Crawl. A page that still fails after the client's retries marks the run partial.
    for (let page = 1; page <= totalPages; page += 1) {
      try {
        const p = await watchmode.listTitlesPage(sourceId, region, page, types);
        totalPages = p.totalPages;
        invalidRows += p.invalid;
        fetched += 1;
        for (const t of p.titles) titles.set(t.id, t);
      } catch (err) {
        failedPages.push(page);
        log.warn('sync: page failed', { run: runId, page, error: describe(err) });
        if (err instanceof HttpError && err.isAuth) {
          return finish({ status: 'failed', pages_fetched: fetched, quota, quota_used_before: usedBefore, note: `auth failed: ${describe(err)}` });
        }
        if (page === 1) {
          return finish({ status: 'failed', pages_fetched: 0, quota, quota_used_before: usedBefore, note: `first page failed: ${describe(err)}` });
        }
      }
    }
    try { usedAfter = (await watchmode.status()).quotaUsed; } catch { /* informational only */ }
  } else {
    if (!target.tmdbList) return finish({ status: 'failed', note: 'no TMDB listing for this service' });
    try {
      const l = await target.tmdbList();
      totalPages = l.pages; fetched = l.pages - l.failedPages.length; failedPages.push(...l.failedPages);
      for (const t of l.titles) titles.set(t.id, t);
    } catch (err) {
      if (err instanceof HttpError && err.isAuth) return finish({ status: 'failed', note: `TMDB rejected the token: ${describe(err)}` });
      return finish({ status: 'failed', note: `TMDB listing failed: ${describe(err)}` });
    }
  }

  const nowIso = now().toISOString();
  const seenIds = [...titles.keys()];

  // 3. Titles and observations are recorded for every run that got data.
  tx(db, () => {
    upsertTitles(db, [...titles.values()], nowIso);
    const ins = db.prepare('INSERT OR IGNORE INTO sync_observations (run_id, watchmode_id) VALUES (?, ?)');
    for (const id of seenIds) ins.run(runId, id);
  });

  const base = {
    pages_total: totalPages, pages_fetched: fetched, failed_pages: JSON.stringify(failedPages),
    titles_seen: seenIds.length, quota, quota_used_before: usedBefore, quota_used_after: usedAfter,
  };
  const notes: string[] = [];
  if (invalidRows) notes.push(`${invalidRows} rows failed validation`);

  if (failedPages.length) {
    log.warn('sync: partial run, not diffed', { run: runId, failedPages });
    return finish({ ...base, status: 'partial', note: [...notes, `pages failed: ${failedPages.join(', ')}`].join('; ') });
  }

  // 4. Hold suspicious swings for a human. A slice's first run compares with
  // what the service had in that slice before (e.g. Netflix's movies from full syncs).
  const prevApplied = lastRun(db, provider, region, slice, `applied = 1`);
  // Full-catalog runs (M1) count as history for every slice.
  const anyApplied = prevApplied ?? lastRun(db, provider, region, 'all', `applied = 1`);
  const previousCount = prevApplied?.titles_seen ?? (anyApplied ? activeCount(db, provider, region, slice) : null);
  if (seenIds.length === 0) {
    return finish({ ...base, status: 'held', previous_count: previousCount, note: [...notes, 'empty catalog; held'].join('; ') });
  }
  if (previousCount) {
    const swing = (100 * Math.abs(seenIds.length - previousCount)) / previousCount;
    if (swing > cfg.MAX_SWING_PCT) {
      log.warn('sync: held, count swing too large', { run: runId, previousCount, now: seenIds.length, swing: Math.round(swing) });
      return finish({ ...base, status: 'held', previous_count: previousCount,
        note: [...notes, `count moved ${Math.round(swing)}% (${previousCount} -> ${seenIds.length}); confirm to apply`].join('; ') });
    }
  }

  // 5. Apply. A slice's very first run is its baseline: those titles get no date added.
  const baseline = !anyApplied;
  // Weekly slices: remember when the previous run was, to date new arrivals by their premiere.
  const windowStart = slice === 'series' ? (prevApplied ?? anyApplied)?.started_at ?? null : null;
  const counts = applySnapshot(db, cfg, provider, region, slice, seenIds, nowIso, baseline, windowStart);
  pruneObservations(db, nowIso);
  log.info('sync: complete', { run: runId, titles: seenIds.length, baseline, ...counts });
  return finish({ ...base, status: 'complete', applied: 1, baseline: baseline ? 1 : 0, previous_count: previousCount, ...counts,
    note: notes.join('; ') || null });
}

/** Releases a held run: applies its recorded snapshot as of when it ran. */
export function confirmHeldRun(db: Db, cfg: Config, runId: number, now = new Date()): SyncRunRow {
  const r = get<SyncRunRow>(db, 'SELECT * FROM sync_runs WHERE id = ?', [runId]);
  if (!r) throw new Error(`run ${runId} not found`);
  if (r.status !== 'held') throw new Error(`run ${runId} is ${r.status}, not held`);
  const later = get<{ id: number }>(db,
    `SELECT id FROM sync_runs WHERE provider_id = ? AND region = ? AND slice = ? AND id > ? AND applied = 1 LIMIT 1`, [r.provider_id, r.region, r.slice, runId]);
  if (later) throw new Error(`run ${runId} is older than applied run ${later.id}; nothing to confirm`);
  const ids = all<{ watchmode_id: number }>(db, 'SELECT watchmode_id FROM sync_observations WHERE run_id = ?', [runId]).map((x) => x.watchmode_id);
  const prev = lastRun(db, r.provider_id, r.region, r.slice, 'applied = 1');
  const anyApplied = prev ?? lastRun(db, r.provider_id, r.region, 'all', 'applied = 1');
  const windowStart = r.slice === 'series' ? (prev ?? anyApplied)?.started_at ?? null : null;
  const baseline = !anyApplied;
  const counts = applySnapshot(db, cfg, r.provider_id, r.region, r.slice, ids, r.started_at, baseline, windowStart);
  return updateRun(db, runId, { status: 'complete', applied: 1, baseline: baseline ? 1 : 0, confirmed_at: now.toISOString(), ...counts });
}

/** SQL limiting titles `t` to a slice's types. */
function sliceWhere(slice: Slice): { sql: string; params: string[] } {
  const types = sliceTypes(slice);
  return types ? { sql: `t.watchmode_type IN (${types.map(() => '?').join(',')})`, params: [...types] } : { sql: '1', params: [] };
}

function activeCount(db: Db, provider: number, region: string, slice: Slice) {
  const w = sliceWhere(slice);
  return get<{ n: number }>(db, `SELECT count(*) n FROM availability a JOIN titles t ON t.id = a.title_id
    WHERE a.provider_id = ? AND a.region = ? AND a.removed_at IS NULL AND ${w.sql}`, [provider, region, ...w.params])!.n || null;
}

function applySnapshot(db: Db, cfg: Config, provider: number, region: string, slice: Slice, watchmodeIds: number[], nowIso: string, baseline: boolean, windowStart: string | null) {
  return tx(db, () => {
    // Only rows in this slice: a movies run says nothing about series.
    const w = sliceWhere(slice);
    const state = all<AvailabilityState>(db, `
      SELECT a.id, t.watchmode_id AS watchmodeId, a.added_at AS addedAt, a.missing_count AS missingCount,
             a.missing_since AS missingSince, a.removed_at AS removedAt
      FROM availability a JOIN titles t ON t.id = a.title_id
      WHERE a.provider_id = ? AND a.region = ? AND ${w.sql}`, [provider, region, ...w.params]);
    const d = diffSnapshot(state, watchmodeIds, {
      now: nowIso, baseline, removeAfterMisses: cfg.REMOVE_AFTER_MISSES, returnWindowDays: cfg.RETURN_WINDOW_DAYS,
    });

    const titleId = db.prepare('SELECT id FROM titles WHERE watchmode_id = ?');
    // A title can already have a row for this provider from another slice
    // (it changed type); then it's just seen again.
    const insert = db.prepare(`INSERT INTO availability (title_id, provider_id, region, first_seen_at, added_at, last_seen_at, baseline, added_window_start)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT (title_id, provider_id, region) DO UPDATE SET last_seen_at = excluded.last_seen_at,
                                 missing_count = 0, missing_since = NULL, removed_at = NULL`);
    for (const i of d.insert) {
      const row = titleId.get(i.watchmodeId) as { id: number } | undefined;
      if (!row) throw new Error(`title ${i.watchmodeId} missing from titles table`);
      insert.run(row.id, provider, region, nowIso, i.addedAt, nowIso, i.baseline ? 1 : 0, i.addedAt && windowStart ? windowStart : null);
    }
    const seen = db.prepare('UPDATE availability SET last_seen_at = ?, missing_count = 0, missing_since = NULL WHERE id = ?');
    for (const id of d.seen) seen.run(nowIso, id);
    const keep = db.prepare('UPDATE availability SET last_seen_at = ?, missing_count = 0, missing_since = NULL, removed_at = NULL WHERE id = ?');
    for (const id of d.returnedKeepDate) keep.run(nowIso, id);
    const back = db.prepare(`UPDATE availability SET last_seen_at = ?, missing_count = 0, missing_since = NULL, removed_at = NULL,
                             added_at = ?, back_on_service = 1 WHERE id = ?`);
    for (const id of d.returnedNewDate) back.run(nowIso, nowIso, id);
    const miss = db.prepare('UPDATE availability SET missing_count = ?, missing_since = ? WHERE id = ?');
    for (const m of d.missed) miss.run(m.missingCount, m.missingSince, m.id);
    const rem = db.prepare('UPDATE availability SET missing_count = ?, removed_at = ? WHERE id = ?');
    for (const r of d.removed) rem.run(r.missingCount, r.removedAt, r.id);
    return summarize(d);
  });
}

export function upsertTitles(db: Db, titles: WatchmodeTitle[], nowIso: string) {
  // A title first seen through TMDB (Prime Video, rent or buy, coming soon) has a
  // stand-in id. When Watchmode lists it, the row takes Watchmode's id, so it
  // stays one title with all its history.
  const adopt = db.prepare(`UPDATE titles SET watchmode_id = ? WHERE watchmode_id = ?
                            AND NOT EXISTS (SELECT 1 FROM titles x WHERE x.watchmode_id = ?)`);
  for (const t of titles) {
    if (t.id > 0 && t.tmdb_id != null && t.tmdb_type != null) adopt.run(t.id, tmdbOnlyId(t.tmdb_type, t.tmdb_id), t.id);
  }
  const stmt = db.prepare(`
    INSERT INTO titles (watchmode_id, title, year, watchmode_type, imdb_id, tmdb_id, tmdb_type, tmdb_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (watchmode_id) DO UPDATE SET
      title = excluded.title,
      year = excluded.year,
      watchmode_type = excluded.watchmode_type,
      imdb_id = excluded.imdb_id,
      tmdb_status = CASE
        WHEN excluded.tmdb_id IS NULL THEN 'no_tmdb_id'
        WHEN titles.tmdb_id IS excluded.tmdb_id AND titles.tmdb_type IS excluded.tmdb_type THEN titles.tmdb_status
        ELSE 'pending' END,
      tmdb_id = excluded.tmdb_id,
      tmdb_type = excluded.tmdb_type,
      updated_at = excluded.updated_at`);
  for (const t of titles) {
    const hasTmdb = t.tmdb_id != null && t.tmdb_type != null;
    stmt.run(t.id, t.title, t.year ?? null, t.type, t.imdb_id ?? null,
      hasTmdb ? t.tmdb_id! : null, hasTmdb ? t.tmdb_type! : null, hasTmdb ? 'pending' : 'no_tmdb_id', nowIso, nowIso);
  }
}

function pruneObservations(db: Db, nowIso: string) {
  const cutoff = new Date(Date.parse(nowIso) - OBSERVATION_KEEP_DAYS * 86_400_000).toISOString();
  run(db, `DELETE FROM sync_observations WHERE run_id IN (
             SELECT id FROM sync_runs WHERE started_at < ? AND status != 'held')`, [cutoff]);
}

/** Latest run for a provider; `slice` null = any slice. */
export function lastRun(db: Db, provider: number, region: string, slice: Slice | null, where: string) {
  return slice === null
    ? get<SyncRunRow>(db, `SELECT * FROM sync_runs WHERE provider_id = ? AND region = ? AND ${where} ORDER BY id DESC LIMIT 1`, [provider, region])
    : get<SyncRunRow>(db, `SELECT * FROM sync_runs WHERE provider_id = ? AND region = ? AND slice = ? AND ${where} ORDER BY id DESC LIMIT 1`, [provider, region, slice]);
}

function insertRun(db: Db, r: { provider: number; region: string; slice: Slice; source: 'watchmode' | 'tmdb'; trigger: Trigger; status: RunStatus; startedAt: string; finishedAt?: string; note?: string }) {
  const res = run(db, `INSERT INTO sync_runs (provider_id, region, slice, source, trigger, status, started_at, finished_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.provider, r.region, r.slice, r.source, r.trigger, r.status, r.startedAt, r.finishedAt ?? null, r.note ?? null]);
  return get<SyncRunRow>(db, 'SELECT * FROM sync_runs WHERE id = ?', [Number(res.lastInsertRowid)])!;
}

const RUN_COLUMNS = new Set(['status', 'applied', 'baseline', 'finished_at', 'confirmed_at', 'pages_total', 'pages_fetched', 'failed_pages',
  'titles_seen', 'previous_count', 'added', 'returned', 'back_on_service', 'missed', 'removed', 'quota', 'quota_used_before', 'quota_used_after', 'note']);

function updateRun(db: Db, id: number, fields: Partial<SyncRunRow>): SyncRunRow {
  const entries = Object.entries(fields).filter(([k, v]) => RUN_COLUMNS.has(k) && v !== undefined);
  if (entries.length) {
    run(db, `UPDATE sync_runs SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...entries.map(([, v]) => v as string | number | null), id]);
  }
  return get<SyncRunRow>(db, 'SELECT * FROM sync_runs WHERE id = ?', [id])!;
}

export function recentRuns(db: Db, limit = 20) {
  return all<SyncRunRow>(db, 'SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?', [limit]);
}

function describe(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
