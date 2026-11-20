#!/usr/bin/env node
// M0 data spike for NetFlarrrx.
//
// Read-only. Answers the M0 questions from the plan:
//   - Watchmode quota and how many credits a full Netflix US sync costs
//   - Netflix US catalog size and type breakdown
//   - TMDB ID coverage, original-language mix, vote counts (sampled)
//   - TMDB's own Netflix-US counts, as a cross-check
//   - Seerr version, API-key identity, media status values and field names
//
// It never creates Seerr requests. It writes a sanitized report and fixtures
// to ./spike-output (or --out DIR). Keys are read from the environment or .env
// and are never written to disk or printed.
//
// Usage:  node scripts/spike.mjs [--sample 60] [--max-pages N] [--out DIR] [--skip-crawl]

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------- config ----------

const args = parseArgs(process.argv.slice(2));
loadDotEnv(resolve(process.cwd(), '.env'));

const cfg = {
  watchmodeKey: process.env.WATCHMODE_API_KEY || '',
  tmdbToken: process.env.TMDB_READ_TOKEN || '',
  seerrKey: process.env.SEERR_API_KEY || '',
  seerrUrl: (process.env.SEERR_URL || 'http://monkeyserver.local:5055').replace(/\/+$/, ''),
  watchmodeBase: (process.env.WATCHMODE_BASE || 'https://api.watchmode.com/v1').replace(/\/+$/, ''),
  tmdbBase: (process.env.TMDB_BASE || 'https://api.themoviedb.org/3').replace(/\/+$/, ''),
  netflixSourceId: 203,
  tmdbNetflixProviderId: 8,
  region: 'US',
  pageSize: 250,
  sample: Number(args.sample ?? 60),
  maxPages: args['max-pages'] ? Number(args['max-pages']) : Infinity,
  skipCrawl: Boolean(args['skip-crawl']),
  out: resolve(args.out || 'spike-output'),
  watchmodeDelayMs: Number(process.env.WATCHMODE_DELAY_MS ?? 600), // free plan: 120 req/min
  tmdbDelayMs: Number(process.env.TMDB_DELAY_MS ?? 60),
};

const SECRETS = [cfg.watchmodeKey, cfg.tmdbToken, cfg.seerrKey].filter((s) => s && s.length >= 8);

const report = {
  generated_at: new Date().toISOString(),
  spike_version: 1,
  node: process.version,
  checks: {},
  findings: {},
  errors: [],
};

// ---------- main ----------

async function main() {
  const missing = [
    ['WATCHMODE_API_KEY', cfg.watchmodeKey],
    ['TMDB_READ_TOKEN', cfg.tmdbToken],
    ['SEERR_API_KEY', cfg.seerrKey],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    log(`Missing in environment or .env: ${missing.join(', ')}. Sections that need them will be skipped.`);
  }

  mkdirSync(join(cfg.out, 'fixtures'), { recursive: true });

  let titles = [];
  if (cfg.watchmodeKey) titles = await watchmodeSection();
  if (cfg.tmdbToken) await tmdbSection(titles);
  if (cfg.seerrKey) await seerrSection(titles);

  writeJson('report.json', report);
  writeFileSync(join(cfg.out, 'report.md'), renderMarkdown(report));
  log(`\nDone. Report: ${join(cfg.out, 'report.md')}`);
  log(`Send me the whole ${cfg.out} folder (zip it) — it contains no keys.`);
  if (report.errors.length) {
    log(`${report.errors.length} error(s) recorded; see report.`);
    process.exitCode = 1;
  }
}

// ---------- Watchmode ----------

