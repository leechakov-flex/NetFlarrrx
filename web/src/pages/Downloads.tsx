import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, useDownloads, type DownloadItem, type RequestItem } from '../lib/api';
import { ago, bytes, duration, speed } from '../lib/format';
import { useGuardedPost } from '../lib/guardedPost';
import { useToast } from '../components/Feedback';
import { Credits, Empty, PageTitle, Spinner } from '../components/ui';
import { Icons } from '../components/icons';
import { ReleasesSheet } from '../components/ReleasesSheet';

/**
 * Downloads (Figma Build screen 8): what qBittorrent is doing, matched to the
 * movie or episode Radarr or Sonarr wanted it for, with stuck downloads on top,
 * then your Seerr requests. Read only for torrents; requests can be cancelled or retried.
 */
export function Downloads() {
  const q = useDownloads();
  if (q.isPending) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (q.isError) return <Empty>Couldn’t load downloads.</Empty>;
  const d = q.data;
  const downloading = d.downloading.length;
  return (
    <div className="max-w-2xl">
      <PageTitle>Downloads</PageTitle>
      {d.qbit.configured ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Stat><Icons.arrowDown className="h-4 w-4" />{speed(d.qbit.downSpeed)}</Stat>
          <Stat><Icons.arrowUp className="h-4 w-4" />{speed(d.qbit.upSpeed)}</Stat>
          <Stat>{downloading} downloading</Stat>
          {d.queued.length > 0 && <Stat>{d.queued.length} queued</Stat>}
          <Stat>{d.qbit.seeding} seeding</Stat>
          <Stat>
            <span className={`h-2 w-2 rounded-full ${!d.qbit.connected ? 'bg-red-500' : d.qbit.vpn === 'connected' ? 'bg-green-500' : 'bg-yellow-400'}`} />
            {!d.qbit.connected ? 'qBittorrent offline' : d.qbit.vpn === 'connected' ? 'Connected' : d.qbit.vpn === 'firewalled' ? 'Firewalled' : 'Disconnected'}
          </Stat>
        </div>
      ) : (
        <p className="type-body-default text-ink-tertiary">Set QBIT_USERNAME and QBIT_PASSWORD to see what qBittorrent is doing.</p>
      )}
      {d.qbit.configured && d.qbit.error && <p className="mt-3 type-body-default text-yellow-200">{d.qbit.error}.</p>}
      {d.errors.filter((e) => e !== 'qBittorrent').map((e) => (
        <p key={e} className="mt-3 type-body-default text-yellow-200">Couldn’t reach {e}, so some details are missing.</p>
      ))}

      {d.attention.length > 0 && (
        <section className="mt-7">
          <SectionTitle count={d.attention.length}>Needs attention</SectionTitle>
          <div className="divide-y divide-line rounded-xl border border-line-warning-subtle px-3">
            {d.attention.map((it) => <DownloadRow key={it.hash ?? it.name} it={it} attention />)}
          </div>
        </section>
      )}

      {(downloading > 0 || d.queued.length > 0) && (
        <section className="mt-7">
          <SectionTitle count={downloading}>Downloading</SectionTitle>
          <div>{[...d.downloading, ...d.queued].map((it) => <DownloadRow key={it.hash ?? it.name} it={it} />)}</div>
        </section>
      )}
      {d.qbit.connected && d.attention.length === 0 && downloading === 0 && d.queued.length === 0 && (
        <p className="mt-7 type-body-default text-ink-tertiary">Nothing downloading right now.</p>
      )}

      <Requests items={d.requests} />
      <Credits />
    </div>
  );
}

const Stat = ({ children }: { children: React.ReactNode }) => (
  <span className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-app px-3 py-1.5 type-caption-strong text-ink-secondary">{children}</span>
);
const SectionTitle = ({ children, count }: { children: React.ReactNode; count?: number }) => (
  <h2 className="flex h-8 items-baseline gap-2 pb-1 type-heading-section text-ink-secondary">{children}{count ? <span className="type-caption-default text-ink-muted">{count}</span> : null}</h2>
);

function Poster({ url, titleId }: { url: string | null; titleId: number | null }) {
  const img = url ? <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Icons.film className="h-6 w-6 text-ink-muted" />;
  const cls = 'flex h-[66px] w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-md bg-raised ring-1 ring-line';
  return titleId ? <Link to={`/title/${titleId}`} className={cls}>{img}</Link> : <div className={cls}>{img}</div>;
}

const SOURCE = { radarr: 'Radarr', sonarr: 'Sonarr' } as const;

