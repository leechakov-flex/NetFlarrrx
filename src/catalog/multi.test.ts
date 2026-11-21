import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp, type App } from '../app.js';
import { createServer } from '../server.js';
import { testConfig } from '../config.js';
import { get, run } from '../db/db.js';
import { FakeSeerr, FakeTmdb, FakeWatchmode, realCatalog } from '../test-support/fakes.js';
import type { BrowseResponse, HomeResponse, TitleDetail } from '../api/types.js';
import { rowArt } from './queries.js';

let app: App;
let http: ReturnType<typeof createServer>;
const j = async <T>(path: string) => { const r = await http.request(path); expect(r.status).toBe(200); return (await r.json()) as T; };
const idOf = (tmdbType: string, tmdbId: number) => get<{ id: number }>(app.db, 'SELECT id FROM titles WHERE tmdb_type = ? AND tmdb_id = ?', [tmdbType, tmdbId])!.id;
const future = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

let shared: { tmdb_id: number; title: string };
beforeAll(async () => {
  const catalog = realCatalog().filter((t, i) => i % 30 === 0 && t.type === 'movie').slice(0, 40);
  shared = { tmdb_id: catalog[0]!.tmdb_id!, title: catalog[0]!.title };
  const tmdb = new FakeTmdb();
  tmdb.discoverBy = (type, p) => {
    if (p.get('with_watch_providers') === '9') return type === 'movie' ? [{ id: shared.tmdb_id, title: shared.title }, { id: 810001, title: 'Prime Only' }] : [];
    if (type === 'movie' && p.get('with_release_type') === '4' && (p.get('release_date.gte') ?? '') > new Date().toISOString().slice(0, 10)) return [{ id: 810003, title: 'Soon Original', date: future(4) }, { id: 810004, title: 'Soon Rental', date: future(6) }];
    if (type === 'movie' && p.get('with_release_type') === '4') return [{ id: 810002, title: 'Rentable' }];
    return [];
  };
  const usRelease = (date: string, note = '') => ({ release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: `${date}T00:00:00.000Z`, note }] }] } });
  tmdb.overrides.set(`movie:${shared.tmdb_id}`, {
    original_language: 'en',
    images: { logos: [{ file_path: '/logo.png', iso_639_1: 'en', vote_average: 5 }, { file_path: '/logo-fr.png', iso_639_1: 'fr', vote_average: 9 }], posters: [{ file_path: '/clean.jpg', iso_639_1: null }, { file_path: '/titled.jpg', iso_639_1: 'en' }] },
    credits: { cast: [{ name: 'Lead Actor', character: 'Hero', profile_path: '/a.jpg' }], crew: [{ name: 'A Director', job: 'Director' }, { name: 'Grip', job: 'Grip' }] },
    'watch/providers': { results: { US: { flatrate: [{ provider_id: 8, provider_name: 'Netflix' }], rent: [{ provider_id: 2, provider_name: 'Apple TV' }], buy: [{ provider_id: 2, provider_name: 'Apple TV' }, { provider_id: 10, provider_name: 'Amazon Video' }] } } },
    recommendations: { results: [{ id: 810001, media_type: 'movie' }, { id: 999999, media_type: 'movie' }] },
  });
  for (const id of [810001, 810002]) tmdb.overrides.set(`movie:${id}`, { original_language: 'en', ...usRelease('2026-11-10') });
  tmdb.overrides.set('movie:810003', { original_language: 'en', ...usRelease(future(4), 'Netflix') });
  tmdb.overrides.set('movie:810004', { original_language: 'en', ...usRelease(future(6), '') });
  app = createApp(testConfig({ SERVICES: 'netflix,prime', TRACK_DIGITAL: 'true', TRACK_UPCOMING: 'true', LANGUAGE_RULE: 'all' }),
    { watchmode: new FakeWatchmode(catalog).fetch, tmdb: tmdb.fetch, seerr: new FakeSeerr([]).fetch });
  http = createServer(app);
  await app.pipeline('cli');
  // Something new on Prime and something new on Netflix, a week apart.
  run(app.db, `UPDATE availability SET added_at = ? WHERE provider_id = 1026 AND title_id = ?`, [new Date(Date.now() - 86_400_000).toISOString(), idOf('movie', 810001)]);
});
afterAll(() => app.close());

