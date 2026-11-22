import type { Config } from './config.js';
import { get, getJobState, openDb, type Db } from './db/db.js';
import type { FetchFn } from './clients/http.js';
import { WatchmodeClient } from './clients/watchmode.js';
import { TmdbClient } from './clients/tmdb.js';
import { SeerrClient } from './clients/seerr.js';
import { recentRuns, type SyncRunRow, type Trigger } from './sync/catalog.js';
import { syncServices, type ServicesResult } from './sync/services.js';
import { enrichTitles, type EnrichResult } from './enrich/tmdb.js';
import { mirrorSeerrMedia, type MirrorResult } from './seerr/mirror.js';
import { catalogStats, resolveUpcomingServices } from './catalog/rules.js';
import { log } from './log.js';
import { backupDir, lastBackup, runBackup, type BackupState } from './ops/backup.js';
import { lastCrossCheck, runCrossCheck, type CrossCheckState } from './ops/crosscheck.js';
import { Notifier, reconcileAlerts, type Problem } from './ops/alerts.js';
import { refreshLibrary, libraryCount, type LibraryResult } from './recs/library.js';
import { ArrClient } from './clients/arr.js';
import { QbitClient } from './clients/qbittorrent.js';
import { HomeService } from './catalog/homeService.js';
import { JellyfinClient } from './clients/jellyfin.js';
import { syncJellyfin, type JellyfinSync } from './library/jellyfin.js';
import { downloadsSnapshot, lastDownloads, watchDownloads, type DownloadDeps } from './downloads/downloads.js';
import type { DownloadsResponse } from './api/types.js';

export interface AppFetchers { watchmode?: FetchFn; tmdb?: FetchFn; seerr?: FetchFn; alerts?: FetchFn; radarr?: FetchFn; sonarr?: FetchFn; qbit?: FetchFn; jellyfin?: FetchFn }

export interface App {
  cfg: Config;
  db: Db;
  startedAt: Date;
  watchmode: WatchmodeClient;
  tmdb: TmdbClient;
  seerr: SeerrClient;
  /** Sync, then enrich, then refresh the Seerr mirror. Never runs twice at once. */
  /** `sync` is Netflix's movies run, the one health watches; `services` has every run. */
  pipeline(trigger: Trigger, opts?: { forceSeries?: boolean }): Promise<{ sync: SyncRunRow; services: ServicesResult; enrich: EnrichResult; mirror: MirrorResult } | { busy: true }>;
  enrich(): Promise<EnrichResult>;
  mirror(): Promise<MirrorResult>;
  backup(): Promise<BackupState>;
  /** Library from Seerr plus TMDB recommendations, for "Recommended for you". */
  library(): Promise<LibraryResult>;
  crosscheck(): Promise<CrossCheckState>;
  /** The Downloads page: qBittorrent + Radarr/Sonarr queues + Seerr requests (cached a few seconds). */
  downloads(now?: Date): Promise<DownloadsResponse>;
  /** Every few minutes: note what's stuck and alert on downloads stuck for STALL_ALERT_HOURS. */
  watchDownloads(now?: Date): Promise<void>;
  /** Jellyfin, when JELLYFIN_API_KEY is set: the Library page. */
  jellyfin?: JellyfinClient;
  syncJellyfin(): Promise<JellyfinSync | null>;
  /** Work out what needs attention and alert on changes (ntfy or Discord). */
  checkAlerts(now?: Date): Promise<{ open: string[]; sent: string[] }>;
  problems(now?: Date): Problem[];
  notifier: Notifier;
  health(now?: Date): Health;
  close(): void;
  /** Discover, built off the main thread and cached (see homeService). */
  homes: HomeService;
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
  backup: { last_ok_at: string | null; last_error: string | null } | null;
  crosscheck: { at: string; ok: boolean; coverage_pct: number | null; agreement_pct: number | null } | null;
}

const HEALTHY_SYNC_AGE_MS = 36 * 3600_000;
const STARTUP_GRACE_MS = 3 * 3600_000;