function DownloadRow({ it, attention }: { it: DownloadItem; attention?: boolean }) {
  const pct = Math.floor(it.progress * 100);
  const name = `${it.title}${it.subtitle ? ` · ${it.subtitle.split(' · ')[0]}` : it.year ? ` (${it.year})` : ''}`;
  const meta = [it.source ? SOURCE[it.source] : 'Not from Radarr or Sonarr', it.size ? bytes(it.size) : null,
    it.state === 'metadata' ? 'waiting for torrent info' : attention ? `${it.seeds} seeds, ${it.peers} peers` : it.state === 'downloading' ? `${it.seeds} seeds` : null].filter(Boolean).join(' · ');
  const stuckFor = it.since ? duration((Date.now() - Date.parse(it.since)) / 1000) : null;
  const badge = it.state === 'stalled' ? `Stalled${stuckFor ? ` ${stuckFor}` : ''}` : it.state === 'metadata' ? 'Stuck on metadata' : it.state === 'error' ? 'Failed' : it.message ? 'Warning' : null;
  let line: string;
  if (attention) {
    line = it.message ?? (it.state === 'metadata' ? `Added ${ago(it.since)} · no peers have sent the torrent info yet`
      : it.state === 'error' ? 'qBittorrent stopped it with an error' : `${pct}% · no download in ${stuckFor ?? 'a while'}`);
  } else if (it.state === 'queued' || it.state === 'paused') {
    line = it.state === 'paused' ? `Paused at ${pct}%` : 'Queued · starts when a slot frees up';
  } else if (it.state === 'importing') {
    line = 'Moving files';
  } else {
    line = [`${pct}%`, speed(it.speed), it.etaSeconds ? `${duration(it.etaSeconds)} left` : null].filter(Boolean).join(' · ');
  }
  const bar = it.state !== 'queued' || it.progress > 0;
  return (
    <div className="flex items-center gap-3 py-3">
      <Poster url={it.posterUrl} titleId={it.titleId} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <div className="min-w-0 truncate type-label-strong text-ink-primary" title={it.name}>{name}</div>
          {badge && <span className="flex-shrink-0 rounded-[10px] bg-warning px-2 py-0.5 type-badge-tag text-ink-inverse">{badge}</span>}
        </div>
        <div className="truncate type-body-xsmall text-ink-muted">{meta}</div>
        {bar && (
          <div className="h-1 overflow-hidden rounded-sm bg-raised">
            <div className={`h-full rounded-sm ${attention ? 'bg-warning' : 'bg-accent'}`} style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
        )}
        <div className={`type-body-xsmall ${attention ? 'text-ink-on-warning' : 'text-ink-muted'}`}>{line}</div>
      </div>
    </div>
  );
}

// "Not found" also lists Seerr failures and declines: everything that needs you to step in.
const FILTERS = [['all', 'All'], ['missing', 'Not found'], ['unreleased', 'Not out yet'], ['requested', 'Searching'], ['downloading', 'Downloading'], ['available', 'Available']] as const;
const REQ_BADGE: Record<RequestItem['state'], [string, string]> = {
  requested: ['bg-gray-600 text-ink-primary', 'Searching'], unreleased: ['bg-unreleased text-ink-primary', 'Not out yet'],
  missing: ['bg-not-found text-ink-inverse', 'Not found'], downloading: ['bg-accent text-ink-primary', 'Downloading'],
  available: ['bg-success text-ink-inverse', 'Available'], failed: ['bg-danger text-ink-primary', 'Failed'], declined: ['bg-raised text-ink-tertiary', 'Declined'],
};

