import { all, getJobState, run, setJobState, tx, type Db } from '../db/db.js';
import type { SeerrClient, SeerrMedia } from '../clients/seerr.js';
import { log } from '../log.js';

export interface MirrorResult { ok: boolean; count: number; invalid: number; error?: string }

/**
 * Copies Seerr's full media list into seerr_media. Replaces the mirror only after
 * every page arrives, so a failed refresh leaves the last good copy in place.
 */
export async function mirrorSeerrMedia(db: Db, seerr: SeerrClient, now = new Date()): Promise<MirrorResult> {
  const at = now.toISOString();
  const media: SeerrMedia[] = [];
  let invalid = 0;
  try {
    const take = 100;
    for (let skip = 0, total = Infinity; skip < total; skip += take) {
      const page = await seerr.mediaPage(skip, take);
      total = page.total;
      invalid += page.invalid;
      media.push(...page.media);
      if (page.media.length + page.invalid === 0) break;   // defensive: never loop on an empty page
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const prev = getJobState<MirrorResult & { at: string; lastOkAt?: string }>(db, 'seerr_mirror');
    setJobState(db, 'seerr_mirror', { ok: false, count: prev?.value.count ?? 0, invalid: 0, error, at, lastOkAt: prev?.value.lastOkAt ?? null }, at);
    log.warn('seerr mirror: failed; keeping last copy', { error });
    return { ok: false, count: 0, invalid: 0, error };
  }

  tx(db, () => {
    run(db, 'DELETE FROM seerr_media');
    const ins = db.prepare(`INSERT OR REPLACE INTO seerr_media (media_type, tmdb_id, seerr_id, status, status4k, seasons_json, updated_at, mirrored_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const m of media) {
      const seasons = m.seasons.map((s) => ({ seasonNumber: s.seasonNumber, status: s.status }));
      ins.run(m.mediaType, m.tmdbId, m.id, m.status, m.status4k ?? null, JSON.stringify(seasons), m.updatedAt ?? null, at);
    }
  });
  const result = { ok: true, count: media.length, invalid };
  setJobState(db, 'seerr_mirror', { ...result, at, lastOkAt: at }, at);
  log.debug('seerr mirror: refreshed', result);
  return result;
}

export function seerrStatusFor(db: Db, mediaType: 'movie' | 'tv', tmdbId: number) {
  return all<{ status: number; seasons_json: string }>(db,
    'SELECT status, seasons_json FROM seerr_media WHERE media_type = ? AND tmdb_id = ?', [mediaType, tmdbId])[0];
}
