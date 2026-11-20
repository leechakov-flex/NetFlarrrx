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
  ];
  for (const j of jobs) log.info('scheduler: job registered', { job: j.name, next: j.nextRun()?.toISOString() ?? null });
  return { stop: () => jobs.forEach((j) => j.stop()) };
}