export function createApp(cfg: Config, fetchers: AppFetchers = {}): App {
  const db = openDb(cfg.DATA_DIR);
  const watchmode = new WatchmodeClient(cfg.WATCHMODE_BASE, cfg.WATCHMODE_API_KEY, fetchers.watchmode, cfg.WATCHMODE_MIN_INTERVAL_MS);
  const tmdb = new TmdbClient(cfg.TMDB_BASE, cfg.TMDB_READ_TOKEN, fetchers.tmdb);
  const seerr = new SeerrClient(cfg.SEERR_URL, cfg.SEERR_API_KEY, fetchers.seerr, cfg.SEERR_USER_ID);
  const radarr = cfg.RADARR_API_KEY ? new ArrClient(cfg.RADARR_URL, cfg.RADARR_API_KEY, fetchers.radarr, 'radarr') : undefined;
  const sonarr = cfg.SONARR_API_KEY ? new ArrClient(cfg.SONARR_URL, cfg.SONARR_API_KEY, fetchers.sonarr, 'sonarr') : undefined;
  const qbit = cfg.QBIT_PASSWORD ? new QbitClient(cfg.QBIT_URL, cfg.QBIT_USERNAME ?? 'admin', cfg.QBIT_PASSWORD, fetchers.qbit) : undefined;
  const dl: DownloadDeps = { db, cfg, qbit, radarr, sonarr, seerr, tmdb };
  const jellyfin = cfg.JELLYFIN_API_KEY ? new JellyfinClient(cfg.JELLYFIN_URL, cfg.JELLYFIN_API_KEY, fetchers.jellyfin) : undefined;
  const startedAt = new Date();
  const notifier = new Notifier(cfg, fetchers.alerts);
  let running = false;
  const safely = (what: string, p: Promise<unknown>) => p.catch((err) => log.error(`${what} failed`, { error: String(err) }));

  const homes = new HomeService(db, cfg);
  const app: App = {
    cfg, db, startedAt, watchmode, tmdb, seerr, homes,

    async pipeline(trigger, opts = {}) {
      if (running) return { busy: true };
      running = true;
      try {
        const services = await syncServices({ db, cfg, watchmode, tmdb }, trigger, opts);
        const sync = services.runs.find((r) => r.provider_id === cfg.NETFLIX_SOURCE_ID && r.slice === 'movies') ?? services.runs[0]!;
        const enrich = await enrichTitles(db, cfg, tmdb);   // also catches up on titles a failed run left pending
        resolveUpcomingServices(db, cfg);
        const mirror = await mirrorSeerrMedia(db, seerr);
        await safely('library', app.library());
        await safely('alerts', app.checkAlerts());
        homes.invalidate(); void homes.warm();
        return { sync, services, enrich, mirror };
      } catch (err) {
        log.error('pipeline: unexpected error', { error: (err as Error).stack ?? String(err) });
        throw err;
      } finally {
        running = false;
      }
    },

    enrich: async () => { const r = await enrichTitles(db, cfg, tmdb); resolveUpcomingServices(db, cfg); homes.invalidate(); return r; },
    mirror: async () => { const r = await mirrorSeerrMedia(db, seerr); homes.invalidate(); return r; },

    library: async () => { const r = await refreshLibrary(db, cfg, tmdb, { radarr, sonarr }); homes.invalidate(); return r; },

    downloads: (now = new Date()) => downloadsSnapshot(dl, now),
    jellyfin,
    syncJellyfin: async () => (jellyfin ? syncJellyfin(db, jellyfin) : null),
    async watchDownloads(now = new Date()) {
      await watchDownloads(dl, now);
      await safely('alerts', app.checkAlerts(now));
    },

    async backup() {
      const r = runBackup(db, cfg);
      await safely('alerts', app.checkAlerts());
      return r;
    },

    async crosscheck() {
      const r = await runCrossCheck(db, cfg, tmdb);
      await safely('alerts', app.checkAlerts());
      return r;
    },

    notifier,
    problems(now = new Date()) {
      const out: Problem[] = [];
      const h = app.health(now);
      const help = 'Details: docker exec monkeysee node dist/cli.js status';
      if (h.status === 'held') out.push({ key: 'sync:held', title: 'Sync held', message: `${h.reason}\n${help}` });
      if (h.status === 'failing') out.push({ key: 'sync:failing', title: 'Sync failing', message: `${h.reason}\n${help}` });
      if (h.status === 'stale') out.push({ key: 'sync:stale', title: 'Sync overdue', message: `${h.reason}\n${help}` });

      if (backupDir(cfg)) {
        const b = lastBackup(db);
        const lastOk = b?.lastOkAt ? Date.parse(b.lastOkAt) : null;
        if (b && !b.ok) out.push({ key: 'backup:failed', title: 'Backup failed', message: `${b.error}\nThe last good backup is ${b.lastOkAt ? `from ${b.lastOkAt.slice(0, 10)}` : 'missing'}.` });
        else if (lastOk === null ? now.getTime() - startedAt.getTime() > 48 * 3600_000 : now.getTime() - lastOk > 48 * 3600_000) {
          out.push({ key: 'backup:stale', title: 'No backup in 2 days', message: 'The nightly backup has not run. Check the container is up and the backup folder is writable.' });
        }
      }

      const x = lastCrossCheck(db);
      if (x && !x.ok) out.push({ key: 'crosscheck:failed', title: 'TMDB cross-check failed', message: x.error ?? 'unknown error' });
      if (x?.ok && x.coveragePct !== undefined) {
        if (x.coveragePct < cfg.CROSSCHECK_MIN_PCT) {
          out.push({ key: 'crosscheck:low', title: 'Netflix list looks incomplete',
            message: `Only ${x.coveragePct}% of the ${x.tmdbTotal} titles TMDB lists on Netflix are in MonkeySee (alert below ${cfg.CROSSCHECK_MIN_PCT}%). Watchmode's list may be stale.\nDetails: docker exec monkeysee node dist/cli.js crosscheck` });
        }
        if (x.agreementPct !== undefined && x.agreementPct < cfg.CROSSCHECK_MIN_AGREE_PCT) {
          out.push({ key: 'crosscheck:stale', title: 'Netflix list may include titles that left',
            message: `Only ${x.agreementPct}% of the ${x.oursTotal} titles MonkeySee lists are on TMDB's Netflix list (alert below ${cfg.CROSSCHECK_MIN_AGREE_PCT}%). Watchmode may be listing titles Netflix removed.\nDetails: docker exec monkeysee node dist/cli.js crosscheck` });
        }
        if (x.coveragePct >= cfg.CROSSCHECK_MIN_PCT && x.previousCoveragePct != null && x.previousCoveragePct - x.coveragePct > cfg.CROSSCHECK_MAX_DROP) {
          out.push({ key: 'crosscheck:drop', title: 'Netflix list changed sharply',
            message: `Match with TMDB fell from ${x.previousCoveragePct}% to ${x.coveragePct}% since last week.\nDetails: docker exec monkeysee node dist/cli.js crosscheck` });
        }
      }

      // Downloads stuck long enough to be worth a push (the page shows them sooner).
      const d = lastDownloads(db);
      if (d && Date.parse(d.at) > now.getTime() - 30 * 60_000) {
        for (const a of d.attention) {
          const since = a.since ? Date.parse(a.since) : null;
          if (since !== null && now.getTime() - since < cfg.STALL_ALERT_HOURS * 3600_000) continue;
          if (since === null && !a.message) continue;
          const what = a.state === 'stalled' ? 'stalled' : a.state === 'metadata' ? 'stuck finding peers' : 'failed';
          const hours = since !== null ? Math.round((now.getTime() - since) / 3600_000) : null;
          out.push({ key: `download:${a.key}`, title: `Download ${what}: ${a.title}`,
            message: `${a.message ?? (hours !== null ? `No progress for ${hours} hours.` : 'Radarr or Sonarr flagged it.')}${cfg.APP_URL ? `\n${cfg.APP_URL}/downloads` : ''}` });
        }
      }
      return out;
    },

    checkAlerts: (now = new Date()) => reconcileAlerts(db, notifier, app.problems(now), now),

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
        backup: backupDir(cfg) ? (() => { const b = lastBackup(db); return { last_ok_at: b?.lastOkAt ?? null, last_error: b && !b.ok ? b.error ?? null : null }; })() : null,
        crosscheck: (() => { const x = lastCrossCheck(db); return x ? { at: x.at, ok: x.ok, coverage_pct: x.coveragePct ?? null, agreement_pct: x.agreementPct ?? null } : null; })(),
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

    close() { homes.close(); db.close(); },
  };
  return app;
}

