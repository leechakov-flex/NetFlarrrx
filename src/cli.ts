// Command line for running jobs by hand, e.g. inside the container:
//   docker exec netflarrrx node dist/cli.js status
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { confirmHeldRun, recentRuns } from './sync/catalog.js';
import { setLogLevel } from './log.js';

const USAGE = `Usage: cli <command>
  status            catalog counts, health and the last 10 sync runs
  sync              run sync -> enrich -> Seerr mirror now (uses ~29 Watchmode credits)
  confirm <run-id>  apply a held sync run
  enrich            fetch TMDB details for titles that need them
  seerr-mirror      refresh the Seerr status mirror`;

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); return; }
  const cfg = loadConfig({ ...process.env, RUN_SCHEDULER: 'false' });
  setLogLevel(cfg.LOG_LEVEL);
  const app = createApp(cfg);
  try {
    switch (cmd) {
      case 'status': {
        const h = app.health();
        console.log(JSON.stringify({ status: h.status, reason: h.reason, last_applied_sync_at: h.last_applied_sync_at, stats: h.stats }, null, 2));
        console.table(recentRuns(app.db, 10).map((r) => ({
          id: r.id, status: r.status, started: r.started_at.slice(0, 16), titles: r.titles_seen, added: r.added,
          missed: r.missed, removed: r.removed, note: (r.note ?? '').slice(0, 60),
        })));
        break;
      }
      case 'sync': console.log(JSON.stringify(await app.pipeline('cli'), null, 2)); break;
      case 'confirm': {
        const id = Number(arg);
        if (!Number.isInteger(id)) throw new Error('confirm needs a run id');
        console.log(JSON.stringify(confirmHeldRun(app.db, cfg, id), null, 2));
        await app.enrich();
        break;
      }
      case 'enrich': console.log(JSON.stringify(await app.enrich(), null, 2)); break;
      case 'seerr-mirror': console.log(JSON.stringify(await app.mirror(), null, 2)); break;
      default: console.error(`Unknown command: ${cmd}\n${USAGE}`); process.exitCode = 2;
    }
  } finally {
    app.close();
  }
}

main().catch((err) => { console.error((err as Error).message); process.exit(1); });