async function watchmodeSection() {
  log('Watchmode: checking quota (0 credits)…');
  const before = await wm('/status/');
  if (!before.ok) return [];
  saveFixture('watchmode/status.json', before.body);
  report.checks.watchmode_status_before = pick(before.body, ['quota', 'quotaUsed']);
  report.checks.watchmode_rate_headers = pickHeaders(before.headers, [
    'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-account-quota', 'x-account-quota-used',
  ]);

  if (cfg.skipCrawl) {
    log('Watchmode: --skip-crawl set; not listing titles.');
    return [];
  }

  log('Watchmode: crawling Netflix US (1 credit per page)…');
  const titles = [];
  const seen = new Map();
  let page = 1;
  let totalPages = 1;
  let totalResults = null;
  let duplicates = 0;
  let failedPages = [];

  while (page <= totalPages && page <= cfg.maxPages) {
    const q = new URLSearchParams({
      source_ids: String(cfg.netflixSourceId),
      regions: cfg.region,
      sort_by: 'title_asc',
      limit: String(cfg.pageSize),
      page: String(page),
    });
    const res = await wm(`/list-titles/?${q}`, { retries: 3 });
    if (!res.ok) {
      failedPages.push(page);
      page += 1;
      continue;
    }
    const body = res.body || {};
    totalPages = Number(body.total_pages ?? totalPages);
    totalResults = Number(body.total_results ?? totalResults);
    if (page <= 2) saveFixture(`watchmode/list-titles.page${page}.json`, body);
    for (const t of body.titles || []) {
      if (seen.has(t.id)) { duplicates += 1; continue; }
      seen.set(t.id, true);
      titles.push(t);
    }
    process.stdout.write(`\r  page ${page}/${totalPages} — ${titles.length} titles`);
    page += 1;
  }
  process.stdout.write('\n');

  const after = await wm('/status/');
  if (after.ok) report.checks.watchmode_status_after = pick(after.body, ['quota', 'quotaUsed']);

  const pagesFetched = Math.min(totalPages, cfg.maxPages);
  const byType = countBy(titles, (t) => t.type ?? 'unknown');
  const noTmdb = titles.filter((t) => !t.tmdb_id).length;
  const tmdbTypeMismatch = titles.filter((t) => t.tmdb_id && !['movie', 'tv'].includes(t.tmdb_type)).length;
  const fields = unionKeys(titles.slice(0, 500));

  const creditsUsed = (report.checks.watchmode_status_after?.quotaUsed ?? NaN) -
    (report.checks.watchmode_status_before?.quotaUsed ?? NaN);

  report.findings.watchmode = {
    total_results_reported: totalResults,
    total_pages: totalPages,
    pages_fetched: pagesFetched,
    failed_pages: failedPages,
    unique_titles: titles.length,
    duplicates_across_pages: duplicates,
    complete_crawl: failedPages.length === 0 && pagesFetched >= totalPages,
    credits_used_this_run: Number.isFinite(creditsUsed) ? creditsUsed : null,
    credits_per_full_sync_estimate: totalPages,
    monthly_credits_daily_sync_estimate: totalPages * 30,
    by_type: byType,
    titles_without_tmdb_id: noTmdb,
    titles_without_tmdb_id_pct: pct(noTmdb, titles.length),
    titles_with_unexpected_tmdb_type: tmdbTypeMismatch,
    list_titles_fields: fields,
  };

  // Compact full catalog snapshot: the first real "day 0" for diff tests.
  saveFixture('watchmode/catalog-snapshot.json', titles.map((t) => pick(t, [
    'id', 'title', 'year', 'type', 'tmdb_id', 'tmdb_type', 'imdb_id',
  ])));
  return titles;
}

// ---------- TMDB ----------

