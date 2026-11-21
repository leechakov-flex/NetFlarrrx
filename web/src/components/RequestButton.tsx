import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { duration } from '../lib/format';
import { Icons } from './icons';
const ArrowDownTrayIcon = Icons.plus, BellIcon = Icons.bell, CheckIcon = Icons.check, ClockIcon = Icons.clock;
import { ApiError, postJson, savedPasscode, useMeta, useSeasons, type RequestResult, type SeasonInfo, type TitleDetail } from '../lib/api';
import { Button, Spinner, statusBadge } from './ui';
import { SlideOver } from './SlideOver';
import { useAskPasscode, useToast } from './Feedback';

const REQUESTED = new Set([2, 3, 4, 5]);

/** Seasons not yet available or requested, from the 10-minute Seerr mirror. The picker re-checks live. */
function openSeasonCount(d: TitleDetail) {
  if (!d.seasons) return null;
  const taken = new Set(d.seerrSeasons.filter((s) => REQUESTED.has(s.status)).map((s) => s.seasonNumber));
  let open = 0;
  for (let n = 1; n <= d.seasons; n++) if (!taken.has(n)) open++;
  return open;
}

/**
 * Seerr's request button. Movies request in one tap. Series open a season picker.
 * The passcode, when the server needs one, is asked for once and kept on this device.
 */
