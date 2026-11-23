// "Why is this Not found?" and how to unstick it: an interactive search through Radarr
// or Sonarr (grabs nothing), a summary of why each result would be skipped, grabbing a
// result you pick, and a daily retry for titles stuck in Not found.
import type { Config } from '../config.js';
import { all, get, run, type Db } from '../db/db.js';
import type { ArrClient, Release } from '../clients/arr.js';
import type { ReleaseCheck, ReleasesResponse, RequestItem } from '../api/types.js';
import { downloadsSnapshot, resetDownloadsCache, type DownloadDeps } from './downloads.js';
import { log } from '../log.js';

/** Radarr/Sonarr's reasons, in a few plain words, grouped. */
export function reasonLabel(raw: string): string {
  const r = raw.toLowerCase();
  if (/not wanted in profile|quality.*(not wanted|cutoff)|wanted quality/.test(r)) return 'Quality isn’t in your profile';
  if (/custom format|score/.test(r)) return 'Custom format score too low';
  if (/size|maximum|minimum|too (large|small)/.test(r)) return 'Size outside your limits';
  if (/language/.test(r)) return 'Wrong language';
  if (/seed/.test(r)) return 'Too few seeders';
  if (/sample/.test(r)) return 'Sample file';
  if (/blocklist|blacklist/.test(r)) return 'Blocklisted';
  if (/delay/.test(r)) return 'Waiting out a delay profile';
  if (/not.*available|availability|not.*released|before/.test(r)) return 'Radarr doesn’t count it as out yet';
  if (/upgrade|existing file/.test(r)) return 'Not better than what you have';
  if (/unknown (movie|series)|unable to (parse|identify)|wrong (movie|series|year)/.test(r)) return 'Doesn’t match this title';
  return raw.length > 60 ? `${raw.slice(0, 57)}…` : raw;
}

const res = (r: Release) => (r.resolution ? `${r.resolution}p` : r.quality);

export function summarize(releases: Release[], arr: 'Radarr' | 'Sonarr', now = new Date()): ReleaseCheck {
  const accepted = releases.filter((r) => !r.rejected);
  const reasons = new Map<string, number>();
  for (const r of releases.filter((x) => x.rejected)) {
    for (const label of new Set(r.rejections.map(reasonLabel))) reasons.set(label, (reasons.get(label) ?? 0) + 1);
  }
  const qualities = new Map<string, number>();
  for (const r of releases) qualities.set(res(r), (qualities.get(res(r)) ?? 0) + 1);
  const topReasons = [...reasons].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));
  const topQualities = [...qualities].sort((a, b) => b[1] - a[1]).map(([quality, count]) => ({ quality, count }));
  const n = releases.length;
  let headline: string;
  if (!n) headline = 'No releases on your indexers yet';
  else if (accepted.length) headline = `${accepted.length} release${accepted.length === 1 ? '' : 's'} ${arr} would take`;
  else {
    const top = topReasons[0];
    const q = topQualities.length === 1 ? ` (all ${topQualities[0]!.quality})` : '';
    headline = `${n} found${q}, none wanted: ${top ? top.reason.toLowerCase() : 'all rejected'}`;
  }
  return { at: now.toISOString(), total: n, accepted: accepted.length, headline, reasons: topReasons.slice(0, 5), qualities: topQualities.slice(0, 5) };
}

/** Which Radarr/Sonarr title (and season) a request is for. */
async function target(d: DownloadDeps, r: RequestItem): Promise<{ client: ArrClient; arr: 'Radarr' | 'Sonarr'; id: number; season?: number } | null> {
  const client = r.tmdbType === 'movie' ? d.radarr : d.sonarr;
  if (!client) return null;
  const id = await client.findId(r.tmdbId);
  if (id == null) return null;
  if (r.tmdbType === 'movie') return { client, arr: 'Radarr', id };
  // A series: the first requested season it hasn't got (the snapshot knows), else the first requested.
  const season = r.missingSeasons?.[0] ?? r.seasons[0];
  return { client, arr: 'Sonarr', id, season };
}

const inflight = new Map<number, Promise<ReleasesResponse>>();

/** Run (or reuse, within 30 minutes) an interactive search for a request. */
export async function requestReleases(d: DownloadDeps, requestId: number, opts: { fresh?: boolean; now?: Date } = {}): Promise<ReleasesResponse> {
  const now = opts.now ?? new Date();
  const snap = await downloadsSnapshot(d, now);
  const r = snap.requests.find((x) => x.id === requestId);
  if (!r) throw Object.assign(new Error('Seerr doesn’t have that request any more.'), { status: 404 });
  const cached = cachedReleases.get(requestId);
  if (!opts.fresh && cached && now.getTime() - Date.parse(cached.check.at) < 30 * 60_000) return cached;
  let p = inflight.get(requestId);
  if (!p) {
    p = (async () => {
      const t = await target(d, r);
      if (!t) {
        throw Object.assign(new Error(`${r.tmdbType === 'movie' ? 'Radarr' : 'Sonarr'} doesn’t have this title, so there’s nothing to search. Retry the request to send it again.`), { status: 409 });
      }
      const releases = await t.client.releases(t.id, t.season);
      const check = summarize(releases, t.arr, now);
      saveCheck(d.db, r, check);
      const sorted = [...releases].sort((a, b) => Number(a.rejected) - Number(b.rejected) || (b.customFormatScore ?? 0) - (a.customFormatScore ?? 0) || (b.seeders ?? 0) - (a.seeders ?? 0));
      const value: ReleasesResponse = { requestId, title: r.title, arr: t.arr, season: t.season ?? null, check, releases: sorted.slice(0, 100) };
      cachedReleases.set(requestId, value);
      return value;
    })().finally(() => inflight.delete(requestId));
    inflight.set(requestId, p);
  }
  return p;
}
const cachedReleases = new Map<number, ReleasesResponse>();

