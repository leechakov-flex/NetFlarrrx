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
      delete body.title; delete body.name;               // fall back to Watchmode's real titles
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
      body.overview = 'A lighthouse keeper on a remote island starts receiving radio messages from a ship that sank forty years ago. As the storms close in, she has to decide whether to answer.';
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  : tmdb.fetch;

const base = Number(process.env.FAKE_PORT_BASE ?? 18000);
serve(base + 1, new FakeWatchmode().fetch);
serve(base + 2, tmdbFetch);
serve(base + 3, new FakeSeerr().fetch);
console.log(`fakes on ${base + 1} (watchmode) ${base + 2} (tmdb) ${base + 3} (seerr)${varied ? ' [varied]' : ''}`);
