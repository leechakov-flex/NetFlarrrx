// Remove from library: delete the files and stop Radarr/Sonarr watching for it, then
// forget it in Seerr (so it can be requested again) and drop it from MonkeySee's lists.
import { get, run, tx, type Db } from '../db/db.js';
import type { ArrClient } from '../clients/arr.js';
import type { JellyfinClient } from '../clients/jellyfin.js';
import type { SeerrClient } from '../clients/seerr.js';
import { log } from '../log.js';

export interface RemoveDeps { db: Db; radarr?: ArrClient; sonarr?: ArrClient; jellyfin?: JellyfinClient; seerr: SeerrClient }
export interface RemoveResult { title: string; type: 'movie' | 'tv'; via: 'radarr' | 'sonarr' | 'jellyfin'; seerrCleared: boolean }

export class RemoveError extends Error { constructor(message: string, public status: number) { super(message); } }

export async function removeFromLibrary(d: RemoveDeps, jellyfinId: string): Promise<RemoveResult> {
  const item = get<{ jellyfin_id: string; media_type: 'movie' | 'tv'; tmdb_id: number | null; name: string }>(d.db,
    'SELECT jellyfin_id, media_type, tmdb_id, name FROM jellyfin_items WHERE jellyfin_id = ?', [jellyfinId]);
  if (!item) throw new RemoveError('That title isn’t in your library any more.', 404);
  const arr = item.media_type === 'movie' ? d.radarr : d.sonarr;
  const arrName = item.media_type === 'movie' ? 'radarr' : 'sonarr';

  // 1. Files. Radarr/Sonarr delete them and stop watching; Jellyfin only for what they don't manage.
  let via: RemoveResult['via'];
  const arrId = arr && item.tmdb_id ? await arr.findId(item.tmdb_id) : null;
  if (arr && arrId != null) {
    await arr.remove(arrId);
    via = arrName;
  } else if (d.jellyfin) {
    await d.jellyfin.deleteItem(item.jellyfin_id);
    via = 'jellyfin';
  } else {
    throw new RemoveError(`${arrName === 'radarr' ? 'Radarr' : 'Sonarr'} doesn’t have this title, so MonkeySee can’t delete its files.`, 409);
  }

  // 2. Seerr: forget it, so it isn't "available" and can be requested again. Best effort.
  let seerrCleared = false;
  const sm = item.tmdb_id ? get<{ seerr_id: number }>(d.db, 'SELECT seerr_id FROM seerr_media WHERE media_type = ? AND tmdb_id = ?', [item.media_type, item.tmdb_id]) : undefined;
  if (sm) {
    try { await d.seerr.deleteMedia(sm.seerr_id); seerrCleared = true; } catch (err) { log.warn('library: Seerr clear failed', { error: (err as Error).message }); }
  }

  // 3. MonkeySee's own copies, so it disappears now rather than at the next sync.
  tx(d.db, () => {
    run(d.db, 'DELETE FROM jellyfin_items WHERE jellyfin_id = ?', [item.jellyfin_id]);
    if (item.tmdb_id) {
      for (const t of ['library_items', 'arr_titles', ...(seerrCleared ? ['seerr_media'] : [])]) {
        run(d.db, `DELETE FROM ${t} WHERE media_type = ? AND tmdb_id = ?`, [item.media_type, item.tmdb_id]);
      }
    }
  });
  if (d.jellyfin) void d.jellyfin.refresh().catch((err) => log.warn('library: Jellyfin rescan failed', { error: (err as Error).message }));
  log.info('library: removed', { title: item.name, type: item.media_type, via, seerrCleared });
  return { title: item.name, type: item.media_type, via, seerrCleared };
}