async function tmdbSection(titles) {
  log('TMDB: checking the Netflix provider ID for US…');
  const prov = await tmdb(`/watch/providers/movie?watch_region=${cfg.region}`);
  if (prov.ok) {
    const nf = (prov.body.results || []).filter((p) => /netflix/i.test(p.provider_name));
    report.findings.tmdb_netflix_providers = nf.map((p) => pick(p, ['provider_id', 'provider_name']));
  }

  log('TMDB: Netflix-US counts from discover (cross-check)…');
  const counts = {};
  for (const kind of ['movie', 'tv']) {
    const q = new URLSearchParams({
      with_watch_providers: String(cfg.tmdbNetflixProviderId),
      watch_region: cfg.region,
      with_watch_monetization_types: 'flatrate',
      page: '1',
    });
    const r = await tmdb(`/discover/${kind}?${q}`);
    if (r.ok) {
      counts[kind] = r.body.total_results ?? null;
      if (kind === 'movie') saveFixture('tmdb/discover-movie-netflix-us.page1.json', trimDiscover(r.body));
    }
  }
  report.findings.tmdb_discover_netflix_us = counts;

  const candidates = titles.filter((t) => t.tmdb_id && ['movie', 'tv'].includes(t.tmdb_type));
  if (!candidates.length) {
    log('TMDB: no Watchmode titles to sample (crawl skipped or failed).');
    return;
  }

  const sample = sampleEvenly(candidates, cfg.sample);
  log(`TMDB: fetching details for ${sample.length} sampled titles…`);
  const rows = [];
  let notFound = 0;
  let savedMovie = false;
  let savedTv = false;
  for (const t of sample) {
    const r = await tmdb(`/${t.tmdb_type}/${t.tmdb_id}?append_to_response=keywords`, { quiet404: true });
    if (r.status === 404) { notFound += 1; continue; }
    if (!r.ok) continue;
    const d = r.body;
    const keywords = (d.keywords?.keywords || d.keywords?.results || []).map((k) => k.name);
    rows.push({
      watchmode_id: t.id,
      tmdb_type: t.tmdb_type,
      tmdb_id: t.tmdb_id,
      title: d.title || d.name,
      original_language: d.original_language,
      vote_average: d.vote_average,
      vote_count: d.vote_count,
      genres: (d.genres || []).map((g) => g.name),
      keyword_count: keywords.length,
      runtime: d.runtime ?? null,
      seasons: d.number_of_seasons ?? null,
      has_poster: Boolean(d.poster_path),
    });
    if (t.tmdb_type === 'movie' && !savedMovie) { saveFixture('tmdb/movie-detail.json', d); savedMovie = true; }
    if (t.tmdb_type === 'tv' && !savedTv) { saveFixture('tmdb/tv-detail.json', d); savedTv = true; }
  }
  saveFixture('tmdb/sample-summary.json', rows);

  const votes = rows.map((r) => r.vote_count ?? 0).sort((a, b) => a - b);
  report.findings.tmdb_sample = {
    sampled: sample.length,
    matched: rows.length,
    not_found: notFound,
    match_rate_pct: pct(rows.length, sample.length),
    original_language: countBy(rows, (r) => r.original_language ?? 'unknown'),
    english_original_pct: pct(rows.filter((r) => r.original_language === 'en').length, rows.length),
    vote_count_p25: quantile(votes, 0.25),
    vote_count_median: quantile(votes, 0.5),
    vote_count_p75: quantile(votes, 0.75),
    no_keywords: rows.filter((r) => r.keyword_count === 0).length,
    no_poster: rows.filter((r) => !r.has_poster).length,
  };
}

// ---------- Seerr ----------

async function seerrSection(titles) {
  log(`Seerr: read-only checks against ${cfg.seerrUrl}…`);
  const status = await seerr('/api/v1/status');
  if (!status.ok) {
    log('Seerr: not reachable. From a Mac use http://monkeyserver.local:5055; inside the compose network use http://seerr:5055.');
    return;
  }
  report.findings.seerr_status = pick(status.body, ['version', 'commitTag', 'updateAvailable', 'commitsBehind']);

  const me = await seerr('/api/v1/auth/me');
  if (me.ok) {
    report.findings.seerr_api_key_user = {
      id: me.body.id,
      userType: me.body.userType,
      permissions: me.body.permissions,
    };
  }

  const pub = await seerr('/api/v1/settings/public');
  if (pub.ok) {
    report.findings.seerr_public_settings = pick(pub.body, [
      'mediaServerType', 'partialRequestsEnabled', 'enableSpecialEpisodes', 'movie4kEnabled', 'series4kEnabled', 'region', 'originalLanguage',
    ]);
  }

  const media = await seerr('/api/v1/media?take=50&skip=0&sort=modified');
  if (media.ok) {
    const results = media.body.results || [];
    saveFixture('seerr/media.page1.json', { pageInfo: media.body.pageInfo, results: results.slice(0, 20) });
    report.findings.seerr_media = {
      page_info: media.body.pageInfo,
      status_values_seen: countBy(results, (m) => String(m.status)),
      media_types_seen: countBy(results, (m) => m.mediaType ?? 'missing'),
      fields: unionKeys(results),
      season_fields: unionKeys(results.flatMap((m) => m.seasons || [])),
    };
  }

  const reqs = await seerr('/api/v1/request?take=10&skip=0&sort=added');
  if (reqs.ok) {
    const results = reqs.body.results || [];
    saveFixture('seerr/request.page1.json', { pageInfo: reqs.body.pageInfo, results });
    report.findings.seerr_requests = {
      page_info: reqs.body.pageInfo,
      status_values_seen: countBy(results, (r) => String(r.status)),
      fields: unionKeys(results),
    };
  }

  // One movie and one series lookup by TMDB ID, using titles from the crawl when available.
  const movie = titles.find((t) => t.tmdb_type === 'movie' && t.tmdb_id) || { tmdb_id: 550 };
  const tv = titles.find((t) => t.tmdb_type === 'tv' && t.tmdb_id) || { tmdb_id: 1396 };
  const m = await seerr(`/api/v1/movie/${movie.tmdb_id}`);
  if (m.ok) {
    saveFixture('seerr/movie-detail.json', m.body);
    report.findings.seerr_movie_lookup = {
      tmdb_id: movie.tmdb_id,
      has_mediaInfo: Boolean(m.body.mediaInfo),
      mediaInfo_fields: m.body.mediaInfo ? Object.keys(m.body.mediaInfo).sort() : [],
    };
  }
  const s = await seerr(`/api/v1/tv/${tv.tmdb_id}`);
  if (s.ok) {
    saveFixture('seerr/tv-detail.json', s.body);
    report.findings.seerr_tv_lookup = {
      tmdb_id: tv.tmdb_id,
      has_mediaInfo: Boolean(s.body.mediaInfo),
      seasons_listed: (s.body.seasons || []).length,
      mediaInfo_fields: s.body.mediaInfo ? Object.keys(s.body.mediaInfo).sort() : [],
    };
  }
}

