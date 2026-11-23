import { Link } from 'react-router-dom';
import { Icons } from '../components/icons';
const ChevronRightIcon = Icons.chevronRight;
import { useMeta, useThemes } from '../lib/api';
import { longDate, relativeTime } from '../lib/format';
import { Badge, PageTitle, Spinner } from '../components/ui';

const healthBadge: Record<string, ['success' | 'warning' | 'default', string]> = {
  ok: ['success', 'Healthy'], starting: ['default', 'Starting'], held: ['warning', 'Sync held'], failing: ['warning', 'Sync failing'], stale: ['warning', 'Sync overdue'],
};

export function More() {
  const meta = useMeta();
  const themes = useThemes();
  const m = meta.data;
  return (
    <>
      <PageTitle>More</PageTitle>
      <div className="mb-8 max-w-xl space-y-3">
        {m?.downloads?.configured !== false && <DownloadsLink d={m?.downloads} />}
        <Link to="/library" className="flex items-center gap-4 rounded-xl border border-line-strong bg-surface px-4 py-3.5 transition hover:bg-raised">
          <Icons.library className="h-6 w-6 flex-shrink-0 text-white" />
          <span className="min-w-0 flex-1">
            <span className="block type-label-strong text-white">Library</span>
            <span className="block truncate type-body-small text-ink-tertiary">
              {m?.library?.configured ? `${m.library.movies.toLocaleString()} movies · ${m.library.series.toLocaleString()} series in Jellyfin` : 'What you already have in Jellyfin'}
            </span>
          </span>
          <ChevronRightIcon className="h-5 w-5 flex-shrink-0 text-ink-muted" />
        </Link>
        <Link to="/lists" className="flex items-center gap-4 rounded-xl border border-line-strong bg-surface px-4 py-3.5 transition hover:bg-raised">
          <Icons.sparkles className="h-6 w-6 flex-shrink-0 text-white" />
          <span className="min-w-0 flex-1">
            <span className="block type-label-strong text-white">Recommendation lists</span>
            <span className="block truncate type-body-small text-ink-tertiary">
              {m?.lists?.configured ? (m.lists.picked ? `${m.lists.picked} on Discover, from MDBList` : 'Pick lists from MDBList for Discover') : 'Rows on Discover from MDBList lists'}
            </span>
          </span>
          <ChevronRightIcon className="h-5 w-5 flex-shrink-0 text-ink-muted" />
        </Link>
      </div>
      {themes.data && themes.data.length > 0 && (
        <section className="mb-8 max-w-xl">
          <h2 className="mb-3 text-xl font-bold text-gray-200">Collections</h2>
          <ul className="media-facts">
            {themes.data.map((t) => (
              <li key={t.slug}>
                <Link to={`/browse?theme=${t.slug}`} className="media-fact items-center transition hover:bg-gray-800">
                  <span>{t.title}</span>
                  <span className="flex items-center gap-1 text-sm font-normal text-gray-400">
                    {t.count.toLocaleString()} <ChevronRightIcon className="h-5 w-5" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <h2 className="mb-3 text-xl font-bold text-gray-200">Catalog</h2>
      {!m ? <div className="flex justify-center py-16"><Spinner /></div> : (
        <div className="media-facts max-w-xl">
          <div className="media-fact"><span>Sync</span><span className="media-fact-value"><Badge type={(healthBadge[m.health] ?? healthBadge.stale!)[0]}>{(healthBadge[m.health] ?? healthBadge.stale!)[1]}</Badge></span></div>
          <div className="media-fact"><span>Last sync</span><span className="media-fact-value">{relativeTime(m.lastSyncAt) ?? 'Not yet'}</span></div>
          <div className="media-fact"><span>Tracking since</span><span className="media-fact-value">{longDate(m.trackingSince) ?? '—'}</span></div>
          <div className="media-fact"><span>Titles shown</span><span className="media-fact-value">{m.eligible.toLocaleString()}</span></div>
          <div className="media-fact"><span>New this week</span><span className="media-fact-value">{m.newThisWeek.toLocaleString()}</span></div>
          <div className="media-fact"><span>Languages</span><span className="media-fact-value">{m.languageRule === 'en' ? 'English-original only' : 'All languages'}</span></div>
          {m.ops && (
            <>
              <div className="media-fact">
                <span>Last backup</span>
                <span className="media-fact-value">
                  {m.ops.backupError ? <Badge type="warning">Failed</Badge> : relativeTime(m.ops.lastBackupAt) ?? 'Not yet'}
                </span>
              </div>
              <div className="media-fact">
                <span>Matches TMDB’s list</span>
                <span className="media-fact-value">
                  {!m.ops.crosscheck ? 'Not checked yet' : !m.ops.crosscheck.ok ? <Badge type="warning">Check failed</Badge>
                    : `${m.ops.crosscheck.coveragePct}% · ${relativeTime(m.ops.crosscheck.at)}`}
                </span>
              </div>
              <div className="media-fact"><span>Alerts</span><span className="media-fact-value">{m.ops.alerts ? 'On (ntfy)' : 'Off'}</span></div>
            </>
          )}
        </div>
      )}
      <p className="mt-6 max-w-xl text-sm text-gray-400">
        MonkeySee checks your services’ movies every morning at 6:23 and their series once a week. A title’s date added is the first day it appeared after tracking began (for a new series, its premiere). Prime Video, rent or buy and coming soon come from JustWatch via TMDB.
        Every Sunday it compares the list with TMDB’s, which comes from JustWatch.
      </p>
    </>
  );
}

/** Figma "More page" first row: Downloads, with the same red count as the More tab. */
function DownloadsLink({ d }: { d?: { attention: number; downloading: number } }) {
  const line = d ? [d.downloading ? `${d.downloading} downloading` : null, d.attention ? `${d.attention} need${d.attention === 1 ? 's' : ''} attention` : null].filter(Boolean).join(' · ') || 'Nothing downloading' : 'Torrents and your requests';
  return (
    <Link to="/downloads" className="flex items-center gap-4 rounded-xl border border-line-strong bg-surface px-4 py-3.5 transition hover:bg-raised">
      <Icons.download className="h-6 w-6 flex-shrink-0 text-white" />
      <span className="min-w-0 flex-1">
        <span className="block type-label-strong text-white">Downloads</span>
        <span className={`block truncate type-body-small ${d?.attention ? 'text-yellow-300' : 'text-ink-tertiary'}`}>{line}</span>
      </span>
      {d?.attention ? <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-red-500 px-1.5 type-badge-tag text-white">{d.attention}</span> : null}
      <ChevronRightIcon className="h-5 w-5 flex-shrink-0 text-ink-muted" />
    </Link>
  );
}