export function RequestButton({ d }: { d: TitleDetail }) {
  const meta = useMeta();
  const toast = useToast();
  const askPasscode = useAskPasscode();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function send(seasons?: number[]) {
    setBusy(true);
    try {
      let code = meta.data?.passcodeRequired ? savedPasscode.get() : null;
      if (meta.data?.passcodeRequired && !code) {
        code = await askPasscode();
        if (!code) return false;
      }
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await postJson<RequestResult>(`/api/titles/${d.id}/request`, seasons ? { seasons } : {}, code);
          if (code) savedPasscode.set(code);
          toast('success', res.message);
          void qc.invalidateQueries();
          return true;
        } catch (err) {
          if (err instanceof ApiError && err.status === 401 && attempt < 3) {
            savedPasscode.clear();
            code = await askPasscode({ wrong: attempt > 0 || !!code });
            if (!code) return false;
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      if (e?.status === 409) {
        toast('warning', e.message);
        void qc.invalidateQueries();
      } else {
        toast('error', e?.message ?? 'Couldn’t send the request. Try again in a moment.');
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!d.tmdbId) {
    return <Button buttonType="inverse" disabled title="No TMDB match, so Seerr can’t request it"><ArrowDownTrayIcon className="h-5 w-5" /><span>Request</span></Button>;
  }

  if (d.download) return <DownloadButton dl={d.download} />;
  const st = requestLook(d);

  if (d.kind === 'movie') {
    if (st && d.seerr !== 'available') {
      const [type, Icon, label] = st;
      return <Button buttonType={type} disabled className="!opacity-100" title={d.request?.detail ?? undefined}><Icon className="h-5 w-5" /><span>{label}</span></Button>;
    }
    if (d.seerr === 'available') return <Button buttonType="success" disabled className="!opacity-100"><CheckIcon className="h-5 w-5" /><span>Available</span></Button>;
    if (d.seerr === 'processing') return <Button buttonType="primary" disabled className="!opacity-100"><ClockIcon className="h-5 w-5" /><span>Processing</span></Button>;
    if (d.seerr === 'requested') return <Button buttonType="warning" disabled className="!opacity-100"><BellIcon className="h-5 w-5" /><span>Requested</span></Button>;
    return (
      <Button buttonType="inverse" disabled={busy} onClick={() => void send()}>
        {busy ? <Spinner className="h-5 w-5 text-white" /> : <ArrowDownTrayIcon className="h-5 w-5" />}
        <span>{busy ? 'Requesting…' : 'Request'}</span>
      </Button>
    );
  }

  // Series
  const open = openSeasonCount(d);
  const anyInSeerr = d.seerr !== null;
  let button;
  if (anyInSeerr && open === 0) {
    const [type, Icon, label] = st && d.seerr !== 'available' && d.seerr !== 'partial' ? st
      : d.seerr === 'available' ? (['success', CheckIcon, 'Available'] as const)
      : d.seerr === 'processing' ? (['primary', ClockIcon, 'Processing'] as const)
      : d.seerr === 'partial' ? (['success', CheckIcon, 'Partially available'] as const)
      : (['warning', BellIcon, 'Requested'] as const);
    // Still tappable: Seerr may know about a season TMDB hadn't listed when we enriched.
    button = <Button buttonType={type} onClick={() => setPickerOpen(true)}><Icon className="h-5 w-5" /><span>{label}</span></Button>;
  } else {
    button = (
      <Button buttonType="inverse" onClick={() => setPickerOpen(true)}>
        <ArrowDownTrayIcon className="h-5 w-5" />
        <span>{anyInSeerr ? 'Request more' : 'Request'}</span>
      </Button>
    );
  }
  return (
    <>
      {button}
      <SeasonPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        d={d}
        busy={busy}
        onRequest={async (seasons) => { if (await send(seasons)) setPickerOpen(false); }}
      />
    </>
  );
}

const stateBadge = (s: SeasonInfo['state']) => statusBadge(s);

function SeasonPicker({ open, onClose, d, busy, onRequest }:
  { open: boolean; onClose: () => void; d: TitleDetail; busy: boolean; onRequest: (seasons: number[]) => void }) {
  const q = useSeasons(d.id, open);
  const [picked, setPicked] = useState<Set<number> | null>(null);
  // Each opening starts from "every open season" again.
  useEffect(() => { if (open) setPicked(null); }, [open]);
  const openSeasons = q.data?.seasons.filter((s) => s.state === null).map((s) => s.seasonNumber) ?? [];
  // Default: every requestable season. Reset whenever fresh data arrives.
  const selected = picked ?? new Set(openSeasons);
  const partial = q.data?.partialRequestsEnabled ?? true;
  const toggle = (n: number) => {
    const next = new Set(selected);
    if (next.has(n)) next.delete(n); else next.add(n);
    setPicked(next);
  };
  const allOn = openSeasons.length > 0 && openSeasons.every((n) => selected.has(n));
  const count = [...selected].filter((n) => openSeasons.includes(n)).length;
  const close = () => { setPicked(null); onClose(); };

  return (
    <SlideOver
      open={open}
      onClose={close}
      title={`Request ${d.title}`}
      subText={q.data ? (openSeasons.length ? `${openSeasons.length} of ${q.data.seasons.length} seasons can be requested` : 'Every season is available or requested') : 'Checking Seerr…'}
      footer={
        <div className="flex gap-3">
          <Button onClick={close}>Cancel</Button>
          <Button
            buttonType="primary"
            className="flex-1"
            disabled={busy || count === 0}
            onClick={() => onRequest([...selected].filter((n) => openSeasons.includes(n)).sort((a, b) => a - b))}
          >
            {busy ? <Spinner className="h-5 w-5 text-white" /> : <ArrowDownTrayIcon className="h-5 w-5" />}
            <span>{count === 0 ? 'Choose a season' : count === openSeasons.length && count > 1 ? `Request all ${count} seasons` : `Request ${count} season${count === 1 ? '' : 's'}`}</span>
          </Button>
        </div>
      }
    >
      {q.isPending ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : q.isError ? (
        <p className="text-sm text-gray-300">{(q.error as Error).message}</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-gray-700">
          <table className="min-w-full divide-y divide-gray-700 text-sm">
            <thead className="bg-gray-900/60 text-left text-xs font-medium uppercase tracking-wider text-gray-400">
              <tr>
                <th className="w-12 px-4 py-3">
                  <input
                    type="checkbox" aria-label="All seasons" disabled={!partial || openSeasons.length === 0}
                    checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(openSeasons))}
                    className="h-4 w-4 rounded border-gray-500 bg-gray-700 text-indigo-600 accent-indigo-500"
                  />
                </th>
                <th className="px-2 py-3">Season</th>
                <th className="px-2 py-3">Episodes</th>
                <th className="px-4 py-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {q.data.seasons.map((s) => {
                const can = s.state === null;
                return (
                  <tr key={s.seasonNumber} className={can ? 'cursor-pointer hover:bg-gray-700/40' : ''} onClick={() => can && partial && toggle(s.seasonNumber)}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox" aria-label={s.name} disabled={!can || !partial}
                        checked={can ? selected.has(s.seasonNumber) : false}
                        onChange={() => toggle(s.seasonNumber)} onClick={(e) => e.stopPropagation()}
                        className="h-4 w-4 accent-indigo-500"
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-3 font-medium text-gray-100">{s.name}</td>
                    <td className="px-2 py-3 text-gray-300">{s.episodeCount || '—'}</td>
                    <td className="px-4 py-3 text-right">{stateBadge(s.state) ?? <span className="whitespace-nowrap text-gray-500">Not requested</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {q.data && !partial && openSeasons.length > 0 && (
        <p className="mt-3 text-xs text-gray-400">Seerr is set to request whole series, so every open season is included.</p>
      )}
    </SlideOver>
  );
}

/**
 * What a requested title is waiting on, from Radarr/Sonarr (Seerr only says "processing"
 * from the moment it's requested until Jellyfin has it).
 */
function requestLook(d: TitleDetail) {
  switch (d.request?.state) {
    case 'unreleased': return ['default', BellIcon, 'Requested'] as const;
    case 'requested': return ['default', ClockIcon, 'Searching'] as const;
    case 'missing': return ['warning', Icons.warning, 'Not found'] as const;
    case 'failed': return ['warning', Icons.warning, 'Request failed'] as const;
    case 'available': return ['success', CheckIcon, 'Downloaded'] as const;
    default: return null;
  }
}

/** Figma "Request states": downloading fills with progress; stuck shows yellow. Opens Downloads. */
function DownloadButton({ dl }: { dl: NonNullable<TitleDetail['download']> }) {
  const pct = Math.floor(dl.progress * 100);
  const stuck = dl.state === 'stalled' || dl.state === 'metadata' || dl.state === 'error';
  const base = 'relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-md border px-4 py-2 text-sm font-medium leading-5 transition';
  if (stuck) {
    const label = dl.state === 'stalled' ? `Stalled ${pct}%` : dl.state === 'metadata' ? 'Finding peers' : 'Download failed';
    return (
      <Link to="/downloads" className={`${base} border-yellow-400 bg-yellow-400/10 text-yellow-100 hover:bg-yellow-400/20`}>
        <Icons.warning className="h-5 w-5" /><span>{label}</span>
      </Link>
    );
  }
  const label = dl.state === 'queued' || dl.state === 'paused' ? 'Queued' : dl.state === 'importing' ? 'Importing' : `Downloading ${pct}%`;
  return (
    <Link to="/downloads" className={`${base} border-indigo-500 bg-indigo-950/60 text-white hover:border-indigo-400`} aria-label={`${label}. Open Downloads`}>
      <span aria-hidden className="absolute inset-y-0 left-0 bg-indigo-600 transition-[width] duration-700" style={{ width: `${pct}%` }} />
      <Icons.download className="relative h-5 w-5" />
      <span className="relative">{label}{dl.etaSeconds && dl.state === 'downloading' ? ` · ${duration(dl.etaSeconds)}` : ''}</span>
    </Link>
  );
}