// ---------- HTTP ----------

let lastWm = 0;
async function wm(path, opts = {}) {
  const wait = cfg.watchmodeDelayMs - (Date.now() - lastWm);
  if (wait > 0) await sleep(wait);
  lastWm = Date.now();
  return request('watchmode', `${cfg.watchmodeBase}${path}`, { 'X-API-Key': cfg.watchmodeKey }, opts);
}

let lastTmdb = 0;
async function tmdb(path, opts = {}) {
  const wait = cfg.tmdbDelayMs - (Date.now() - lastTmdb);
  if (wait > 0) await sleep(wait);
  lastTmdb = Date.now();
  return request('tmdb', `${cfg.tmdbBase}${path}`, { Authorization: `Bearer ${cfg.tmdbToken}` }, opts);
}

async function seerr(path, opts = {}) {
  return request('seerr', `${cfg.seerrUrl}${path}`, { 'X-Api-Key': cfg.seerrKey }, opts);
}

async function request(service, url, headers, { retries = 1, quiet404 = false } = {}) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { _non_json: text.slice(0, 200) }; }
      if (res.ok) return { ok: true, status: res.status, body, headers: res.headers };
      if (res.status === 404 && quiet404) return { ok: false, status: 404, body, headers: res.headers };
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt <= retries) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      recordError(service, url, `HTTP ${res.status}`, body);
      return { ok: false, status: res.status, body, headers: res.headers };
    } catch (err) {
      if (attempt <= retries) { await sleep(1000 * 2 ** attempt); continue; }
      recordError(service, url, err.name === 'TimeoutError' ? 'timeout' : String(err.cause?.code || err.message));
      return { ok: false, status: 0, body: null, headers: new Headers() };
    }
  }
}

function recordError(service, url, message, body) {
  const entry = { service, url: scrubUrl(url), error: message };
  if (body) entry.body = sanitize(body);
  report.errors.push(entry);
  log(`  ! ${service}: ${message} — ${entry.url}`);
}

// ---------- sanitizing ----------

const SENSITIVE_KEY = /(e-?mail|token|password|passwd|secret|api_?key|apikey|plex(id|username|token)|jellyfin(userid|username|authtoken|deviceid)|avatar|ip_?address|recoverylink)/i;

export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '<redacted>' : sanitize(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    let s = value;
    for (const secret of SECRETS) s = s.split(secret).join('<redacted>');
    return s;
  }
  return value;
}

function scrubUrl(url) {
  let s = url;
  for (const secret of SECRETS) s = s.split(secret).join('<redacted>');
  return s.replace(/([?&](api_?key|token)=)[^&]*/gi, '$1<redacted>');
}

// ---------- output ----------

function saveFixture(name, data) {
  const path = join(cfg.out, 'fixtures', name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(sanitize(data), null, 2));
}

function writeJson(name, data) {
  writeFileSync(join(cfg.out, name), JSON.stringify(sanitize(data), null, 2));
}

