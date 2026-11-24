import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../components/icons';
const ChevronRightIcon = Icons.chevronRight;
import { useMeta, useThemes } from '../lib/api';
import { relativeTime } from '../lib/format';
import { PageTitle } from '../components/ui';

/** Phone More tab: everything that isn't one of the four main tabs. Desktop has these in the sidebar. */
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
          <Icons.lists className="h-6 w-6 flex-shrink-0 text-white" />
          <span className="min-w-0 flex-1">
            <span className="block type-label-strong text-white">Lists</span>
            <span className="block truncate type-body-small text-ink-tertiary">
              {m?.lists?.configured ? (m.lists.picked ? `${m.lists.picked} on Discover, from MDBList` : 'Pick lists from MDBList for Discover') : 'Rows on Discover from MDBList lists'}
            </span>
          </span>
          <ChevronRightIcon className="h-5 w-5 flex-shrink-0 text-ink-muted" />
        </Link>
        <MoreLink to="/collections" icon={Icons.collections} title="Collections" line={themes.data ? `${themes.data.filter((t) => t.count > 0).length} ready-made rows, like Stand-up specials` : 'Ready-made rows, like Stand-up specials'} />
        <MoreLink to="/catalog" icon={Icons.catalog} title="Catalog" line={m ? `Last sync ${relativeTime(m.lastSyncAt) ?? 'not yet'} · ${m.eligible.toLocaleString()} titles` : 'Sync, backups and where the data comes from'} />
      </div>
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

function MoreLink({ to, icon: Icon, title, line }: { to: string; icon: (p: { className?: string }) => ReactElement; title: string; line: string }) {
  return (
    <Link to={to} className="flex items-center gap-4 rounded-xl border border-line-strong bg-surface px-4 py-3.5 transition hover:bg-raised">
      <Icon className="h-6 w-6 flex-shrink-0 text-white" />
      <span className="min-w-0 flex-1">
        <span className="block type-label-strong text-white">{title}</span>
        <span className="block truncate type-body-small text-ink-tertiary">{line}</span>
      </span>
      <ChevronRightIcon className="h-5 w-5 flex-shrink-0 text-ink-muted" />
    </Link>
  );
}
