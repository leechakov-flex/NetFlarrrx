// End-to-end test of scripts/spike.mjs against a local mock of Watchmode, TMDB and Seerr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = {
  WATCHMODE_API_KEY: 'wm-test-key-1234567890',
  TMDB_READ_TOKEN: 'tmdb-test-token-1234567890',
  SEERR_API_KEY: 'seerr-test-key-1234567890',
};

function makeCatalog() {
  const titles = [];
  for (let i = 1; i <= 5; i += 1) {
    titles.push({ id: 1000 + i, title: `Movie ${i}`, year: 2020, type: 'movie', tmdb_id: 500 + i, tmdb_type: 'movie', imdb_id: `tt${i}` });
  }
  titles.push({ id: 2001, title: 'Show A', year: 2019, type: 'tv_series', tmdb_id: 900, tmdb_type: 'tv', imdb_id: 'tt9' });
  titles.push({ id: 2002, title: 'Special', year: 2021, type: 'tv_special', tmdb_id: null, tmdb_type: null, imdb_id: null });
  return titles;
}

function startMock() {
  const catalog = makeCatalog();
  let quotaUsed = 100;
  let rateLimitedOnce = false;
  const hits = { watchmode: 0, tmdb: 0, seerr: 0, wmAuthFails: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.startsWith('/wm/')) {
      hits.watchmode += 1;
      if (req.headers['x-api-key'] !== KEYS.WATCHMODE_API_KEY) { hits.wmAuthFails += 1; return send(401, { success: false }); }
      if (url.pathname === '/wm/status/') return send(200, { quota: 2500, quotaUsed }, { 'x-ratelimit-limit': '120' });
      if (url.pathname === '/wm/list-titles/') {
        const page = Number(url.searchParams.get('page'));
        if (page === 2 && !rateLimitedOnce) { rateLimitedOnce = true; return send(429, { statusMessage: 'slow down' }, { 'retry-after': '0' }); }
        quotaUsed += 1;
        const per = 3; // tiny pages so paging is exercised
        const slice = catalog.slice((page - 1) * per, page * per);
        if (page === 2) slice.push(catalog[0]); // duplicate across pages
        return send(200, { titles: slice, page, total_results: catalog.length, total_pages: Math.ceil(catalog.length / per) });
      }
      return send(404, {});
    }

    if (url.pathname.startsWith('/tmdb/')) {
      hits.tmdb += 1;
      if (req.headers.authorization !== `Bearer ${KEYS.TMDB_READ_TOKEN}`) return send(401, {});
      const p = url.pathname.slice(5);
      if (p === '/watch/providers/movie') return send(200, { results: [{ provider_id: 8, provider_name: 'Netflix' }, { provider_id: 1796, provider_name: 'Netflix basic with Ads' }] });
      if (p === '/discover/movie') return send(200, { page: 1, total_pages: 10, total_results: 4321, results: [] });
      if (p === '/discover/tv') return send(200, { page: 1, total_pages: 5, total_results: 1234, results: [] });
      const m = p.match(/^\/(movie|tv)\/(\d+)$/);
      if (m) {
        if (m[2] === '503') return send(404, { status_message: 'not found' });
        return send(200, {
          id: Number(m[2]), title: `T${m[2]}`, original_language: m[2] === '502' ? 'ko' : 'en',
          vote_average: 7.1, vote_count: Number(m[2]), genres: [{ id: 1, name: 'Drama' }],
          keywords: { keywords: [{ id: 1, name: 'heist' }] }, poster_path: '/p.jpg', runtime: 100,
        });
      }
      return send(404, {});
    }

    if (url.pathname.startsWith('/api/v1/')) {
      hits.seerr += 1;
      if (req.headers['x-api-key'] !== KEYS.SEERR_API_KEY) return send(403, {});
      const p = url.pathname;
      if (p === '/api/v1/status') return send(200, { version: '3.4.1', commitTag: 'v3.4.1' });
      if (p === '/api/v1/auth/me') return send(200, { id: 1, email: 'lee@example.com', plexToken: 'abc', userType: 2, permissions: 2 });
      if (p === '/api/v1/settings/public') return send(200, { mediaServerType: 1, partialRequestsEnabled: true });
      if (p === '/api/v1/media') return send(200, { pageInfo: { results: 2 }, results: [
        { id: 1, mediaType: 'movie', tmdbId: 501, status: 5, seasons: [] },
        { id: 2, mediaType: 'tv', tmdbId: 900, status: 4, seasons: [{ seasonNumber: 1, status: 5 }] },
      ] });
      if (p === '/api/v1/request') return send(200, { pageInfo: { results: 1 }, results: [
        { id: 7, status: 2, requestedBy: { id: 1, email: 'lee@example.com', avatar: '/a.png' } },
      ] });
      if (p.startsWith('/api/v1/movie/')) return send(200, { id: 501, mediaInfo: { status: 5, tmdbId: 501 } });
      if (p.startsWith('/api/v1/tv/')) return send(200, { id: 900, seasons: [{}, {}], mediaInfo: { status: 4 } });
      return send(404, {});
    }
    send(404, {});
  });

  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => resolveStart({ server, port: server.address().port, hits }));
  });
}

