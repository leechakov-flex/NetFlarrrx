import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, all, get, run, getJobState, type Db } from '../db/db.js';
import { testConfig, type Config } from '../config.js';
import { WatchmodeClient } from '../clients/watchmode.js';
import { TmdbClient } from '../clients/tmdb.js';
import { SeerrClient } from '../clients/seerr.js';
import { runCatalogSync } from '../sync/catalog.js';
import { enrichTitles } from './tmdb.js';
import { mirrorSeerrMedia } from '../seerr/mirror.js';
import { catalogStats } from '../catalog/rules.js';
import { FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';

let db: Db;
let cfg: Config;
let tmdbFake: FakeTmdb;
let tmdb: TmdbClient;

// 300 real titles: enough variety (movies, series, specials, one with no TMDB id).
const sample = () => {
  const all = realCatalog();
  const pick = all.filter((_, i) => i % 24 === 0).slice(0, 300);
  const noTmdb = all.find((t) => !t.tmdb_id);
  return noTmdb && !pick.includes(noTmdb) ? [...pick, noTmdb] : pick;
};

beforeEach(async () => {
  db = openDb(':memory:');
  cfg = testConfig();
  const wm = new FakeWatchmode(sample());
  await runCatalogSync({ db, cfg, watchmode: new WatchmodeClient(cfg.WATCHMODE_BASE, 'k', wm.fetch, 0) }, 'cli');
  tmdbFake = new FakeTmdb();
  tmdb = new TmdbClient(cfg.TMDB_BASE, 'k', tmdbFake.fetch);
});

describe('TMDB enrichment', () => {
  it('fills metadata, genres and keywords for every title with a TMDB id', async () => {
    const r = await enrichTitles(db, cfg, tmdb);
    const withIds = get<{ n: number }>(db, 'SELECT count(*) n FROM titles WHERE tmdb_id IS NOT NULL')!.n;
    expect(r).toMatchObject({ queued: withIds, ok: withIds, missing: 0, errors: 0 });
    const movie = get<Record<string, unknown>>(db, `SELECT * FROM titles WHERE tmdb_type = 'movie' LIMIT 1`)!;
    expect(movie).toMatchObject({ tmdb_status: 'ok', original_language: 'ko', vote_count: 2155, runtime: 98, seasons: null });
    const tv = get<Record<string, unknown>>(db, `SELECT * FROM titles WHERE tmdb_type = 'tv' LIMIT 1`)!;
    expect(tv).toMatchObject({ original_language: 'sv', seasons: 1, runtime: null });
    expect(get<{ n: number }>(db, 'SELECT count(*) n FROM title_genres WHERE title_id = ?', [movie.id as number])!.n).toBe(3);
    expect(get<{ n: number }>(db, 'SELECT count(*) n FROM title_keywords WHERE title_id = ?', [movie.id as number])!.n).toBe(11);
    expect(getJobState<{ ok: number }>(db, 'enrich')!.value.ok).toBe(withIds);
  });

  it('marks 404s missing, and a single 500 is absorbed by the client retry', async () => {
    const [a, b] = all<{ tmdb_type: string; tmdb_id: number }>(db, 'SELECT tmdb_type, tmdb_id FROM titles WHERE tmdb_id IS NOT NULL LIMIT 2');
    tmdbFake.missing.add(`${a!.tmdb_type}:${a!.tmdb_id}`);
    tmdbFake.failOnce.add(`${b!.tmdb_type}:${b!.tmdb_id}`);
    let r = await enrichTitles(db, cfg, tmdb);
    expect(r.missing).toBe(1);
    expect(r.errors).toBe(0);
    r = await enrichTitles(db, cfg, tmdb);
    expect(r.queued).toBe(0);
  });

  it('records an error status and retries it next run', async () => {
    const t = get<{ id: number }>(db, 'SELECT id FROM titles WHERE tmdb_id IS NOT NULL LIMIT 1')!;
    await enrichTitles(db, cfg, tmdb);
    run(db, `UPDATE titles SET tmdb_status = 'error' WHERE id = ?`, [t.id]);
    const r = await enrichTitles(db, cfg, tmdb);
    expect(r).toMatchObject({ queued: 1, ok: 1 });
  });

  it('refreshes titles older than the stale window only', async () => {
    await enrichTitles(db, cfg, tmdb);
    expect((await enrichTitles(db, cfg, tmdb)).queued).toBe(0);
    const later = new Date(Date.now() + 31 * 86_400_000);
    const r = await enrichTitles(db, cfg, tmdb, { now: later });
    expect(r.queued).toBeGreaterThan(0);
  });

  it('stops early when TMDB rejects the token', async () => {
    const bad = new TmdbClient(cfg.TMDB_BASE, 'k', async () => new Response('{"status_code":7}', { status: 401 }));
    const r = await enrichTitles(db, { ...cfg, TMDB_CONCURRENCY: 1 }, bad);
    expect(r.aborted).toMatch(/TMDB_READ_TOKEN/);
    expect(r.errors).toBe(1);
  });
});

describe('English-only rule and stats', () => {
  it('counts only English-original movies and series, and flips with LANGUAGE_RULE', async () => {
    await enrichTitles(db, cfg, tmdb);
    // Make a third of titles English-original.
    run(db, `UPDATE titles SET original_language = 'en' WHERE id % 3 = 0`);
    const en = catalogStats(db, cfg);
    const everything = catalogStats(db, { ...cfg, LANGUAGE_RULE: 'all' });
    const specials = get<{ n: number }>(db, `SELECT count(*) n FROM titles WHERE watchmode_type = 'tv_special'`)!.n;
    expect(everything.eligible).toBe(everything.on_service - specials);
    expect(en.eligible).toBeLessThan(everything.eligible);
    expect(en.eligible).toBe(get<{ n: number }>(db,
      `SELECT count(*) n FROM title_kinds WHERE original_language = 'en' AND kind IS NOT NULL`)!.n);
    expect(en.eligible_movies + en.eligible_series).toBe(en.eligible);
    expect(en.dated).toBe(0);   // all baseline
    expect(en.enrichment.no_tmdb_id).toBeGreaterThanOrEqual(1);
  });
});

describe('Seerr mirror', () => {
  it('mirrors every page of the recorded Seerr media list', async () => {
    const fake = new FakeSeerr();
    const r = await mirrorSeerrMedia(db, new SeerrClient('http://seerr:5055', 'k', fake.fetch));
    expect(r).toMatchObject({ ok: true, count: fake.media.length, invalid: 0 });
    const statuses = all<{ status: number }>(db, 'SELECT DISTINCT status FROM seerr_media ORDER BY status').map((x) => x.status);
    expect(statuses).toEqual(expect.arrayContaining([4, 5]));
    const tv = get<{ seasons_json: string }>(db, `SELECT seasons_json FROM seerr_media WHERE media_type = 'tv' LIMIT 1`)!;
    expect(JSON.parse(tv.seasons_json)[0]).toEqual({ seasonNumber: expect.any(Number), status: expect.any(Number) });
  });

  it('pages past 100 items and drops media Seerr no longer has', async () => {
    const big = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, mediaType: i % 2 ? 'tv' : 'movie', tmdbId: 1000 + i, status: 5, seasons: [] }));
    const fake = new FakeSeerr(big);
    const client = new SeerrClient('http://seerr:5055', 'k', fake.fetch);
    expect((await mirrorSeerrMedia(db, client)).count).toBe(250);
    fake.media = big.slice(0, 10);
    expect((await mirrorSeerrMedia(db, client)).count).toBe(10);
    expect(get<{ n: number }>(db, 'SELECT count(*) n FROM seerr_media')!.n).toBe(10);
  });

  it('keeps the last good copy when Seerr is down', async () => {
    const fake = new FakeSeerr();
    const client = new SeerrClient('http://seerr:5055', 'k', fake.fetch);
    await mirrorSeerrMedia(db, client);
    fake.fail = true;
    const r = await mirrorSeerrMedia(db, client);
    expect(r.ok).toBe(false);
    expect(get<{ n: number }>(db, 'SELECT count(*) n FROM seerr_media')!.n).toBe(fake.media.length);
    expect(getJobState<{ ok: boolean; lastOkAt: string }>(db, 'seerr_mirror')!.value).toMatchObject({ ok: false, lastOkAt: expect.any(String) });
  });
});
