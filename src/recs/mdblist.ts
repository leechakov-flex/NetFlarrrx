// MDBList recommendation lists: the ones you picked, their titles, and the daily refresh.
import { all, get, run, tx, type Db } from '../db/db.js';
import type { MdbList, MdbListClient } from '../clients/mdblist.js';
import { log } from '../log.js';

export interface PickedList {
  id: number; name: string; userName: string | null; slug: string | null; items: number | null;
  /** How many of its titles are in your catalog (on your services or coming to them). */
  inCatalog: number; syncedAt: string | null; error: string | null;
}

export function pickedLists(db: Db): PickedList[] {
  return all<{ list_id: number; name: string; user_name: string | null; slug: string | null; items: number | null; synced_at: string | null; error: string | null; in_catalog: number }>(db, `
    SELECT l.*, (SELECT count(DISTINCT t.id) FROM mdblist_items mi JOIN titles t ON t.tmdb_type = mi.tmdb_type AND t.tmdb_id = mi.tmdb_id WHERE mi.list_id = l.list_id) AS in_catalog
    FROM mdblist_lists l ORDER BY l.position, l.added_at`)
    .map((r) => ({ id: r.list_id, name: r.name, userName: r.user_name, slug: r.slug, items: r.items, inCatalog: r.in_catalog, syncedAt: r.synced_at, error: r.error }));
}
export const listName = (db: Db, id: number) => get<{ name: string }>(db, 'SELECT name FROM mdblist_lists WHERE list_id = ?', [id])?.name ?? null;

async function refreshOne(db: Db, client: MdbListClient, id: number, now: Date) {
  try {
    const items = await client.items(id);
    tx(db, () => {
      run(db, 'DELETE FROM mdblist_items WHERE list_id = ?', [id]);
      const ins = db.prepare('INSERT OR IGNORE INTO mdblist_items (list_id, tmdb_type, tmdb_id, rank) VALUES (?, ?, ?, ?)');
      for (const it of items) ins.run(id, it.tmdbType, it.tmdbId, it.rank);
      run(db, 'UPDATE mdblist_lists SET synced_at = ?, error = NULL WHERE list_id = ?', [now.toISOString(), id]);
    });
    return items.length;
  } catch (err) {
    run(db, 'UPDATE mdblist_lists SET error = ? WHERE list_id = ?', [(err as Error).message.slice(0, 300), id]);
    log.warn('mdblist: refresh failed', { id, error: (err as Error).message });
    return null;
  }
}

/** Add a list (from a search result) and fetch its titles straight away. */
export async function addList(db: Db, client: MdbListClient, l: Pick<MdbList, 'id'> & Partial<MdbList>, now = new Date()) {
  const info = l.name ? l : await client.list(l.id);
  if (!info?.name) throw Object.assign(new Error('MDBList doesn’t have that list.'), { status: 404 });
  const pos = get<{ p: number | null }>(db, 'SELECT max(position) p FROM mdblist_lists')!.p ?? 0;
  run(db, `INSERT INTO mdblist_lists (list_id, name, user_name, slug, mediatype, items, likes, position, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (list_id) DO NOTHING`,
  [info.id, info.name, info.userName ?? null, info.slug ?? null, info.mediatype ?? null, info.items ?? null, info.likes ?? null, pos + 1, now.toISOString()]);
  await refreshOne(db, client, info.id, now);
  return pickedLists(db).find((p) => p.id === info.id)!;
}

export function removeList(db: Db, id: number) {
  tx(db, () => { run(db, 'DELETE FROM mdblist_items WHERE list_id = ?', [id]); run(db, 'DELETE FROM mdblist_lists WHERE list_id = ?', [id]); });
}

/** Daily: refetch every picked list. */
export async function refreshLists(db: Db, client: MdbListClient, now = new Date()) {
  const ids = all<{ list_id: number }>(db, 'SELECT list_id FROM mdblist_lists ORDER BY position').map((r) => r.list_id);
  let ok = 0;
  for (const id of ids) if ((await refreshOne(db, client, id, now)) !== null) ok++;
  if (ids.length) log.info('mdblist: refreshed', { lists: ids.length, ok });
  return { lists: ids.length, ok };
}