/** On boot: refresh the Seerr mirror, and run the pipeline if no sync ran in the last day. */
export async function startupTasks(app: App) {
  await app.mirror().catch(() => undefined);
  void app.homes.warm();   // so the first look at Discover after a restart doesn't wait
  const recent = get<{ id: number }>(app.db,
    `SELECT id FROM sync_runs WHERE status IN ('complete', 'partial', 'held') AND started_at > ? LIMIT 1`,
    [new Date(Date.now() - 24 * 3600_000).toISOString()]);
  if (!recent) {
    log.info('startup: no sync in the last 24 hours; running now');
    await app.pipeline('schedule');
  } else if (get<{ n: number }>(app.db, `SELECT count(*) n FROM titles WHERE tmdb_status = 'pending'`)!.n > 0) {
    await app.enrich();
  }
  // M5 jobs on first start after an update, instead of waiting for their schedule.
  const b = lastBackup(app.db);
  if (backupDir(app.cfg) && (!b?.lastOkAt || Date.now() - Date.parse(b.lastOkAt) > 24 * 3600_000)) await app.backup();
  if (!lastCrossCheck(app.db)) await app.crosscheck();
  if (libraryCount(app.db) === 0) await app.library().catch(() => undefined);
  if (app.cfg.QBIT_PASSWORD) await app.watchDownloads().catch(() => undefined);
  await app.syncJellyfin().catch(() => undefined);
  await app.checkAlerts().catch(() => undefined);
}