function runSpike(env, out) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(root, 'scripts/spike.mjs'), '--out', out, '--sample', '10'], {
      cwd: out, // no .env here
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolveRun({ code, stdout }));
  });
}

function allFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

test('spike runs end to end, counts correctly, and leaks no secrets', async () => {
  const { server, port, hits } = await startMock();
  const out = mkdtempSync(join(tmpdir(), 'spike-'));
  try {
    const { code, stdout } = await runSpike({
      ...KEYS,
      WATCHMODE_BASE: `http://127.0.0.1:${port}/wm`,
      TMDB_BASE: `http://127.0.0.1:${port}/tmdb`,
      SEERR_URL: `http://127.0.0.1:${port}`,
      WATCHMODE_DELAY_MS: '0',
      TMDB_DELAY_MS: '0',
    }, out);

    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    const w = report.findings.watchmode;

    assert.equal(hits.wmAuthFails, 0, 'Watchmode key sent in header');
    assert.equal(w.unique_titles, 7);
    assert.equal(w.duplicates_across_pages, 1);
    assert.equal(w.total_pages, 3);
    assert.equal(w.complete_crawl, true, `crawl should survive one 429; output:\n${stdout}`);
    assert.equal(w.credits_used_this_run, 3);
    assert.equal(w.titles_without_tmdb_id, 1);
    assert.deepEqual(w.by_type, { movie: 5, tv_series: 1, tv_special: 1 });

    const t = report.findings.tmdb_sample;
    assert.equal(t.sampled, 6);
    assert.equal(t.not_found, 1);
    assert.equal(t.matched, 5);
    assert.equal(report.findings.tmdb_discover_netflix_us.movie, 4321);
    assert.ok(report.findings.tmdb_netflix_providers.some((p) => p.provider_id === 8));

    assert.equal(report.findings.seerr_status.version, '3.4.1');
    assert.deepEqual(report.findings.seerr_media.status_values_seen, { 4: 1, 5: 1 });
    assert.equal(report.findings.seerr_tv_lookup.has_mediaInfo, true);
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(code, 0);

    // No key, token, or email anywhere in the output.
    for (const f of allFiles(out)) {
      const text = readFileSync(f, 'utf8');
      for (const secret of Object.values(KEYS)) assert.ok(!text.includes(secret), `${f} contains a key`);
      assert.ok(!text.includes('lee@example.com'), `${f} contains an email`);
      assert.ok(!text.includes('"abc"'), `${f} contains a plex token`);
    }
    assert.ok(readFileSync(join(out, 'report.md'), 'utf8').includes('Netflix US titles: **7**'));
  } finally {
    server.close();
  }
});

test('spike without keys skips sections and does not crash', async () => {
  const out = mkdtempSync(join(tmpdir(), 'spike-nokeys-'));
  const { code, stdout } = await runSpike({}, out);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /Missing in environment/);
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  assert.deepEqual(report.findings, {});
});
