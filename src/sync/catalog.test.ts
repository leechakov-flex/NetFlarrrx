import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, all, get, run, type Db } from '../db/db.js';
import { testConfig, type Config } from '../config.js';
import { WatchmodeClient } from '../clients/watchmode.js';
import { runCatalogSync, confirmHeldRun } from './catalog.js';
import { FakeWatchmode, realCatalog } from '../test-support/fakes.js';

const day = (n: number) => () => new Date(Date.UTC(2026, 10, 21 + n, 11, 23));

let db: Db;
let cfg: Config;
let wm: FakeWatchmode;
let client: WatchmodeClient;

beforeEach(() => {
  db = openDb(':memory:');
  cfg = testConfig();
  wm = new FakeWatchmode();
  client = new WatchmodeClient(cfg.WATCHMODE_BASE, cfg.WATCHMODE_API_KEY, wm.fetch, 0);
});

const sync = (n: number) => runCatalogSync({ db, cfg, watchmode: client, now: day(n) }, 'cli');
const avail = () => all<{ watchmode_id: number; added_at: string | null; removed_at: string | null; baseline: number; back_on_service: number }>(db,
  `SELECT t.watchmode_id, a.added_at, a.removed_at, a.baseline, a.back_on_service FROM availability a JOIN titles t ON t.id = a.title_id`);