function Requests({ items }: { items: RequestItem[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const shown = items.filter((r) => filter === 'all' || r.state === filter || (filter === 'missing' && (r.state === 'failed' || r.state === 'declined')));
  const count = (k: (typeof FILTERS)[number][0]) => (k === 'all' ? items.length : items.filter((r) => r.state === k || (k === 'missing' && (r.state === 'failed' || r.state === 'declined'))).length);
  const chip = (on: boolean) => `flex-shrink-0 rounded-full px-3 py-1.5 type-label-default transition ${on ? 'bg-inverse text-ink-inverse' : 'bg-app text-ink-secondary ring-1 ring-inset ring-line-strong hover:bg-raised'}`;
  return (
    <section className="mt-7">
      <SectionTitle>Your requests</SectionTitle>
      <div className="scrollbar-none -mx-4 lg:-mx-8 pb-2 flex gap-2 overflow-x-auto px-4 lg:px-8" role="group" aria-label="Filter requests">
        {FILTERS.filter(([k]) => k === 'all' || count(k) > 0).map(([k, label]) => (
          <button key={k} type="button" className={chip(filter === k)} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}{k !== 'all' && <span className={filter === k ? 'ml-1.5 opacity-60' : 'ml-1.5 text-ink-muted'}>{count(k)}</span>}
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="py-6 type-body-default text-ink-tertiary">{items.length ? 'None here.' : 'No requests yet. Request a title from its page.'}</p>}
      {shown.map((r) => <RequestRow key={r.id} r={r} />)}
    </section>
  );
}

function RequestRow({ r }: { r: RequestItem }) {
  const post = useGuardedPost();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<null | 'cancel' | 'retry'>(null);
  const [releases, setReleases] = useState(false);
  const [badgeCls, badgeLabel] = REQ_BADGE[r.state];
  const name = `${r.title}${r.year ? ` (${r.year})` : ''}${r.tmdbType === 'tv' && r.seasons.length ? ` · ${r.seasons.length === 1 ? `Season ${r.seasons[0]}` : `${r.seasons.length} seasons`}` : ''}`;
  const line = r.state === 'downloading' ? `Requested ${ago(r.requestedAt)}${r.progress !== null ? ` · ${Math.floor(r.progress * 100)}%` : ''}`
    : r.state === 'requested' || r.state === 'missing' || r.state === 'unreleased' ? [r.state === 'requested' ? `Requested ${ago(r.requestedAt) ?? ''}` : null, r.detail].filter(Boolean).join(' · ')
    : r.detail ?? (r.state === 'available' ? `Available${r.updatedAt ? ` since ${ago(r.updatedAt)}` : ''}` : '');

  async function act(action: 'cancel' | 'retry') {
    setBusy(action);
    try {
      const res = await post(`/api/requests/${r.id}/${action}`);
      if (res === null) return;
      toast('success', action === 'cancel' ? `Cancelled the request for ${r.title}.` : `Sent ${r.title} to ${r.tmdbType === 'movie' ? 'Radarr' : 'Sonarr'} again.`);
      void qc.invalidateQueries();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Couldn’t reach Seerr. Try again in a moment.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center gap-3 py-3">
      <Poster url={r.posterUrl} titleId={r.titleId} />
      {/* Figma request row: pill, title 8px under it, then the status line 4px below. */}
      <div className="min-w-0 flex-1">
        <span className={`inline-block rounded-[10px] px-2 py-0.5 type-badge-tag ${badgeCls}`}>{badgeLabel}</span>
        <div className="mt-2 truncate type-label-strong text-ink-primary">{name}</div>
        <div className="mt-1 truncate type-body-xsmall text-ink-muted">{line}</div>
        {r.state === 'missing' && (
          // Figma "Not found row": the last search's summary, and the Releases sheet.
          <button type="button" onClick={() => setReleases(true)} className="mt-1.5 flex max-w-full items-center gap-1 text-left type-body-xsmall text-ink-on-warning hover:text-ink-primary">
            <span className="truncate">{r.check ? r.check.headline : 'See why: search your indexers'}</span>
            <Icons.chevronRight className="h-3.5 w-3.5 flex-shrink-0" />
          </button>
        )}
        {r.state === 'missing' && r.retried && <div className="mt-0.5 type-body-xsmall text-ink-muted">Searched again {ago(r.retried.at)}{r.retried.count > 1 ? ` · ${r.retried.count} times` : ''}</div>}
      </div>
      {releases && <ReleasesSheet r={r} open={releases} onClose={() => setReleases(false)} />}
      {r.state === 'failed' && (
        <IconButton label={`Retry ${r.title}`} busy={busy === 'retry'} onClick={() => void act('retry')}><Icons.retry className="h-6 w-6" /></IconButton>
      )}
      {(r.state === 'requested' || r.state === 'failed' || r.state === 'missing' || r.state === 'unreleased') && (
        <IconButton label={`Cancel request for ${r.title}`} busy={busy === 'cancel'} onClick={() => void act('cancel')}><Icons.xmark className="h-6 w-6" /></IconButton>
      )}
    </div>
  );
}

const IconButton = ({ label, busy, onClick, children }: { label: string; busy: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button type="button" aria-label={label} title={label} disabled={busy} onClick={onClick}
    className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-ink-secondary transition hover:bg-raised hover:text-white disabled:opacity-50">
    {busy ? <Spinner className="h-5 w-5" /> : children}
  </button>
);
