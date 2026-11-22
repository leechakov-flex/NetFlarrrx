import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, useReleases, type ReleaseItem, type RequestItem } from '../lib/api';
import { ago, bytes } from '../lib/format';
import { useGuardedPost } from '../lib/guardedPost';
import { useToast } from './Feedback';
import { SlideOver } from './SlideOver';
import { Button, Spinner } from './ui';
import { Icons } from './icons';

/**
 * Figma "Releases" (Build screen 14): for a Not found request, what Radarr/Sonarr's
 * indexers have and why each result would be skipped. Pick one to grab it anyway.
 * Opening it runs an interactive search (grabs nothing); results are reused for 30 minutes.
 */
export function ReleasesSheet({ r, open, onClose }: { r: RequestItem; open: boolean; onClose: () => void }) {
  const [fresh, setFresh] = useState(0);
  const q = useReleases(open ? r.id : null, fresh);
  const d = q.data;
  const arr = r.tmdbType === 'movie' ? 'Radarr' : 'Sonarr';
  return (
    <SlideOver open={open} onClose={onClose} title={r.title} subText={d ? `${d.arr}${d.season != null ? ` · Season ${d.season}` : ''} · searched ${ago(d.check.at)}` : `${arr} · interactive search`}
      footer={
        <div className="flex gap-3">
          <Button onClick={onClose}>Close</Button>
          <Button buttonType="primary" className="flex-1" disabled={q.isFetching} onClick={() => setFresh((n) => n + 1)}>
            {q.isFetching ? <Spinner className="h-5 w-5" /> : <Icons.retry className="h-5 w-5" />}<span>Search again</span>
          </Button>
        </div>
      }>
      {q.isFetching && !d ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Spinner />
          <p className="type-body-default text-ink-tertiary">Asking your indexers through {arr}…<br />This can take up to a minute.</p>
        </div>
      ) : q.isError ? (
        <p className="py-10 text-center type-body-default text-ink-on-warning">{q.error instanceof ApiError ? q.error.message : 'Couldn’t search right now.'}</p>
      ) : d ? (
        <div className={q.isFetching ? 'opacity-50' : ''}>
          <Summary d={d} />
          {d.releases.length > 0 && <h3 className="mb-1 mt-6 type-heading-group text-ink-primary">Results <span className="type-body-default text-ink-muted">{d.check.total}</span></h3>}
          <ul className="divide-y divide-line">
            {d.releases.map((x) => <ReleaseRow key={`${x.indexerId}:${x.guid}`} x={x} requestId={r.id} arr={d.arr} onGrabbed={onClose} />)}
          </ul>
        </div>
      ) : null}
    </SlideOver>
  );
}

function Summary({ d }: { d: NonNullable<ReturnType<typeof useReleases>['data']> }) {
  const c = d.check;
  const tone = c.accepted > 0 ? 'border-line-accent' : c.total === 0 ? 'border-line' : 'border-line-warning-subtle';
  return (
    <div className={`rounded-xl border ${tone} p-4`}>
      <p className="type-label-strong text-ink-primary">{c.headline}</p>
      {c.accepted > 0 && <p className="mt-1 type-body-small text-ink-tertiary">Search again and {d.arr} grabs the best one, or pick one below.</p>}
      {c.total === 0 && <p className="mt-1 type-body-small text-ink-tertiary">Nobody has posted it yet, or your indexers can’t see it. The daily retry checks again each week.</p>}
      {c.reasons.length > 0 && (
        <ul className="mt-3 space-y-1">
          {c.reasons.map((x) => (
            <li key={x.reason} className="flex justify-between gap-3 type-body-small"><span className="text-ink-secondary">{x.reason}</span><span className="text-ink-muted">{x.count}</span></li>
          ))}
        </ul>
      )}
      {c.qualities.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {c.qualities.map((x) => <span key={x.quality} className="rounded-full bg-raised px-2 py-0.5 type-badge-tag text-ink-secondary">{x.quality} · {x.count}</span>)}
        </div>
      )}
    </div>
  );
}

function ReleaseRow({ x, requestId, arr, onGrabbed }: { x: ReleaseItem; requestId: number; arr: string; onGrabbed: () => void }) {
  const post = useGuardedPost();
  const toast = useToast();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = [x.resolution ? `${x.resolution}p` : x.quality, x.size ? bytes(x.size) : null, x.seeders != null ? `${x.seeders} seeds` : null, x.indexer,
    x.ageDays != null ? (x.ageDays < 1 ? 'today' : `${Math.round(x.ageDays)}d old`) : null].filter(Boolean).join(' · ');
  async function grab() {
    if (x.rejected && !confirm) { setConfirm(true); return; }
    setBusy(true);
    try {
      const res = await post<{ title: string }>(`/api/requests/${requestId}/grab`, { guid: x.guid, indexerId: x.indexerId });
      if (res === null) return;
      toast('success', `Sent to ${arr}. It shows under Downloading in a moment.`);
      void qc.invalidateQueries({ queryKey: ['downloads'] });
      onGrabbed();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : `Couldn’t reach ${arr}.`);
    } finally { setBusy(false); setConfirm(false); }
  }
  return (
    <li className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className={`break-words type-caption-strong ${x.rejected ? 'text-ink-secondary' : 'text-ink-primary'}`}>{x.title}</p>
        <p className="mt-0.5 type-body-xsmall text-ink-muted">{meta}</p>
        {x.rejected && x.rejections.length > 0 && <p className="mt-1 type-body-xsmall text-ink-on-warning">{x.rejections.slice(0, 2).join(' · ')}</p>}
      </div>
      <Button size="md" buttonType={x.rejected ? 'default' : 'primary'} disabled={busy} onClick={() => void grab()} className="!px-3 !py-1.5 flex-shrink-0">
        {busy ? <Spinner className="h-4 w-4" /> : confirm ? 'Grab anyway?' : 'Grab'}
      </Button>
    </li>
  );
}
