// Minimal structured logger: one JSON line per event, readable with `docker logs`.
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = (process.env.LOG_LEVEL as Level) || 'info';
let silent = process.env.VITEST === 'true';

export function setLogLevel(level: Level) { threshold = level; }
export function setSilent(value: boolean) { silent = value; }

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (silent || order[level] < order[threshold]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};
