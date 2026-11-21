import { useEffect, useState } from 'react';
import type { BrowseQuery, How, Kind, ServiceKey, SortKey } from '../lib/api';
import { useBrowseCount, useGenres, useMeta } from '../lib/api';
import { Icons } from './icons';
import { Button, Tag } from './ui';
import { SlideOver } from './SlideOver';

export const SORTS: { value: SortKey; label: string }[] = [
  { value: 'added', label: 'Newest added' },
  { value: 'rating', label: 'Highest rated' },
  { value: 'popularity', label: 'Most popular' },
  { value: 'release', label: 'Newest release' },
  { value: 'title', label: 'Title A–Z' },
];
const ADDED: { value: BrowseQuery['added']; label: string }[] = [
  { value: 7, label: 'Last 7 days' }, { value: 30, label: 'Last 30 days' }, { value: 90, label: 'Last 90 days' }, { value: null, label: 'Any time' },
];
const VOTES = [0, 50, 200, 1000];

export type Filters = Pick<BrowseQuery, 'genres' | 'added' | 'minRating' | 'maxRating' | 'minVotes' | 'hideHave' | 'services' | 'how'>;
const ratingSet = (f: Filters) => !!f.minRating || (f.maxRating !== undefined && f.maxRating < 10);
export const activeFilterCount = (f: Filters) =>
  (f.genres?.length ? 1 : 0) + (f.added ? 1 : 0) + (ratingSet(f) ? 1 : 0) + (f.minVotes ? 1 : 0) + (f.hideHave ? 1 : 0) +
  (f.services?.length ?? 0) + (f.how?.length ?? 0);
const HOWS: { value: How; label: string }[] = [{ value: 'sub', label: 'Subscription' }, { value: 'digital', label: 'Rent or buy' }, { value: 'soon', label: 'Coming soon' }];
const toggle = <T,>(list: T[] | undefined, v: T) => { const s = new Set(list ?? []); if (s.has(v)) s.delete(v); else s.add(v); return s.size ? [...s] : undefined; };

export function ratingLabel(min = 0, max = 10) {
  if (!min && max >= 10) return 'Any rating';
  if (max >= 10) return `${min} and up`;
  if (!min) return `${max} and below`;
  return `between ${min} and ${max}`;
}

