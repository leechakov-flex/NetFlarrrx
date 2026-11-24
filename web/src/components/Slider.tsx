import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { recallScroll, rememberScroll } from '../lib/scrollMemory';
import { Icons } from './icons';
import type { HomeRow } from '../lib/api';
import { TitleCard, TitleCardPlaceholder } from './TitleCard';

/** Seerr MediaSlider: header (linked title + chevron) and a horizontally scrolling card row. */
export function Slider({ row }: { row: HomeRow }) {
  // Keep this row's horizontal position for this visit, so Back from a title lands where you were.
  const { key: entry } = useLocation();
  const strip = useRef<HTMLDivElement>(null);
  const memoryKey = `${entry}:row:${row.slug}`;
  useLayoutEffect(() => {
    const el = strip.current;
    const saved = recallScroll(memoryKey);
    if (el && saved) el.scrollLeft = saved;
  }, [memoryKey]);
  // Desktop arrows: shown only when the row overflows, each greyed out at its end.
  const [ends, setEnds] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const el = strip.current;
    if (el) setEnds({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    const el = strip.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, row.items.length]);
  const page = (dir: -1 | 1) => {
    const el = strip.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.85, 200), behavior: reduce ? 'auto' : 'smooth' });
  };
  const frame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => { if (strip.current) rememberScroll(memoryKey, strip.current.scrollLeft); measure(); });
  };
  return (
    <section>
      <div className="slider-header">
        {row.link ? (
          <Link to={row.link} className="slider-title pr-4">
            <span className="truncate">{row.title}</span>
            <Icons.chevronRight className="h-6 w-6 flex-shrink-0 text-ink-muted" />
          </Link>
        ) : (
          <div className="slider-title"><span className="truncate">{row.title}</span></div>
        )}
        {row.total > 0 && (row.slug.startsWith('new') || row.slug === 'for-you') && (
          <span className="ml-auto flex-shrink-0 type-label-default text-ink-muted">{row.total.toLocaleString()} {row.total === 1 ? 'title' : 'titles'}</span>
        )}
        {!(ends.start && ends.end) && (
          <div className="ml-auto hidden flex-shrink-0 items-center gap-2 pl-4 lg:flex [span+&]:ml-0">
            <SliderArrow dir={-1} disabled={ends.start} label={`Scroll ${row.title} back`} onClick={() => page(-1)} />
            <SliderArrow dir={1} disabled={ends.end} label={`Scroll ${row.title} forward`} onClick={() => page(1)} />
          </div>
        )}
      </div>
      <div ref={strip} onScroll={onScroll} className="scrollbar-none -mx-4 lg:-mx-8 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 lg:px-8 pb-1 pt-1 md:gap-4 lg:scroll-px-8">
        {row.items.map((card) => (
          <div key={card.id} className="snap-start">
            <TitleCard card={card} art={row.art} />
          </div>
        ))}
        {row.link && row.total > row.items.length && <ViewAllCard to={row.link} more={row.total - row.items.length} />}
      </div>
    </section>
  );
}

/** Figma "SliderArrow": a 36px round button in the row header, desktop only. */
function SliderArrow({ dir, disabled, label, onClick }: { dir: -1 | 1; disabled: boolean; label: string; onClick: () => void }) {
  const Icon = dir < 0 ? Icons.chevronLeft : Icons.chevronRight;
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-full text-ink-primary ring-1 ring-line-strong transition hover:bg-raised disabled:pointer-events-none disabled:opacity-30">
      <Icon className="h-5 w-5" />
    </button>
  );
}

/** Figma "ViewAllCard": the last card of a row that has more, the size of a poster. */
function ViewAllCard({ to, more }: { to: string; more: number }) {
  return (
    <div className="snap-start">
      <Link to={to} className="group block w-[7.5rem] flex-shrink-0 outline-none md:w-44">
        <div className="relative overflow-hidden rounded-xl bg-surface ring-1 ring-line transition group-hover:bg-raised group-focus-visible:ring-2 group-focus-visible:ring-indigo-400" style={{ paddingBottom: '150%' }}>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-raised ring-1 ring-line-strong transition group-hover:bg-inverse group-hover:text-ink-inverse">
              <Icons.chevronRight className="h-5 w-5" />
            </span>
            <span className="type-label-strong text-white">View all</span>
            <span className="type-caption-default text-ink-muted">{more.toLocaleString()} more</span>
          </div>
        </div>
      </Link>
    </div>
  );
}

export function SliderPlaceholder({ title }: { title: string }) {
  return (
    <section>
      <div className="slider-header"><div className="slider-title">{title}</div></div>
      <div className="-mx-4 lg:-mx-8 flex gap-3 overflow-hidden px-4 lg:px-8 pb-1 pt-1 md:gap-4">
        {Array.from({ length: 8 }, (_, i) => <TitleCardPlaceholder key={i} />)}
      </div>
    </section>
  );
}
