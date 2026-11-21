// Serves the fake Watchmode, TMDB and Seerr on local ports, for running the
// built app end to end without real keys:  npx tsx src/test-support/serve-fakes.ts
// FAKE_VARIED=1 makes TMDB answers differ per title (language, ratings, runtime),
// keeps Watchmode's real titles, and drops image paths so nothing loads remotely.
import { createServer } from 'node:http';
import { FakeSeerr, FakeTmdb, FakeWatchmode } from './fakes.js';
import type { FetchFn } from '../clients/http.js';

function serve(port: number, fetchFn: FetchFn) {
  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
    const r = await fetchFn(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method, headers, body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
    });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(await r.text());
  }).listen(port, '127.0.0.1');
}

const varied = process.env.FAKE_VARIED === '1';
const tmdb = new FakeTmdb();
// TMDB's own Netflix list for the cross-check: most of Watchmode's titles, plus a few extras.
{
  const all = new FakeWatchmode().catalog.filter((t) => t.tmdb_id && t.tmdb_type);
  const keep = all.filter((_, i) => i % 12 !== 0);
  tmdb.discover = {
    movie: [...keep.filter((t) => t.tmdb_type === 'movie').map((t) => ({ id: t.tmdb_id!, title: t.title })),
      ...Array.from({ length: 40 }, (_, i) => ({ id: 990000 + i, title: `TMDB-only film ${i + 1}`, popularity: 50 - i }))],
    tv: keep.filter((t) => t.tmdb_type === 'tv').map((t) => ({ id: t.tmdb_id!, title: t.title })),
  };
}
const tmdbFetch: FetchFn = varied
  ? async (input, init) => {
      const res = await tmdb.fetch(input, init);
      if (!res.ok) return res;
      const body = (await res.json()) as Record<string, unknown> & { id: number };
      const id = body.id;
      if (body.id < 7_000_000) { delete body.title; delete body.name; }   // fall back to Watchmode's real titles (not for the fake library)
      body.poster_path = null; body.backdrop_path = null;
      body.original_language = id % 5 < 3 ? 'en' : 'ko';
      body.vote_average = Math.round(((id % 47) / 47 * 4 + 5) * 10) / 10;
      body.vote_count = (id * 131) % 9000;
      body.popularity = (id * 17) % 500;
      body.runtime = 70 + (id % 80);
      // Spread a few theme keywords so every thematic row has something to show.
      const kws = [
        ...(id % 7 === 0 ? [{ id: 10051, name: 'heist' }] : []),
        ...(id % 5 === 0 ? [{ id: 9672, name: 'based on true story' }] : []),
        ...(id % 3 === 0 ? [{ id: 11162, name: 'miniseries' }] : []),
      ];
      if ('keywords' in body) body.keywords = { keywords: kws, results: kws };
      body.number_of_seasons = 1 + (id % 4);
      body.credits = { cast: [{ name: 'Morgan Reyes', character: 'Ada', profile_path: null }, { name: 'Sam Okafor', character: 'Theo', profile_path: null }, { name: 'Lena Brandt', character: 'Captain Vos', profile_path: null }], crew: [{ name: 'Iris Kalnins', job: 'Director' }] };
      body['watch/providers'] = { results: { US: { flatrate: [{ provider_id: 8, provider_name: 'Netflix' }], rent: [{ provider_id: 2, provider_name: 'Apple TV' }], buy: [{ provider_id: 2, provider_name: 'Apple TV' }, { provider_id: 10, provider_name: 'Amazon Video' }, { provider_id: 7, provider_name: 'Fandango at Home' }] } } };
      body.overview = 'A lighthouse keeper on a remote island starts receiving radio messages from a ship that sank forty years ago. As the storms close in, she has to decide whether to answer.';
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  : tmdb.fetch;

// Other services: HBO Max and Hulu from Watchmode (slices of the real catalog), Prime
// Video, rent or buy and coming soon from TMDB discover.
const wm = new FakeWatchmode();
wm.otherSources.set(387, wm.catalog.filter((_, i) => i % 9 === 1));
wm.otherSources.set(157, wm.catalog.filter((_, i) => i % 11 === 2));
{
  const films = wm.catalog.filter((t) => t.tmdb_id && t.tmdb_type === 'movie');
  const shows = wm.catalog.filter((t) => t.tmdb_id && t.tmdb_type === 'tv');
  const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  tmdb.discoverBy = (type, p) => {
    if (p.get('with_watch_providers') === '9') return (type === 'movie' ? films : shows).filter((_, i) => i % 7 === 3).map((t) => ({ id: t.tmdb_id!, title: t.title }));
    if (p.get('with_watch_providers')) return undefined;     // the cross-check's Netflix list
    if (type === 'movie' && p.get('with_release_type') === '4' && (p.get('release_date.gte') ?? '') > day(0))
      return films.filter((_, i) => i % 97 === 5).slice(0, 8).map((t, i) => ({ id: t.tmdb_id!, title: t.title, date: day(2 + i * 3) }));
    if (type === 'movie' && p.get('with_release_type') === '4') return films.filter((_, i) => i % 89 === 4).slice(0, 10).map((t) => ({ id: t.tmdb_id!, title: t.title }));
    if (type === 'tv' && p.get('with_networks')?.startsWith('213')) return shows.filter((_, i) => i % 151 === 9).slice(0, 4).map((t, i) => ({ id: t.tmdb_id!, title: t.title, date: day(4 + i * 5) }));
    return [];
  };
}
const base = Number(process.env.FAKE_PORT_BASE ?? 18000);
serve(base + 1, wm.fetch);
serve(base + 2, tmdbFetch);
// A small library (Seerr "available") whose TMDB recommendations point at Netflix titles.
const fakeSeerr = new FakeSeerr();
{
  const films = new FakeWatchmode().catalog.filter((t) => t.tmdb_id && t.tmdb_type === 'movie');
  const names = ['The Office', 'Parks and Recreation', 'Superbad', 'Knives Out', 'Severance', 'The Bear'];
  names.forEach((title, i) => {
    const id = 7_000_000 + i;
    fakeSeerr.media.push({ id: 9000 + i, mediaType: 'movie', tmdbId: id, status: 5, seasons: [], updatedAt: `2026-11-1${i}T00:00:00Z` });
    tmdb.overrides.set(`movie:${id}`, { title });
    tmdb.recs.set(`movie:${id}`, films.filter((_, k) => (k * 7 + i * 13) % 61 === 0).slice(0, 20).map((t) => t.tmdb_id!));
  });
}
serve(base + 3, fakeSeerr.fetch);
console.log(`fakes on ${base + 1} (watchmode) ${base + 2} (tmdb) ${base + 3} (seerr)${varied ? ' [varied]' : ''}`);
