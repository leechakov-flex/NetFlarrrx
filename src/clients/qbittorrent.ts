import { z } from 'zod';
import { HttpError, type FetchFn } from './http.js';

/**
 * Read-only qBittorrent Web API (v2): torrents and transfer totals. Logs in with
 * the username and password once and reuses the session cookie; logs in again
 * when qBittorrent forgets it (403). Nothing here changes a torrent.
 */
const Torrent = z.object({
  hash: z.string(),
  name: z.string(),
  state: z.string(),                       // downloading, stalledDL, metaDL, queuedDL, uploading, pausedDL, error, missingFiles, ...
  progress: z.number(),                    // 0..1
  dlspeed: z.number().optional().default(0),
  upspeed: z.number().optional().default(0),
  eta: z.number().optional().default(8640000),   // seconds; 8640000 = unknown
  size: z.number().optional().default(0),
  num_seeds: z.number().optional().default(0),
  num_leechs: z.number().optional().default(0),
  num_complete: z.number().optional().default(0),
  num_incomplete: z.number().optional().default(0),
  added_on: z.number().optional().default(0),
  category: z.string().optional().default(''),
}).passthrough();
export type QbitTorrent = z.infer<typeof Torrent>;

const Transfer = z.object({
  dl_info_speed: z.number().optional().default(0),
  up_info_speed: z.number().optional().default(0),
  connection_status: z.string().optional().default('unknown'),   // connected, firewalled, disconnected
}).passthrough();
export type QbitTransfer = z.infer<typeof Transfer>;

export class QbitClient {
  private cookie: string | null = null;
  private loggingIn: Promise<void> | null = null;   // one login at a time; parallel calls share it
  // qBittorrent bans an address for an hour after 5 failed logins, so after a refusal
  // don't try again for a while. Restarting the container (or the CLI) tries at once.
  private refused: { until: number; reason: string } | null = null;
  // Headers that passed qBittorrent's cross-site check at login, reused for every call.
  private extra: Record<string, string> = {};
  constructor(private base: string, private username: string, private password: string, private fetchFn: FetchFn = fetch, private backoffMs = 30 * 60_000) {}
  private url(p: string) { return `${this.base.replace(/\/$/, '')}${p}`; }

  /** Why the last login failed, in plain words (or null). */
  get loginProblem() { return this.refused?.reason ?? null; }

  private async login() {
    if (this.refused && Date.now() < this.refused.until) {
      throw new HttpError('qbittorrent', 401, this.url('/api/v2/auth/login'), this.refused.reason);
    }
    const body = new URLSearchParams({ username: this.username, password: this.password }).toString();
    // Plain first; some setups' cross-site check only passes with Referer/Origin set to its address.
    for (const extra of [{}, { Referer: this.base, Origin: this.base }] as Record<string, string>[]) {
      const res = await this.fetchFn(this.url('/api/v2/auth/login'), {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extra }, body, signal: AbortSignal.timeout(10_000),
      });
      const text = (await res.text()).trim();
      const sid = res.headers.get('set-cookie')?.match(/SID=[^;]+/)?.[0];
      if (res.ok && text === 'Ok.' && sid) {
        this.cookie = sid; this.extra = extra; this.refused = null;
        return;
      }
      if (res.status === 401 && Object.keys(extra).length === 0) continue;   // try with Referer/Origin
      const reason = res.ok && text === 'Fails.' ? 'qBittorrent says the username or password is wrong (check QBIT_USERNAME and QBIT_PASSWORD)'
        : res.status === 403 ? 'qBittorrent has blocked MonkeySee for too many failed logins (it lifts after an hour by default)'
        : res.status === 401 ? 'qBittorrent refused the login (its cross-site or host check)'
        : res.ok ? `qBittorrent answered the login with “${text.slice(0, 40)}”` : `qBittorrent login failed (HTTP ${res.status})`;
      this.refused = { until: Date.now() + this.backoffMs, reason };
      throw new HttpError('qbittorrent', res.ok ? 401 : res.status, this.url('/api/v2/auth/login'), reason);
    }
  }

  private async get(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.cookie) {
        this.loggingIn ??= this.login().finally(() => { this.loggingIn = null; });
        await this.loggingIn;
      }
      const res = await this.fetchFn(this.url(path), { headers: { Cookie: this.cookie!, ...this.extra }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 403 && attempt === 0) { this.cookie = null; continue; }
      if (!res.ok) throw new HttpError('qbittorrent', res.status, this.url(path), await res.text().catch(() => ''));
      return res.json();
    }
    throw new HttpError('qbittorrent', 403, this.url(path), 'login rejected');
  }

  async torrents(): Promise<QbitTorrent[]> {
    return z.array(z.unknown()).parse(await this.get('/api/v2/torrents/info'))
      .flatMap((r) => { const t = Torrent.safeParse(r); return t.success ? [t.data] : []; });
  }

  async transfer(): Promise<QbitTransfer> {
    return Transfer.parse(await this.get('/api/v2/transfer/info'));
  }
}
