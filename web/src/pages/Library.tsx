import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLibrary, type LibraryItem } from '../lib/api';
import { relativeTime } from '../lib/format';
import { Empty, PageTitle, Spinner, LoadError } from '../components/ui';
import { Icons } from '../components/icons';
import { BackButton } from '../components/Layout';

type Type = 'all' | 'movie' | 'tv';
type Sort = 'added' | 'title' | 'year';
const SORTS: [Sort, string][] = [['added', 'Recently added'], ['title', 'Title A–Z'], ['year', 'Newest release']];

/**
 * Library (Figma Build screen 10): everything already in Jellyfin, to check
 * "do I have this?" before requesting. Search, Movies / Series, sort.
 */
export function Library() {
  const [params, setParams] = useSearchParams();
  const type = (params.get('type') as Type) || 'all';
  const sort = (params.get('sort') as Sort) || 'added';
  const [q, setQ] = useState(params.get('q') ?? '');
  // Search as you type, a moment after you stop.
  useEffect(() => {
    const t = setTimeout(() => set({ q: q.trim() || null }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const set = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k); }
    setParams(p, { replace: true });
  };
  const res = useLibrary({ type: type === 'all' ? undefined : type, q: params.get('q') ?? undefined, sort });
  const first = res.data?.pages[0];
  const items = res.data?.pages.flatMap((p) => p.items) ?? [];

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0]?.isIntersecting && res.hasNextPage && !res.isFetchingNextPage) void res.fetchNextPage(); }, { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [res.hasNextPage, res.isFetchingNextPage, res.fetchNextPage]);

  if (res.isPending) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (res.isError || !first) return <LoadError what="your library" onRetry={() => void res.refetch()} />;
  if (!first.configured) {
    return (
      <div className="max-w-xl">
        <BackButton className="mt-4 lg:hidden" />
        <PageTitle>Library</PageTitle>
        <p className="type-body-default text-ink-secondary">Connect Jellyfin to see everything you already have here.</p>
        <ol className="mt-4 list-decimal space-y-1.5 pl-5 type-body-default text-ink-tertiary">
          <li>In Jellyfin, open Dashboard → API Keys and add one called MonkeySee.</li>
          <li>Put it in <code className="text-white">monkeysee.env</code> as <code className="text-white">JELLYFIN_API_KEY</code>.</li>
          <li>Restart MonkeySee. The library fills in within a minute.</li>
        </ol>
      </div>
    );
  }
  const chip = (on: boolean) => `flex-shrink-0 rounded-full px-3 py-1.5 type-label-default transition ${on ? 'bg-inverse text-ink-inverse' : 'bg-app text-ink-secondary ring-1 ring-inset ring-line-strong hover:bg-raised'}`;
  const counts = first.counts;
  return (
    // Figma Mobile / Library: everything 12px apart; the back button is the top bar on phones.
    <div className="flex flex-col gap-3 pt-4">
      <BackButton className="lg:hidden" />
      <h1 className="truncate type-heading-page text-ink-primary">Library</h1>
      <p className="type-body-small text-ink-tertiary">
        {counts.movie.toLocaleString()} movies · {counts.tv.toLocaleString()} series in Jellyfin{first.syncedAt ? ` · checked ${relativeTime(first.syncedAt)}` : ''}
        {first.error && <span className="text-yellow-200"> · last check failed: {first.error}</span>}
      </p>
      <label className="flex max-w-xl items-center gap-2 rounded-full bg-surface px-4 py-2.5 ring-1 ring-line-strong focus-within:ring-indigo-400">
        <Icons.search className="h-[18px] w-[18px] text-ink-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Do I have…" aria-label="Search your library"
          className="min-w-0 flex-1 bg-transparent type-body-default text-ink-primary placeholder:text-ink-muted focus:outline-none" />
        {q && <button type="button" aria-label="Clear" onClick={() => setQ('')}><Icons.xmarkCircle className="h-5 w-5 text-ink-muted" /></button>}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {([['all', 'All'], ['movie', 'Movies'], ['tv', 'Series']] as [Type, string][]).map(([k, label]) => (
          <button key={k} type="button" className={chip(type === k)} aria-pressed={type === k} onClick={() => set({ type: k === 'all' ? null : k })}>{label}</button>
        ))}
        <select value={sort} onChange={(e) => set({ sort: e.target.value === 'added' ? null : e.target.value })} aria-label="Sort"
          className="ml-auto rounded-full bg-app px-3 py-1.5 type-label-default text-ink-secondary ring-1 ring-inset ring-line-strong">
          {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </div>
      <p className="type-caption-default text-ink-muted">
        {params.get('q') ? `${first.total.toLocaleString()} match${first.total === 1 ? '' : 'es'} for “${params.get('q')}”` : `${first.total.toLocaleString()} titles`}
      </p>
      {items.length === 0 ? (
        <Empty>{params.get('q') ? 'Not in your library. Search all services to request it.' : 'Nothing here yet.'}</Empty>
      ) : (
        <div className={`grid grid-cols-3 gap-x-[11px] gap-y-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 ${res.isPlaceholderData ? 'opacity-50' : ''}`}>
          {items.map((it) => <LibraryCard key={it.id} it={it} />)}
        </div>
      )}
      {params.get('q') && items.length === 0 && (
        <p className="mt-2 text-center"><Link to={`/search?q=${encodeURIComponent(params.get('q')!)}`} className="type-label-default text-indigo-300 hover:text-indigo-200">Search all services for “{params.get('q')}”</Link></p>
      )}
      <div ref={sentinel} />
      {res.isFetchingNextPage && <div className="flex justify-center py-6"><Spinner /></div>}
    </div>
  );
}

function LibraryCard({ it }: { it: LibraryItem }) {
  const [broken, setBroken] = useState(false);
  const body = (
    <>
      <div className="relative overflow-hidden rounded-xl bg-surface ring-1 ring-line" style={{ paddingBottom: '150%' }}>
        {it.posterUrl && !broken
          ? <img src={it.posterUrl} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="absolute inset-0 h-full w-full object-cover" />
          : <div className="absolute inset-0 flex items-center justify-center p-2 text-center type-caption-strong text-ink-secondary">{it.title}</div>}
        <span className="absolute left-2 top-2 rounded-full bg-gray-900/70 px-2 type-badge-tag uppercase tracking-wide text-ink-secondary ring-1 ring-white/10">{it.type === 'movie' ? 'Movie' : 'Series'}</span>
      </div>
      <div className="mt-0.5 truncate type-caption-strong text-ink-primary">{it.title}</div>
      <div className="truncate type-body-xsmall text-ink-muted">{[it.year, it.seasons ? `${it.seasons} season${it.seasons === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}</div>
    </>
  );
  // Titles on one of your services open their page; the rest just show.
  return it.titleId ? <Link to={`/title/${it.titleId}`} className="block">{body}</Link> : <div>{body}</div>;
}
