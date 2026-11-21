import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { BrowseQuery, Kind, SortKey } from '../lib/api';
import { useBrowse, useGenres, useMeta, useThemes } from '../lib/api';
import { TitleCard, TitleCardPlaceholder } from '../components/TitleCard';
import { FiltersPanel, SortFilterBar, activeFilterCount, type Filters } from '../components/Filters';
import { Credits, Empty, PageTitle, Spinner, Tag } from '../components/ui';
import { SearchInput } from '../components/Layout';
import type { How, ServiceKey } from '../lib/api';
import { SERVICE_NAMES } from '../lib/format';
import { useCompanyNames } from '../components/CompanyPicker';

const HOW_LABEL: Record<How, string> = { sub: 'Subscription', digital: 'Rent or buy', soon: 'Coming soon' };

const parseFilters = (p: URLSearchParams): Filters & { sort?: SortKey; theme?: string; because?: string } => ({
  theme: p.get('theme') || undefined,
  because: p.get('because') || undefined,
  genres: p.get('genres')?.split(',').map(Number).filter((n) => n > 0) || undefined,
  added: ([7, 30, 90] as const).find((n) => String(n) === p.get('added')) ?? undefined,
  minRating: Number(p.get('minRating')) || undefined,
  maxRating: p.get('maxRating') !== null && Number(p.get('maxRating')) < 10 ? Number(p.get('maxRating')) : undefined,
  hideHave: p.get('hide') === 'have' || undefined,
  minVotes: Number(p.get('minVotes')) || undefined,
  sort: (p.get('sort') as SortKey) || undefined,
  services: (p.get('services')?.split(',').filter((k) => k in SERVICE_NAMES) as ServiceKey[]) || undefined,
  how: (p.get('how')?.split(',').filter((k) => k in HOW_LABEL) as How[]) || undefined,
  studios: p.get('studios')?.split(',').filter(Boolean) || undefined,
  networks: p.get('networks')?.split(',').filter(Boolean) || undefined,
});

