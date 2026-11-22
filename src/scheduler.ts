import { Cron } from 'croner';
import type { App } from './app.js';
import { log } from './log.js';

export function startScheduler(app: App) {
  const { cfg } = app;
  const jobs = [
    new Cron(cfg.SYNC_CRON, { timezone: cfg.TZ, protect: true, name: 'catalog-sync' }, async () => {
      await app.pipeline('schedule').catch(() => undefined);
    }),
    new Cron(cfg.SEERR_MIRROR_CRON, { timezone: cfg.TZ, protect: true, name: 'seerr-mirror' }, async () => {
      await app.mirror().catch(() => undefined);
    }),
    new Cron(cfg.BACKUP_CRON, { timezone: cfg.TZ, protect: true, name: 'backup' }, async () => {
      await app.backup().catch(() => undefined);
    }),
    new Cron(cfg.CROSSCHECK_CRON, { timezone: cfg.TZ, protect: true, name: 'tmdb-crosscheck' }, async () => {
      await app.crosscheck().catch(() => undefined);
    }),
    new Cron(cfg.DOWNLOADS_CRON, { timezone: cfg.TZ, protect: true, name: 'downloads-watch' }, async () => {
      await app.watchDownloads().catch(() => undefined);
    }),
    new Cron(cfg.JELLYFIN_CRON, { timezone: cfg.TZ, protect: true, name: 'jellyfin' }, async () => {
      await app.syncJellyfin().catch(() => undefined);
    }),
    new Cron(cfg.NOT_FOUND_RETRY_CRON, { timezone: cfg.TZ, protect: true, name: 'not-found-retry' }, async () => {
      await app.retryNotFound().catch(() => undefined);
    }),
    // Catches what no job reports, like a sync that never ran.
    new Cron(cfg.ALERT_CHECK_CRON, { timezone: cfg.TZ, protect: true, name: 'alert-check' }, async () => {
      await app.checkAlerts().catch(() => undefined);
    }),
  ];
  for (const j of jobs) log.info('scheduler: job registered', { job: j.name, next: j.nextRun()?.toISOString() ?? null });
  return { stop: () => jobs.forEach((j) => j.stop()) };
}