function renderMarkdown(r) {
  const f = r.findings;
  const lines = [`# NetFlarrrx M0 spike report`, '', `Generated ${r.generated_at} with Node ${r.node}.`, ''];
  const w = f.watchmode;
  if (w) {
    lines.push('## Watchmode', '',
      `- Netflix US titles: **${w.unique_titles}** (API reported ${w.total_results_reported}), ${w.total_pages} pages`,
      `- Complete crawl: ${w.complete_crawl ? 'yes' : `no (failed pages: ${w.failed_pages.join(', ') || 'none'}; fetched ${w.pages_fetched})`}`,
      `- Credits used this run: ${w.credits_used_this_run ?? 'unknown'}; estimated per daily sync: ${w.credits_per_full_sync_estimate}; per month: ${w.monthly_credits_daily_sync_estimate}`,
      `- Quota: ${fmtQuota(r.checks.watchmode_status_after || r.checks.watchmode_status_before)}`,
      `- Types: ${fmtCounts(w.by_type)}`,
      `- Without TMDB ID: ${w.titles_without_tmdb_id} (${w.titles_without_tmdb_id_pct}%)`,
      `- Duplicates across pages: ${w.duplicates_across_pages}`, '');
  } else if (r.checks.watchmode_status_before) {
    lines.push('## Watchmode', '', `- Quota: ${fmtQuota(r.checks.watchmode_status_before)} (crawl skipped)`, '');
  }
  if (f.tmdb_sample || f.tmdb_discover_netflix_us) {
    const t = f.tmdb_sample || {};
    lines.push('## TMDB', '',
      `- Netflix provider IDs (US): ${(f.tmdb_netflix_providers || []).map((p) => `${p.provider_id} ${p.provider_name}`).join('; ') || 'n/a'}`,
      `- TMDB discover Netflix US: ${fmtCounts(f.tmdb_discover_netflix_us || {})}`);
    if (f.tmdb_sample) {
      lines.push(
        `- Sample match rate: ${t.matched}/${t.sampled} (${t.match_rate_pct}%)`,
        `- English-original in sample: ${t.english_original_pct}%`,
        `- Languages: ${fmtCounts(t.original_language)}`,
        `- Vote count p25 / median / p75: ${t.vote_count_p25} / ${t.vote_count_median} / ${t.vote_count_p75}`,
        `- No keywords: ${t.no_keywords}; no poster: ${t.no_poster}`);
    }
    lines.push('');
  }
  if (f.seerr_status) {
    lines.push('## Seerr', '',
      `- Version: ${f.seerr_status.version} (${f.seerr_status.commitTag ?? 'n/a'})`,
      `- API key acts as user ${f.seerr_api_key_user?.id ?? '?'} (type ${f.seerr_api_key_user?.userType ?? '?'}, permissions ${f.seerr_api_key_user?.permissions ?? '?'})`,
      `- Media status values seen: ${fmtCounts(f.seerr_media?.status_values_seen || {})} of ${f.seerr_media?.page_info?.results ?? '?'} tracked`,
      `- Request status values seen: ${fmtCounts(f.seerr_requests?.status_values_seen || {})}`,
      `- Movie lookup has mediaInfo: ${f.seerr_movie_lookup?.has_mediaInfo ?? 'n/a'}; TV lookup has mediaInfo: ${f.seerr_tv_lookup?.has_mediaInfo ?? 'n/a'}`, '');
  }
  if (r.errors.length) {
    lines.push('## Errors', '', ...r.errors.map((e) => `- ${e.service}: ${e.error} — ${e.url}`), '');
  }
  return lines.join('\n');
}

// ---------- helpers ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function pickHeaders(headers, names) {
  const out = {};
  for (const n of names) { const v = headers.get(n); if (v !== null) out[n] = v; }
  return out;
}

function countBy(items, fn) {
  const out = {};
  for (const it of items) { const k = fn(it); out[k] = (out[k] || 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function unionKeys(items) {
  const s = new Set();
  for (const it of items) if (it && typeof it === 'object') Object.keys(it).forEach((k) => s.add(k));
  return [...s].sort();
}

function sampleEvenly(items, n) {
  if (items.length <= n) return items.slice();
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function pct(a, b) { return b ? Math.round((1000 * a) / b) / 10 : null; }
function fmtCounts(obj) { return Object.entries(obj).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'; }
function fmtQuota(q) { return q ? `${q.quotaUsed ?? '?'} of ${q.quota ?? '?'} used` : 'unknown'; }
function trimDiscover(b) { return { page: b.page, total_pages: b.total_pages, total_results: b.total_results, results: (b.results || []).slice(0, 5) }; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(msg) { console.log(msg); }

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('spike.mjs')) {
  main().catch((err) => {
    console.error(`Spike failed: ${err.message}`);
    process.exit(1);
  });
}