describe('cards across services', () => {
  it('a title on two services is one card that names them', async () => {
    const b = await j<BrowseResponse>('/api/titles?services=prime');
    const id = idOf('movie', shared.tmdb_id);
    expect(b.items.filter((i) => i.id === id)).toHaveLength(1);
    const card = b.items.find((i) => i.id === id)!;
    expect(card.services).toEqual(['prime']);                        // the services in the filter
    expect((await j<TitleDetail>(`/api/titles/${id}`)).services).toEqual(['netflix', 'prime']);
    expect(card.logoPath).toBe('/logo.png');
    expect(card.textlessPosterPath).toBe('/clean.jpg');
  });

  it('filters by service and by how to watch', async () => {
    expect((await j<BrowseResponse>('/api/titles?services=prime')).total).toBe(2);
    const rent = await j<BrowseResponse>('/api/titles?how=digital');
    expect(rent.items.map((i) => [i.id, i.digital, i.services, i.addedAt?.slice(0, 10)])).toEqual([[idOf('movie', 810002), true, [], '2026-11-10']]);
    const soon = await j<BrowseResponse>('/api/titles?how=soon&sort=soon');
    expect(soon.items.map((i) => [i.id, i.soon])).toEqual([
      [idOf('movie', 810003), { date: future(4), service: 'netflix' }],
      [idOf('movie', 810004), { date: future(6), service: null }],
    ]);
  });

  it('Discover has new on your services, rent or buy, coming soon and a per-service row', async () => {
    const h = await j<HomeResponse>('/api/home');
    const slugs = h.rows.map((r) => r.slug);
    expect(slugs.slice(0, 3)).toEqual(['new-week', 'new-digital', 'coming-soon']);
    expect(slugs).toContain('new-prime');
    expect(h.rows.find((r) => r.slug === 'new-week')!.items.map((i) => i.id)).toContain(idOf('movie', 810001));
    expect(h.rows.find((r) => r.slug === 'new-prime')!.items.map((i) => i.id)).toEqual([idOf('movie', 810001)]);
  });
});

describe('title detail', () => {
  it('has where to watch, cast and crew, and related titles on your services', async () => {
    const d = await j<TitleDetail>(`/api/titles/${idOf('movie', shared.tmdb_id)}`);
    expect(d.watch.services.map((s) => s.name)).toEqual(['Netflix', 'Prime Video']);
    expect(d.watch.stores).toEqual(['Apple TV', 'Amazon Video']);
    expect(d.cast.map((c) => [c.name, c.role])).toEqual([['A Director', 'Director'], ['Lead Actor', 'Hero']]);
    expect(d.related.map((r) => r.id)).toEqual([idOf('movie', 810001)]);   // the other recommendation isn't on a service
  });

  it('opens a coming-soon title', async () => {
    const d = await j<TitleDetail>(`/api/titles/${idOf('movie', 810003)}`);
    expect(d.soon).toEqual({ date: future(4), service: 'netflix' });
    expect(d.watch.services).toEqual([]);
  });
});

describe('row art', () => {
  it('uses logo art only when nearly every card has a logo and a textless poster', () => {
    const card = (both: boolean) => ({ logoPath: both ? '/l' : null, textlessPosterPath: both ? '/p' : null }) as never;
    expect(rowArt([card(true), card(true), card(true), card(true), card(false)])).toBe('logo');
    expect(rowArt([card(true), card(true), card(false)])).toBe('poster');
    expect(rowArt([])).toBe('poster');
  });
});