export function Browse({ kind, title, search = false }: { kind?: Kind; title: string; search?: boolean }) {
  const [params, setParams] = useSearchParams();
  const q = search ? params.get('q') ?? '' : undefined;
  const f = useMemo(() => parseFilters(params), [params]);
  // Search with nothing typed shows what's popular on your services.
  const query: BrowseQuery = search && !q ? { sort: 'popularity' } : { kind, q, ...f };
  const res = useBrowse(query);
  const genres = useGenres(kind);
  const meta = useMeta();
  const themes = useThemes();
  const theme = f.theme || f.because ? (res.data?.pages[0]?.theme ?? themes.data?.find((t) => t.slug === f.theme)) : undefined;
  const defaultSort: SortKey = theme?.sort ?? 'added';
  const sort = f.sort ?? defaultSort;
  const [filtersOpen, setFiltersOpen] = useState(false);

  const update = (next: Partial<Filters & { sort: SortKey }>) => {
    const merged = { ...f, ...next };
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (f.theme) p.set('theme', f.theme);
    if (f.because) p.set('because', f.because);
    if (merged.sort && merged.sort !== defaultSort) p.set('sort', merged.sort);
    if (merged.added) p.set('added', String(merged.added));
    if (merged.genres?.length) p.set('genres', merged.genres.join(','));
    if (merged.minRating) p.set('minRating', String(merged.minRating));
    if (merged.maxRating !== undefined && merged.maxRating < 10) p.set('maxRating', String(merged.maxRating));
    if (merged.hideHave) p.set('hide', 'have');
    if (merged.minVotes) p.set('minVotes', String(merged.minVotes));
    if (merged.services?.length) p.set('services', merged.services.join(','));
    if (merged.how?.length) p.set('how', merged.how.join(','));
    if (merged.studios?.length) p.set('studios', merged.studios.join(','));
    if (merged.networks?.length) p.set('networks', merged.networks.join(','));
    setParams(p, { replace: true });
  };

  // Infinite scroll
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && res.hasNextPage && !res.isFetchingNextPage) void res.fetchNextPage();
    }, { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [res.hasNextPage, res.isFetchingNextPage, res.fetchNextPage]);

  const items = res.data?.pages.flatMap((p) => p.items) ?? [];
  const total = res.data?.pages[0]?.total;
  const noun = kind === 'movie' ? 'movies' : kind === 'series' ? 'series' : 'titles';
  const companyName = useCompanyNames();
  const genreName = (id: number) => genres.data?.find((g) => g.id === id)?.name ?? 'Genre';

  const chips: { label: string; clear: () => void }[] = [];
  if (f.added) chips.push({ label: `Added: last ${f.added} days`, clear: () => update({ added: undefined }) });
  for (const g of f.genres ?? []) chips.push({ label: genreName(g), clear: () => update({ genres: f.genres!.filter((x) => x !== g) }) });
  if (f.minRating || f.maxRating !== undefined) {
    const lo = f.minRating ?? 0, hi = f.maxRating ?? 10;
    chips.push({ label: hi >= 10 ? `Rating ${lo}+` : lo ? `Rating ${lo}–${hi}` : `Rating ${hi} or less`, clear: () => update({ minRating: undefined, maxRating: undefined }) });
  }
  if (f.hideHave) chips.push({ label: 'Hiding what I have', clear: () => update({ hideHave: undefined }) });
  if (f.minVotes) chips.push({ label: `${f.minVotes.toLocaleString()}+ votes`, clear: () => update({ minVotes: undefined }) });
  for (const k of f.services ?? []) chips.push({ label: SERVICE_NAMES[k], clear: () => update({ services: f.services!.filter((x) => x !== k) }) });
  for (const h of f.how ?? []) chips.push({ label: HOW_LABEL[h], clear: () => update({ how: f.how!.filter((x) => x !== h) }) });
  for (const k of f.studios ?? []) chips.push({ label: companyName(k), clear: () => update({ studios: f.studios!.filter((x) => x !== k) }) });
  for (const k of f.networks ?? []) chips.push({ label: companyName(k), clear: () => update({ networks: f.networks!.filter((x) => x !== k) }) });

  return (
    <>
      <div className="flex flex-col justify-between lg:flex-row lg:items-end">
        <PageTitle>{search ? (q ? `Results for “${q}”` : 'Search') : theme ? theme.title : f.theme || f.because ? '\u00a0' : title}</PageTitle>
        {search && <div className="mb-4 lg:hidden"><SearchInput placeholder="Movies, series, stand-up…" autoFocus /></div>}
        {(!search || q) && (
          <div className="lg:mb-4">
            <SortFilterBar sort={sort} withMatch={defaultSort === 'match'} onSort={(s) => update({ sort: s })} filterCount={activeFilterCount(f)} onOpenFilters={() => setFiltersOpen(true)} />
          </div>
        )}
      </div>

      {chips.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {chips.map((c) => <Tag key={c.label} removable onClick={c.clear}>{c.label}</Tag>)}
        </div>
      )}
      {search && !q ? (
        <p className="mb-4 type-caption-default text-ink-muted">Popular on your services</p>
      ) : total !== undefined && (
        <p className="mb-4 type-caption-default text-ink-muted">
          {total.toLocaleString()} {total === 1 ? noun.replace(/s$/, '') : noun}
          {meta.data?.languageRule === 'en' ? ' · English-original only' : ''}
        </p>
      )}

      {res.isError ? (
        <Empty>Couldn’t load titles. Try again in a moment.</Empty>
      ) : res.isPending ? (
        <ul className="cards-vertical">{Array.from({ length: 12 }, (_, i) => <li key={i}><TitleCardPlaceholder fill /></li>)}</ul>
      ) : items.length === 0 ? (
        <Empty>{search ? 'No titles match that search.' : 'No titles match these filters.'}</Empty>
      ) : (
        <ul className="cards-vertical">
          {items.map((card) => <li key={card.id}><TitleCard card={card} fill /></li>)}
        </ul>
      )}
      <div ref={sentinel} className="flex justify-center py-8">{res.isFetchingNextPage && <Spinner />}</div>
      <Credits />

      <FiltersPanel
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        kind={kind}
        q={q}
        theme={f.theme}
        because={f.because}
        value={{ genres: f.genres, added: f.added, minRating: f.minRating, maxRating: f.maxRating, minVotes: f.minVotes, hideHave: f.hideHave, services: f.services, how: f.how, studios: f.studios, networks: f.networks }}
        onApply={(next) => update({ genres: next.genres, added: next.added ?? undefined, minRating: next.minRating, maxRating: next.maxRating, minVotes: next.minVotes, hideHave: next.hideHave, services: next.services, how: next.how, studios: next.studios, networks: next.networks })}
      />
    </>
  );
}