/** Seerr's Discover header: sort select with an icon box, plus a Filters button showing the active count. */
export function SortFilterBar({ sort, onSort, filterCount, onOpenFilters, withMatch = false }:
  { sort: SortKey; onSort: (s: SortKey) => void; filterCount: number; onOpenFilters: () => void; withMatch?: boolean }) {
  return (
    <div className="mb-4 flex flex-col gap-2 sm:flex-row">
      <div className="flex flex-grow sm:flex-grow-0">
        <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
          <Icons.sort className="h-5 w-5" />
        </span>
        <select
          aria-label="Sort"
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          className="w-full rounded-r-md border border-gray-500 bg-gray-700 py-2 pl-3 pr-8 text-sm text-white focus:border-indigo-500 focus:outline-none sm:w-56"
        >
          {withMatch && <option value="match">Best match for you</option>}
          {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      <Button onClick={onOpenFilters} className="w-full sm:w-auto">
        <Icons.filter className="h-5 w-5" />
        <span>Filters</span>
        {filterCount > 0 && (
          <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-indigo-500 px-1.5 text-xs font-semibold text-white">{filterCount}</span>
        )}
      </Button>
    </div>
  );
}

export function FiltersPanel({ open, onClose, kind, q, theme, because, value, onApply }:
  { open: boolean; onClose: () => void; kind?: Kind; q?: string; theme?: string; because?: string; value: Filters; onApply: (f: Filters) => void }) {
  const [draft, setDraft] = useState<Filters>(value);
  // Reset the draft each time the panel opens (not on every parent render).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) setDraft(value); }, [open]);
  const genres = useGenres(kind);
  const count = useBrowseCount({ kind, q, theme, because, ...draft }, open);
  const noun = kind === 'movie' ? 'movies' : kind === 'series' ? 'series' : 'titles';
  const toggleGenre = (id: number) => {
    const set = new Set(draft.genres ?? []);
    if (set.has(id)) set.delete(id); else set.add(id);
    setDraft({ ...draft, genres: [...set] });
  };
  const n = activeFilterCount(draft);
  const services = useMeta().data?.services ?? [];

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title="Filters"
      subText={n ? `${n} active filter${n === 1 ? '' : 's'}` : 'No filters applied'}
      footer={
        <div className="flex gap-3">
          <Button onClick={() => setDraft({})}>Clear</Button>
          <Button buttonType="primary" className="flex-1" onClick={() => { onApply(draft); onClose(); }}>
            {count.data === undefined ? 'Show results' : `Show ${count.data.toLocaleString()} ${count.data === 1 ? noun.replace(/s$/, '') : noun}`}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col space-y-6">
        {services.length > 1 && (
          <fieldset>
            <legend className="mb-2 type-heading-group text-white">Services</legend>
            <div className="flex flex-wrap gap-2">
              {services.map((s) => (
                <Tag key={s.key} selected={draft.services?.includes(s.key)} onClick={() => setDraft({ ...draft, services: toggle<ServiceKey>(draft.services, s.key) })}>{s.name}</Tag>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset>
          <legend className="mb-2 type-heading-group text-white">How to watch</legend>
          <div className="flex flex-wrap gap-2">
            {HOWS.map((h) => (
              <Tag key={h.value} selected={(draft.how ?? ['sub']).includes(h.value)} onClick={() => {
                const next = toggle<How>(draft.how ?? ['sub'], h.value);
                setDraft({ ...draft, how: !next || (next.length === 1 && next[0] === 'sub') ? undefined : next });
              }}>{h.label}</Tag>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 type-heading-group text-white">Added</legend>
          <div className="flex flex-wrap gap-2">
            {ADDED.map((a) => (
              <Tag key={a.label} selected={(draft.added ?? null) === a.value} onClick={() => setDraft({ ...draft, added: a.value })}>{a.label}</Tag>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 type-heading-group text-white">Genres</legend>
          <div className="flex flex-wrap gap-2">
            {genres.data?.map((g) => (
              <Tag key={g.id} selected={draft.genres?.includes(g.id)} onClick={() => toggleGenre(g.id)}>{g.name}</Tag>
            )) ?? <span className="text-sm text-gray-400">Loading genres…</span>}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 type-heading-group text-white">TMDB rating</legend>
          <RatingRange
            min={draft.minRating ?? 0}
            max={draft.maxRating ?? 10}
            onChange={(lo, hi) => setDraft({ ...draft, minRating: lo || undefined, maxRating: hi < 10 ? hi : undefined })}
          />
          <div className="mt-2 text-sm text-gray-300">
            {ratingLabel(draft.minRating, draft.maxRating) === 'Any rating' ? 'Any rating' : `TMDB rating ${ratingLabel(draft.minRating, draft.maxRating)}`}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 type-heading-group text-white">Minimum votes</legend>
          <div className="flex flex-wrap gap-2">
            {VOTES.map((v) => (
              <Tag key={v} selected={(draft.minVotes ?? 0) === v} onClick={() => setDraft({ ...draft, minVotes: v || undefined })}>
                {v ? `${v.toLocaleString()}+` : 'Any'}
              </Tag>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 type-heading-group text-white">On MonkeyServer</legend>
          <label className="flex cursor-pointer items-center justify-between gap-4">
            <span className="text-sm text-gray-300">Hide titles that are already available or requested</span>
            <Toggle checked={!!draft.hideHave} onChange={(v) => setDraft({ ...draft, hideHave: v || undefined })} label="Hide what I have" />
          </label>
        </fieldset>
      </div>
    </SlideOver>
  );
}

/** Two-handle 0–10 range in half steps (Figma: TMDB rating between X and Y). */
function RatingRange({ min, max, onChange }: { min: number; max: number; onChange: (min: number, max: number) => void }) {
  const pct = (v: number) => `${v * 10}%`;
  return (
    <div className="dual-range relative h-5">
      <div className="absolute inset-x-0 top-[7px] h-1.5 rounded-full bg-gray-700" />
      <div className="absolute top-[7px] h-1.5 rounded-full bg-indigo-500" style={{ left: pct(min), right: `calc(100% - ${pct(max)})` }} />
      <input
        type="range" min={0} max={10} step={0.5} value={min} aria-label="Minimum TMDB rating"
        onChange={(e) => onChange(Math.min(Number(e.target.value), max - 0.5), max)}
        style={{ zIndex: min > 9 ? 2 : 1 }}
      />
      <input
        type="range" min={0} max={10} step={0.5} value={max} aria-label="Maximum TMDB rating"
        onChange={(e) => onChange(min, Math.max(Number(e.target.value), min + 0.5))}
      />
    </div>
  );
}

/** Seerr-style switch. */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${checked ? 'bg-indigo-500' : 'bg-gray-700'}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  );
}