function saveCheck(db: Db, r: RequestItem, check: ReleaseCheck) {
  run(db, `INSERT INTO release_checks (request_id, tmdb_type, tmdb_id, checked_at, summary_json) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (request_id) DO UPDATE SET checked_at = excluded.checked_at, summary_json = excluded.summary_json`,
  [r.id, r.tmdbType, r.tmdbId, check.at, JSON.stringify(check)]);
}

/** Grab one of the search's results. Rejected ones too: that's the point of picking yourself. */
export async function grabRelease(d: DownloadDeps, requestId: number, guid: string, indexerId: number): Promise<{ title: string }> {
  const found = cachedReleases.get(requestId);
  const rel = found?.releases.find((x) => x.guid === guid && x.indexerId === indexerId);
  if (!found || !rel) throw Object.assign(new Error('That result has expired. Search again and pick it from the new list.'), { status: 410 });
  const client = found.arr === 'Radarr' ? d.radarr : d.sonarr;
  if (!client) throw Object.assign(new Error(`${found.arr} isn’t set up.`), { status: 409 });
  await client.grab(guid, indexerId);
  log.info('releases: grabbed', { requestId, release: rel.title, rejected: rel.rejected });
  cachedReleases.delete(requestId);
  resetDownloadsCache();
  return { title: rel.title };
}

export interface RetryResult { checked: number; searched: string[]; nothing: string[]; failed: string[] }

/**
 * Daily: re-check titles that have been Not found for a while, a few at a time and each at
 * most once every NOT_FOUND_RETRY_DAYS. If any result would now be accepted, ask Radarr or
 * Sonarr to search (it grabs the best one); otherwise just record why.
 */
export async function retryNotFound(d: DownloadDeps, now = new Date()): Promise<RetryResult> {
  const cfg: Config = d.cfg;
  const out: RetryResult = { checked: 0, searched: [], nothing: [], failed: [] };
  const snap = await downloadsSnapshot(d, now);
  const last = new Map(all<{ request_id: number; searched_at: string | null; checked_at: string }>(d.db,
    'SELECT request_id, searched_at, checked_at FROM release_checks').map((x) => [x.request_id, x]));
  const due = snap.requests
    .filter((r) => r.state === 'missing')
    .filter((r) => !r.requestedAt || now.getTime() - Date.parse(r.requestedAt) > cfg.NOT_FOUND_RETRY_AFTER_DAYS * 86_400_000)
    .filter((r) => { const l = last.get(r.id)?.checked_at; return !l || now.getTime() - Date.parse(l) > cfg.NOT_FOUND_RETRY_DAYS * 86_400_000; })
    .sort((a, b) => (last.get(a.id)?.checked_at ?? '').localeCompare(last.get(b.id)?.checked_at ?? ''))
    .slice(0, cfg.NOT_FOUND_RETRY_MAX);
  for (const r of due) {
    out.checked++;
    try {
      const found = await requestReleases(d, r.id, { fresh: true, now });
      if (found.check.accepted > 0) {
        const client = found.arr === 'Radarr' ? d.radarr! : d.sonarr!;
        const t = await target(d, r);
        if (t) await client.search(t.id, t.season);
        run(d.db, 'UPDATE release_checks SET searched_at = ?, search_count = search_count + 1 WHERE request_id = ?', [now.toISOString(), r.id]);
        out.searched.push(r.title);
      } else {
        out.nothing.push(r.title);
      }
    } catch (err) {
      out.failed.push(r.title);
      log.warn('releases: retry failed', { requestId: r.id, error: (err as Error).message });
    }
  }
  if (out.checked) log.info('releases: retried Not found', { ...out });
  return out;
}

/** For the Downloads page: the last check of each request. */
export function lastChecks(db: Db): Map<number, { check: ReleaseCheck; searchedAt: string | null; searches: number }> {
  return new Map(all<{ request_id: number; summary_json: string; searched_at: string | null; search_count: number }>(db,
    'SELECT request_id, summary_json, searched_at, search_count FROM release_checks')
    .map((x) => [x.request_id, { check: JSON.parse(x.summary_json) as ReleaseCheck, searchedAt: x.searched_at, searches: x.search_count }]));
}
export const forgetCheck = (db: Db, requestId: number) => run(db, 'DELETE FROM release_checks WHERE request_id = ?', [requestId]);
void get;
