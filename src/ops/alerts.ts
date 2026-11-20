import type { Config } from '../config.js';
import { getJobState, setJobState, type Db } from '../db/db.js';
import { requestJson, type FetchFn } from '../clients/http.js';
import { log } from '../log.js';

/** Something that needs attention. `key` identifies it so it alerts once, not every check. */
export interface Problem { key: string; title: string; message: string }

interface AlertState { open: Record<string, { title: string; since: string; remindedAt: string }> }

const REMIND_AFTER_MS = 24 * 3600_000;

/**
 * Sends to ntfy (any URL that isn't Discord: POST text, Title/Priority/Tags headers)
 * or a Discord webhook. Without ALERT_URL, alerts are logged only.
 */
export class Notifier {
  constructor(private cfg: Config, private fetchFn: FetchFn = fetch) {}

  get enabled() { return Boolean(this.cfg.ALERT_URL); }

  async send(title: string, message: string, kind: 'problem' | 'resolved' | 'test'): Promise<void> {
    const url = this.cfg.ALERT_URL;
    log.info('alert', { kind, title, message, sent: Boolean(url) });
    if (!url) return;
    const link = this.cfg.APP_URL;
    if (/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url)) {
      const icon = kind === 'problem' ? '⚠️' : kind === 'resolved' ? '✅' : '🔔';
      await requestJson(this.fetchFn, 'alerts', url, {
        method: 'POST', retries: 2, body: { content: `${icon} **${title}**\n${message}${link ? `\n${link}` : ''}`.slice(0, 1900) },
      });
      return;
    }
    // ntfy: headers must be plain ASCII.
    const ascii = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, '');
    const headers: Record<string, string> = {
      Title: ascii(`NetFlarrrx: ${title}`),
      Priority: kind === 'problem' ? 'high' : 'default',
      Tags: kind === 'problem' ? 'warning' : kind === 'resolved' ? 'white_check_mark' : 'bell',
      'Content-Type': 'text/plain; charset=utf-8',
      ...(link ? { Click: link } : {}),
      ...(this.cfg.ALERT_TOKEN ? { Authorization: `Bearer ${this.cfg.ALERT_TOKEN}` } : {}),
    };
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchFn(url, { method: 'POST', headers, body: message, signal: AbortSignal.timeout(15_000) });
        if (res.ok) return;
        lastErr = new Error(`alerts HTTP ${res.status}`);
        if (res.status < 500 && res.status !== 429) break;
      } catch (err) { lastErr = err; }
      await new Promise((r) => setTimeout(r, process.env.VITEST === 'true' ? 1 : 2000 * (attempt + 1)));
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

/**
 * Compares the current problems with the open ones: a new problem alerts,
 * one still open after 24 hours gets a reminder, one that cleared sends "resolved".
 * Sending failures are logged and retried at the next check.
 */
export async function reconcileAlerts(db: Db, notifier: Notifier, problems: Problem[], now = new Date()) {
  const state = getJobState<AlertState>(db, 'alerts')?.value ?? { open: {} };
  const open = { ...state.open };
  const iso = now.toISOString();
  const sent: string[] = [];

  for (const p of problems) {
    const prev = open[p.key];
    const due = !prev || now.getTime() - Date.parse(prev.remindedAt) >= REMIND_AFTER_MS;
    if (!due) continue;
    try {
      await notifier.send(prev ? `Still: ${p.title}` : p.title, p.message, 'problem');
      open[p.key] = { title: p.title, since: prev?.since ?? iso, remindedAt: iso };
      sent.push(p.key);
    } catch (err) {
      log.warn('alert: send failed', { key: p.key, error: (err as Error).message });
    }
  }
  const current = new Set(problems.map((p) => p.key));
  for (const [key, o] of Object.entries(open)) {
    if (current.has(key)) continue;
    try {
      await notifier.send(`Resolved: ${o.title}`, `This is back to normal (it started ${new Date(o.since).toUTCString()}).`, 'resolved');
      delete open[key];
      sent.push(`resolved:${key}`);
    } catch (err) {
      log.warn('alert: send failed', { key, error: (err as Error).message });
    }
  }
  setJobState(db, 'alerts', { open } satisfies AlertState, iso);
  return { open: Object.keys(open), sent };
}
