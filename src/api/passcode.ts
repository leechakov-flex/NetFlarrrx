import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { log } from '../log.js';

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

function clientKey(c: Context): string {
  try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
}

/**
 * Guards write actions with APP_PASSCODE (header `x-passcode`). Open when no
 * passcode is set. After 10 wrong tries from one address in 15 minutes, that
 * address gets 429 until the window passes.
 */
export function passcodeGuard(getExpected: () => string | undefined, now: () => number = Date.now) {
  const failures = new Map<string, number[]>();

  return async function requirePasscode(c: Context, next: Next) {
    const expected = getExpected();
    if (!expected) return next();
    const key = clientKey(c);
    const t = now();
    const recent = (failures.get(key) ?? []).filter((at) => t - at < WINDOW_MS);
    if (recent.length >= MAX_FAILURES) {
      failures.set(key, recent);
      return c.json({ error: 'Too many wrong passcodes. Try again in 15 minutes.', code: 'rate_limited' }, 429);
    }
    const a = Buffer.from(c.req.header('x-passcode') ?? '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      recent.push(t);
      failures.set(key, recent);
      if (recent.length === MAX_FAILURES) log.warn('passcode: too many failures; pausing', { client: key });
      return c.json({ error: 'Passcode required.', code: 'passcode' }, 401);
    }
    failures.delete(key);
    return next();
  };
}
