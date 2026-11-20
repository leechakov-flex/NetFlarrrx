import type { Config } from './config.js';
import { get, getJobState, openDb, type Db } from './db/db.js';
import type { FetchFn } from './clients/http.js';
import { WatchmodeClient } from './clients/watchmode.js';
import { TmdbClient } from './clients/tmdb.js';
import { SeerrClient } from './clients/seerr.js';
import { runCatalogSync, recentRuns, type SyncRunRow, type Trigger } from './sync/catalog.js';
import { enrichTitles, type EnrichResult } from './enrich/tmdb.js';
import { mirrorSeerrMedia, type MirrorResult } from './seerr/mirror.js';
import { catalogStats } from './catalog/rules.js';
import { log } from './log.js';

export interface AppFetchers { watchmode?: FetchFn; tmdb?: FetchFn; seerr?: FetchFn }

export interface App {
  cfg: Config;
  db: Db;
  startedAt: Date;
  watchmode: WatchmodeClient;
  tmdb: TmdbClient;
  seerr: SeerrClient;
  /** Sync, then enrich, then refresh the Seerr mirror. Never runs twice at once. */
  pipeline(trigger: Trigger): Promise<{ sync: SyncRunRow; enrich: EnrichResult; mirror: MirrorResult } | { busy: true }>;
  enrich(): Promise<EnrichResult>;
  mirror(): Promise<MirrorResult>;
  health(now?: Date): Health;
  close(): void;
}

export interface Health {
  ok: boolean;
  status: 'ok' | 'starting' | 'stale' | 'held' | 'failing';
  reason?: string;
  last_applied_sync_at: string | null;
  last_run: Pick<SyncRunRow, 'id' | 'status' | 'started_at' | 'note'> | null;
  seerr_mirror: unknown;
  stats: ReturnType<typeof catalogStats>;
  pipeline_running: boolean;
}

const HEALTHY_SYNC_AGE_MS = 36 * 3600_000;
const STARTUP_GRACE_MS = 3 * 3600_000;

export function createApp(cfg: Config, fetchers: AppFetchers = {}): App {
  const db = openDb(cfg.DATA_DIR);
  const watchmode = new WatchmodeClient(cfg.WATCHMODE_BASE, cfg.WATCHMODE_API_KEY, fetchers.watchmode, cfg.WATCHMODE_MIN_INTERVAL_MS);
  const tmdb = new TmdbClient(cfg.TMDB_BASE, cfg.TMDB_READ_TOKEN, fetchers.tmdb);
  const seerr = new SeerrClient(cfg.SEERR_URL, cfg.SEERR_API_KEY, fetchers.seerr, cfg.SEERR_USER_ID);
  const startedAt = new Date();
  let running = false;

  const app: App = {
    cfg, db, startedAt, watchmode, tmdb, seerr,

    async pipeline(trigger) {
      if (running) return { busy: true };
      running = true;
      try {
        const sync = await runCatalogSync({ db, cfg, watchmode }, trigger);
        const enrich = await enrichTitles(db, cfg, tmdb);   // also catches up on titles a failed run left pending
        const mirror = await mirrorSeerrMedia(db, seerr);
        return { sync, enrich, mirror };
      } catch (err) {
        log.error('pipeline: unexpected error', { error: (err as Error).stack ?? String(err) });
        throw err;
      } finally {
        running = false;
      }
    },

    enrich: () => enrichTitles(db, cfg, tmdb),
    mirror: () => mirrorSeerrMedia(db, seerr),

    health(now = new Date()) {
      const lastApplied = get<{ started_at: string }>(db,
        'SELECT started_at FROM sync_runs WHERE provider_id = ? AND region = ? AND applied = 1 ORDER BY id DESC LIMIT 1',
        [cfg.NETFLIX_SOURCE_ID, cfg.REGION]);
      const last = recentRuns(db, 5).find((r) => r.status !== 'skipped') ?? null;
      const base = {
        last_applied_sync_at: lastApplied?.started_at ?? null,
        last_run: last && { id: last.id, status: last.status, started_at: last.started_at, note: last.note },
        seerr_mirror: getJobState(db, 'seerr_mirror')?.value ?? null,
        stats: catalogStats(db, cfg),
        pipeline_running: running,
      };
      if (last?.status === 'held') {
        return { ...base, ok: false, status: 'held', reason: `sync run ${last.id} held: ${last.note}. Confirm it or wait for the next run.` };
      }
      if (lastApplied && now.getTime() - Date.parse(lastApplied.started_at) <= HEALTHY_SYNC_AGE_MS) {
        return { ...base, ok: true, status: 'ok' };
      }
      if (!lastApplied && now.getTime() - startedAt.getTime() <= STARTUP_GRACE_MS) {
        return { ...base, ok: true, status: 'starting', reason: 'no sync applied yet; baseline pending' };
      }
      if (last && ['failed', 'partial'].includes(last.status)) {
        return { ...base, ok: false, status: 'failing', reason: `last sync ${last.status}: ${last.note ?? 'no detail'}` };
      }
      return { ...base, ok: false, status: 'stale', reason: lastApplied ? 'no applied sync in 36 hours' : 'no sync has ever been applied' };
    },

    close() { db.close(); },
  };
  return app;
}

/** On boot: refresh the Seerr mirror, and run the pipeline if no sync ran in the last day. */
export async function startupTasks(app: App) {
  await app.mirror().catch(() => undefined);
  const recent = get<{ id: number }>(app.db,
    `SELECT id FROM sync_runs WHERE status IN ('complete', 'partial', 'held') AND started_at > ? LIMIT 1`,
    [new Date(Date.now() - 24 * 3600_000).toISOString()]);
  if (!recent) {
    log.info('startup: no sync in the last 24 hours; running now');
    await app.pipeline('schedule');
  } else if (get<{ n: number }>(app.db, `SELECT count(*) n FROM titles WHERE tmdb_status = 'pending'`)!.n > 0) {
    await app.enrich();
  }
}
