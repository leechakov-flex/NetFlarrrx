import { Link } from 'react-router-dom';
import { ChevronRightIcon } from '@heroicons/react/20/solid';
import { useMeta, useThemes } from '../lib/api';
import { longDate, relativeTime } from '../lib/format';
import { Badge, Credits, PageTitle, Spinner } from '../components/ui';

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
        NetFlarrrx checks Netflix’s catalog once a day at 6:23 a.m. A title’s date added is the first day it appeared after tracking began.
        Every Sunday it compares the list with TMDB’s, which comes from JustWatch.
      </p>
      <Credits />
    </>
  );
}
