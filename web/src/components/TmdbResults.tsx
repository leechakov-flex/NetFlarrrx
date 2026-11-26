import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, getJson, type TmdbResult } from '../lib/api';
import { useGuardedPost } from '../lib/guardedPost';
import { longDate, tmdbImage } from '../lib/format';
import { useToast } from './Feedback';
import { Icons } from './icons';
import { Badge, Button, Spinner } from './ui';

export const useTmdbSearch = (q: string) => useQuery({
  queryKey: ['tmdb-search', q], enabled: q.trim().length >= 2, staleTime: 5 * 60_000,
  queryFn: () => getJson<{ results: TmdbResult[] }>(`/api/search/tmdb?q=${encodeURIComponent(q.trim())}`),
});

/**
 * Search, part two (Figma Build screen 21): what TMDB knows that isn't on your services yet,
 * like films still in or not yet in theaters. Same source Seerr searches. Each can be requested.
 */
export function TmdbResults({ q }: { q: string }) {
  const res = useTmdbSearch(q);
  if (res.isPending || res.isError || !res.data.results.length) {
    return res.isPending ? <div className="flex justify-center py-6"><Spinner /></div> : null;
  }
  return (
    <section className="mt-8">
      <h2 className="type-heading-section text-ink-primary">Not on your services yet</h2>
      <p className="mt-1 type-body-small text-ink-tertiary">From TMDB. Request one and Radarr or Sonarr grab it once a copy is out.</p>
      <ul className="mt-3 grid grid-cols-1 gap-x-8 lg:grid-cols-2">
        {res.data.results.map((r) => <TmdbRow key={`${r.type}:${r.tmdbId}`} r={r} q={q} />)}
      </ul>
    </section>
  );
}

function when(r: TmdbResult, now = new Date()) {
  const kind = r.type === 'movie' ? 'Movie' : 'Series';
  if (!r.date) return `${kind} · No release date yet`;
  const day = new Date(r.date + 'T12:00:00');
  if (day > now) return `${kind} · Out ${longDate(r.date)}`;
  return `${kind} · ${r.year ?? ''}`.trim();
}

function TmdbRow({ r, q }: { r: TmdbResult; q: string }) {
  const post = useGuardedPost();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const poster = tmdbImage.poster(r.posterPath);
  const request = async () => {
    setBusy(true);
    try {
      const out = await post<{ message: string }>(`/api/tmdb/${r.type}/${r.tmdbId}/request`, { title: r.title });
      if (!out) return;
      toast('success', out.message);
      qc.setQueryData<{ results: TmdbResult[] }>(['tmdb-search', q], (d) => d && { results: d.results.map((x) => x === r || (x.tmdbId === r.tmdbId && x.type === r.type) ? { ...x, state: 'requested' } : x) });
      void qc.invalidateQueries({ queryKey: ['downloads'] });
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : `Couldn’t request ${r.title}. Try again in a moment.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="h-[84px] w-14 flex-shrink-0 overflow-hidden rounded-md bg-surface ring-1 ring-line">
        {poster ? <img src={poster} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Icons.film className="m-auto mt-7 h-6 w-6 text-ink-muted" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate type-label-strong text-ink-primary">{r.title}{r.year ? ` (${r.year})` : ''}</p>
        <p className="type-body-small text-ink-tertiary">{when(r)}</p>
        {r.voteCount >= 20 && r.voteAverage ? (
          <p className="mt-0.5 flex items-center gap-1 type-caption-default text-ink-muted"><Icons.star className="h-3 w-3 text-rating" />{r.voteAverage.toFixed(1)}</p>
        ) : null}
      </div>
      {r.state === 'available' ? <Badge type="success">Available</Badge>
        : r.state === 'requested' || r.state === 'partial' ? <Badge type="warning">Requested</Badge>
        : (
          <Button className="flex-shrink-0" disabled={busy} onClick={() => void request()} aria-label={`Request ${r.title}`}>
            {busy ? <Spinner className="h-4 w-4" /> : <Icons.plus className="h-4 w-4" />}Request
          </Button>
        )}
    </li>
  );
}