describe('catalog sync against the real Netflix US snapshot', () => {
  it('baseline run records all 7,211 titles with no date added, for 29 credits', async () => {
    const r = await sync(0);
    expect(r).toMatchObject({ status: 'complete', applied: 1, baseline: 1, titles_seen: 7211, pages_total: 29, pages_fetched: 29, added: 7211 });
    expect(r.quota_used_after! - r.quota_used_before!).toBe(29);
    const rows = avail();
    expect(rows).toHaveLength(7211);
    expect(rows.every((x) => x.added_at === null && x.baseline === 1)).toBe(true);
    expect(get<{ n: number }>(db, 'SELECT count(*) n FROM sync_observations WHERE run_id = ?', [r.id])!.n).toBe(7211);
    expect(get<{ n: number }>(db, `SELECT count(*) n FROM titles WHERE tmdb_status = 'no_tmdb_id'`)!.n).toBe(9);
  });

  it('dates new titles, tolerates one miss, removes after two', async () => {
    await sync(0);
    const gone = wm.catalog.slice(0, 3).map((t) => t.id);
    const fresh = [1, 2, 3, 4, 5].map((i) => ({ id: 900_000 + i, title: `New ${i}`, year: 2026, type: 'movie', tmdb_id: 990_000 + i, tmdb_type: 'movie' as const, imdb_id: null }));
    wm.catalog = [...wm.catalog.slice(3), ...fresh];

    const r1 = await sync(1);
    expect(r1).toMatchObject({ status: 'complete', baseline: 0, added: 5, missed: 3, removed: 0 });
    const freshIds = new Set(fresh.map((f) => f.id));
    const newRows = avail().filter((x) => freshIds.has(x.watchmode_id));
    expect(newRows).toHaveLength(5);
    expect(newRows.every((x) => x.added_at === day(1)().toISOString() && x.baseline === 0)).toBe(true);
    expect(avail().filter((x) => gone.includes(x.watchmode_id)).every((x) => x.removed_at === null)).toBe(true);

    const r2 = await sync(2);
    expect(r2).toMatchObject({ added: 0, missed: 0, removed: 3 });
    expect(avail().filter((x) => gone.includes(x.watchmode_id)).every((x) => x.removed_at === day(1)().toISOString())).toBe(true);
  });

  it('a title back after 15 days is flagged back on Netflix with a new date', async () => {
    await sync(0);
    const t = wm.catalog[0]!;
    wm.catalog = wm.catalog.slice(1);
    await sync(1); await sync(2);
    wm.catalog = [t, ...wm.catalog];
    const r = await sync(17);
    expect(r.back_on_service).toBe(1);
    expect(avail().find((x) => x.watchmode_id === t.id)).toMatchObject({ removed_at: null, back_on_service: 1, added_at: day(17)().toISOString() });
  });

  it('survives a transient 429 on one page', async () => {
    wm.flakyPages.add(5);
    const r = await sync(0);
    expect(r.status).toBe('complete');
    expect(r.titles_seen).toBe(7211);
  });

  it('a page that keeps failing makes the run partial and changes nothing', async () => {
    await sync(0);
    wm.failPages.add(12);
    wm.catalog = wm.catalog.slice(10);
    const r = await sync(1);
    expect(r.status).toBe('partial');
    expect(r.applied).toBe(0);
    expect(JSON.parse(r.failed_pages!)).toEqual([12]);
    expect(avail().every((x) => x.removed_at === null)).toBe(true);
    expect(get<{ n: number }>(db, 'SELECT count(*) n FROM availability WHERE missing_count > 0')!.n).toBe(0);
  });

  it('holds a run whose count moves more than 10%, and applies it when confirmed', async () => {
    await sync(0);
    wm.catalog = wm.catalog.slice(0, 6000); // -17%
    const held = await sync(1);
    expect(held).toMatchObject({ status: 'held', applied: 0, previous_count: 7211, titles_seen: 6000 });
    expect(held.note).toMatch(/17%/);
    expect(get<{ n: number }>(db, 'SELECT count(*) n FROM availability WHERE missing_count > 0')!.n).toBe(0);

    const confirmed = confirmHeldRun(db, cfg, held.id, day(1)());
    expect(confirmed).toMatchObject({ status: 'complete', applied: 1, missed: 1211, removed: 0 });
    expect(confirmed.confirmed_at).not.toBeNull();
    expect(() => confirmHeldRun(db, cfg, held.id)).toThrow(/not held/);
  });

  it('will not confirm a held run that a later applied run superseded', async () => {
    await sync(0);
    const full = wm.catalog;
    wm.catalog = full.slice(0, 5000);
    const held = await sync(1);
    wm.catalog = full;
    await sync(2);
    expect(() => confirmHeldRun(db, cfg, held.id)).toThrow(/older than applied run/);
  });

  it('holds an empty catalog even on the first run', async () => {
    wm.catalog = [];
    const r = await sync(0);
    expect(r.status).toBe('held');
    expect(avail()).toHaveLength(0);
  });

  it('refuses to start without enough credits', async () => {
    wm.used = 2480;
    const r = await sync(0);
    expect(r).toMatchObject({ status: 'failed', pages_fetched: null });
    expect(r.note).toMatch(/not enough credits/);
    expect(wm.calls.filter((c) => c.includes('list-titles'))).toHaveLength(0);
  });

  it('fails cleanly on a bad key', async () => {
    wm.authFail = true;
    const r = await sync(0);
    expect(r.status).toBe('failed');
    expect(r.note).toMatch(/401/);
  });

  it('skips while another run is in progress, and clears a stale one', async () => {
    run(db, `INSERT INTO sync_runs (provider_id, region, trigger, status, started_at) VALUES (203, 'US', 'cli', 'running', ?)`,
      [new Date(day(0)().getTime() - 10 * 60_000).toISOString()]);
    expect((await sync(0)).status).toBe('skipped');
    expect((await sync(1)).status).toBe('complete');
    expect(get<{ status: string; note: string }>(db, 'SELECT status, note FROM sync_runs WHERE id = 1')).toMatchObject({ status: 'failed' });
  });

  it('resets enrichment when Watchmode changes a title\'s TMDB id', async () => {
    await sync(0);
    const t = realCatalog().find((x) => x.tmdb_id)!;
    run(db, `UPDATE titles SET tmdb_status = 'ok' WHERE watchmode_id = ?`, [t.id]);
    wm.catalog = wm.catalog.map((x) => (x.id === t.id ? { ...x, tmdb_id: 123456789 } : x));
    await sync(1);
    expect(get<{ tmdb_status: string; tmdb_id: number }>(db, 'SELECT tmdb_status, tmdb_id FROM titles WHERE watchmode_id = ?', [t.id]))
      .toEqual({ tmdb_status: 'pending', tmdb_id: 123456789 });
  });
});
