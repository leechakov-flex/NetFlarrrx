import { useMeta } from '../lib/api';
import { longDate, relativeTime } from '../lib/format';
import { BackButton } from '../components/Layout';
import { Badge, LoadError, Spinner } from '../components/ui';

const healthBadge: Record<string, ['success' | 'warning' | 'default', string]> = {
  ok: ['success', 'Healthy'], starting: ['default', 'Starting'], held: ['warning', 'Sync held'], failing: ['warning', 'Sync failing'], stale: ['warning', 'Sync overdue'],
};

/** Catalog (Figma Build screen 20): sync health, backups and where the data comes from. Opened from the sidebar's Last sync box, or More on phones. */
export function Catalog() {
  const meta = useMeta();
  const m = meta.data;
  if (meta.isError) return <LoadError what="the catalog status" onRetry={() => void meta.refetch()} />;
  return (
    <div className="flex max-w-xl flex-col gap-3 pt-4">
      <BackButton className="lg:hidden" />
      <h1 className="type-heading-page text-ink-primary">Catalog</h1>
      {!m ? <div className="flex justify-center py-16"><Spinner /></div> : (
        <div className="media-facts">
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
      <p className="mt-3 type-body-small text-ink-tertiary">
        MonkeySee checks your services’ movies every morning at 6:23 and their series once a week. A title’s date added is the first day it appeared after tracking began (for a new series, its premiere). Prime Video, rent or buy and coming soon come from JustWatch via TMDB.
        Every Sunday it compares the list with TMDB’s, which comes from JustWatch.
      </p>
    </div>
  );
}
