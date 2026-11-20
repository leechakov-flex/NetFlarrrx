// Serves the fake Watchmode, TMDB and Seerr on local ports, for running the
// built app end to end without real keys:  npx tsx src/test-support/serve-fakes.ts
import { createServer } from 'node:http';
import { FakeSeerr, FakeTmdb, FakeWatchmode } from './fakes.js';
import type { FetchFn } from '../clients/http.js';

function serve(port: number, fetchFn: FetchFn) {
  createServer(async (req, res) => {
    const r = await fetchFn(`http://127.0.0.1:${port}${req.url}`);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(await r.text());
  }).listen(port, '127.0.0.1');
}
const base = Number(process.env.FAKE_PORT_BASE ?? 18000);
serve(base + 1, new FakeWatchmode().fetch);
serve(base + 2, new FakeTmdb().fetch);
serve(base + 3, new FakeSeerr().fetch);
console.log(`fakes on ${base + 1} (watchmode) ${base + 2} (tmdb) ${base + 3} (seerr)`);
