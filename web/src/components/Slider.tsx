import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { recallScroll, rememberScroll } from '../lib/scrollMemory';
import { Icons } from './icons';
import type { HomeRow } from '../lib/api';
import { TitleCard, TitleCardPlaceholder } from './TitleCard';

/**
 * A horizontally scrolling row with a header. On desktop the header ends with back/forward
 * arrows (Figma "SliderArrow"): shown only when the row overflows, each greyed out at its end.
 * Used by every carousel: Discover rows, and Cast & Crew and Related on a title page.
 */
export function Carousel({ title, aside, label, memoryKey, gap = 'gap-3 md:gap-4', snap = true, children }: {
  title: ReactNode; aside?: ReactNode; label: string; memoryKey?: string; gap?: string; snap?: boolean; children: ReactNode;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = strip.current;
    const saved = memoryKey ? recallScroll(memoryKey) : null;
    if (el && saved) el.scrollLeft = saved;
  }, [memoryKey]);
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
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => ro.disconnect();
  }, [measure, children]);
  const page = (dir: -1 | 1) => {
    const el = strip.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.85, 200), behavior: reduce ? 'auto' : 'smooth' });
  };
  const frame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => { if (strip.current && memoryKey) rememberScroll(memoryKey, strip.current.scrollLeft); measure(); });
  };
  return (
    <section>
      <div className="slider-header">
        {title}
        {aside}
        {!(ends.start && ends.end) && (
          <div className="ml-auto hidden flex-shrink-0 items-center gap-2 pl-4 lg:flex [span+&]:ml-0">
            <SliderArrow dir={-1} disabled={ends.start} label={`Scroll ${label} back`} onClick={() => page(-1)} />
            <SliderArrow dir={1} disabled={ends.end} label={`Scroll ${label} forward`} onClick={() => page(1)} />
          </div>
        )}
      </div>
      <div ref={strip} onScroll={onScroll} className={`scrollbar-none -mx-4 lg:-mx-8 flex overflow-x-auto px-4 pb-1 pt-1 lg:px-8 ${gap} ${snap ? 'snap-x snap-mandatory scroll-px-4 lg:scroll-px-8' : ''}`}>
        {children}
      </div>
    </section>
  );
}

/** Seerr MediaSlider: a Discover row. Keeps its horizontal position for this visit, so Back from a title lands where you were. */
export function Slider({ row }: { row: HomeRow }) {
  const { key: entry } = useLocation();
  return (
    <Carousel
      label={row.title}
      memoryKey={`${entry}:row:${row.slug}`}
      title={row.link ? (
        <Link to={row.link} className="slider-title pr-4">
          <span className="truncate">{row.title}</span>
          <Icons.chevronRight className="h-6 w-6 flex-shrink-0 text-ink-muted" />
        </Link>
      ) : (
        <div className="slider-title"><span className="truncate">{row.title}</span></div>
      )}
      aside={row.total > 0 && (row.slug.startsWith('new') || row.slug === 'for-you') ? (
        <span className="ml-auto flex-shrink-0 type-label-default text-ink-muted">{row.total.toLocaleString()} {row.total === 1 ? 'title' : 'titles'}</span>
      ) : null}
    >
      {row.items.map((card) => (
        <div key={card.id} className="snap-start">
          <TitleCard card={card} art={row.art} />
        </div>
      ))}
      {row.link && row.total > row.items.length && <ViewAllCard to={row.link} more={row.total - row.items.length} />}
    </Carousel>
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
