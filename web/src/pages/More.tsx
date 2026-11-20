import { useMeta } from '../lib/api';
import { longDate, relativeTime } from '../lib/format';
import { Badge, Credits, PageTitle, Spinner } from '../components/ui';

const healthBadge: Record<string, ['success' | 'warning' | 'default', string]> = {
  ok: ['success', 'Healthy'], starting: ['default', 'Starting'], held: ['warning', 'Sync held'], failing: ['warning', 'Sync failing'], stale: ['warning', 'Sync overdue'],
};

export function More() {
  const meta = useMeta();
  const m = meta.data;
  return (
    <>
      <PageTitle>More</PageTitle>
      {!m ? <div className="flex justify-center py-16"><Spinner /></div> : (
        <div className="media-facts max-w-xl">
          <div className="media-fact"><span>Sync</span><span className="media-fact-value"><Badge type={(healthBadge[m.health] ?? healthBadge.stale!)[0]}>{(healthBadge[m.health] ?? healthBadge.stale!)[1]}</Badge></span></div>
          <div className="media-fact"><span>Last sync</span><span className="media-fact-value">{relativeTime(m.lastSyncAt) ?? 'Not yet'}</span></div>
          <div className="media-fact"><span>Tracking since</span><span className="media-fact-value">{longDate(m.trackingSince) ?? '—'}</span></div>
          <div className="media-fact"><span>Titles shown</span><span className="media-fact-value">{m.eligible.toLocaleString()}</span></div>
          <div className="media-fact"><span>New this week</span><span className="media-fact-value">{m.newThisWeek.toLocaleString()}</span></div>
          <div className="media-fact"><span>Languages</span><span className="media-fact-value">{m.languageRule === 'en' ? 'English-original only' : 'All languages'}</span></div>
        </div>
      )}
      <p className="mt-6 max-w-xl text-sm text-gray-400">
        NetFlarrrx checks Netflix’s catalog once a day at 6:23 a.m. A title’s date added is the first day it appeared after tracking began.
      </p>
      <Credits />
    </>
  );
}
