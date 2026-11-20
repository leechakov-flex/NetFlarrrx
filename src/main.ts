import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp, startupTasks } from './app.js';
import { createServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { log, setLogLevel } from './log.js';

const cfg = loadConfig();
setLogLevel(cfg.LOG_LEVEL);
const app = createApp(cfg);
const http = createServer(app);

const server = serve({ fetch: http.fetch, port: cfg.PORT, hostname: '0.0.0.0' }, (info) => {
  log.info('server: listening', { port: info.port, languageRule: cfg.LANGUAGE_RULE, seerr: cfg.SEERR_URL });
});
if (!cfg.APP_PASSCODE) log.warn('APP_PASSCODE is not set: admin actions are open to anyone on the network');

const scheduler = cfg.RUN_SCHEDULER ? startScheduler(app) : null;
if (cfg.RUN_SCHEDULER) void startupTasks(app).catch((err) => log.error('startup tasks failed', { error: String(err) }));

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('shutdown', { signal });
  scheduler?.stop();
  server.close(() => { app.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
