// Command line for running jobs by hand, e.g. inside the container:
//   docker exec netflarrrx node dist/cli.js status
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { confirmHeldRun, recentRuns } from './sync/catalog.js';
import { setLogLevel } from './log.js';
import { browse, home, keywordSearch, libraryOverview, themePreview, themesFor } from './catalog/queries.js';

const USAGE = `Usage: cli <command>
  status            catalog counts, health and the last 10 sync runs
  sync              run sync -> enrich -> Seerr mirror now (uses ~29 Watchmode credits)
  confirm <run-id>  apply a held sync run
  enrich            fetch TMDB details for titles that need them
  seerr-mirror      refresh the Seerr status mirror
  themes [slug]     thematic rows: counts, which keywords do the work, sample titles
  keywords <text>   TMDB keywords containing <text>, with how many shown titles have each
  backup            take a verified database backup now
  crosscheck        compare our Netflix list with TMDB's (free, ~1 minute)
  alert-test        send a test alert to ALERT_URL
  alerts            show what would alert right now
  recs              refresh your library from Seerr and show the top recommendations
  library           each library title: stand-up, movie or series, and its Netflix matches`;

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); return; }
  const cfg = loadConfig({ ...process.env, RUN_SCHEDULER: 'false' });
  setLogLevel(cfg.LOG_LEVEL);
  const app = createApp(cfg);
  try {
    switch (cmd) {
      case 'status': {
        const h = app.health();
        console.log(JSON.stringify({ status: h.status, reason: h.reason, last_applied_sync_at: h.last_applied_sync_at, stats: h.stats }, null, 2));
        console.table(recentRuns(app.db, 10).map((r) => ({
          id: r.id, status: r.status, started: r.started_at.slice(0, 16), titles: r.titles_seen, added: r.added,
          missed: r.missed, removed: r.removed, note: (r.note ?? '').slice(0, 60),
        })));
        break;
      }
      case 'sync': console.log(JSON.stringify(await app.pipeline('cli'), null, 2)); break;
      case 'confirm': {
        const id = Number(arg);
        if (!Number.isInteger(id)) throw new Error('confirm needs a run id');
        console.log(JSON.stringify(confirmHeldRun(app.db, cfg, id), null, 2));
        await app.enrich();
        break;
      }
      case 'enrich': console.log(JSON.stringify(await app.enrich(), null, 2)); break;
      case 'seerr-mirror': console.log(JSON.stringify(await app.mirror(), null, 2)); break;
      case 'themes': {
        const list = themesFor(cfg).filter((t) => !arg || t.slug === arg);
        if (!list.length) throw new Error(`No theme "${arg}". Themes: ${themesFor(cfg).map((t) => t.slug).join(', ')}`);
        for (const t of list) {
          const p = themePreview(app.db, cfg, t, arg ? 40 : 12);
          console.log(`\n${t.title} (${t.slug})${t.home ? '' : ' [not on Discover]'}: ${p.n} titles, ${p.movies} movies, ${p.series} series, ${p.dated} dated`);
          if (p.bySignal.length) console.table(p.bySignal);
          console.table(p.items.map((i) => ({
            title: i.title.slice(0, 44), year: i.year, kind: i.kind, rating: i.vote_average, votes: i.vote_count,
            length: i.kind === 'movie' ? (i.runtime ? `${i.runtime}m` : '') : (i.seasons ? `${i.seasons}s` : ''),
          })));
        }
        break;
      }
      case 'keywords': {
        if (!arg) throw new Error('keywords needs some text, e.g. keywords heist');
        console.table(keywordSearch(app.db, cfg, arg));
        break;
      }
      case 'backup': console.log(JSON.stringify(await app.backup(), null, 2)); break;
      case 'crosscheck': {
        const x = await app.crosscheck();
        if (!x.ok) throw new Error(`cross-check failed: ${x.error}`);
        console.log(`TMDB lists ${x.tmdbTotal} titles on Netflix; we list ${x.oursTotal}; ${x.both} in both.`);
        console.log(`We have ${x.coveragePct}% of TMDB's list (alert below ${cfg.CROSSCHECK_MIN_PCT}%); TMDB has ${x.agreementPct}% of ours (alert below ${cfg.CROSSCHECK_MIN_AGREE_PCT}%).`);
        console.table(x.byType);
        console.log('\nMost popular titles TMDB has that we don\'t (check a few on JustWatch or Netflix):');
        console.table(x.onlyTmdb?.slice(0, 15));
        console.log('\nMost popular titles we have that TMDB doesn\'t:');
        console.table(x.onlyOurs?.slice(0, 15));
        break;
      }
      case 'alert-test': {
        if (!app.notifier.enabled) throw new Error('ALERT_URL is not set in netflarrrx.env');
        await app.notifier.send('Test alert', 'If you can read this, NetFlarrrx alerts work.', 'test');
        console.log('Sent.');
        break;
      }
      case 'recs': {
        const lib = await app.library();
        console.log(`Library: ${lib.library} titles (Radarr ${lib.sources.radarr}, Sonarr ${lib.sources.sonarr}, Seerr ${lib.sources.seerr}); ${lib.added} new, ${lib.removed} gone, ${lib.fetched} fetched from TMDB, ${lib.errors} errors.`);
        if (lib.sources.radarr === 'off' || lib.sources.sonarr === 'off') console.log('Tip: add RADARR_API_KEY and SONARR_API_KEY to netflarrrx.env so the whole library counts.');
        const top = browse(app.db, cfg, { theme: 'for-you' });
        console.log(`\nRecommended for you: ${top.total} Netflix titles. Top 20:`);
        console.table(top.items.slice(0, 20).map((i) => ({ title: i.title.slice(0, 44), year: i.year, kind: i.kind, rating: i.voteAverage })));
        console.log('\n"Because you have" rows on Discover:');
        for (const r of home(app.db, cfg).rows.filter((r) => r.slug.startsWith('because-'))) console.log(`  ${r.title} (${r.total} titles)`);
        break;
      }
      case 'library': {
        const rows = libraryOverview(app.db, cfg);
        const by = (c: string) => rows.filter((r) => r.category === c).length;
        console.log(`${rows.length} titles: ${by('standup')} stand-up, ${by('movie')} movies, ${by('series')} series. Rows need 5+ matches.`);
        console.table(rows.slice(0, 40).map((r) => ({ title: r.title.slice(0, 44), category: r.category, source: r.source, matches: r.matches, 'specials %': r.specials_pct })));
        break;
      }
      case 'alerts': console.log(JSON.stringify({ alertUrlSet: app.notifier.enabled, problems: app.problems() }, null, 2)); break;
      default: console.error(`Unknown command: ${cmd}\n${USAGE}`); process.exitCode = 2;
    }
  } finally {
    app.close();
  }
}

main().catch((err) => { console.error((err as Error).message); process.exit(1); });
