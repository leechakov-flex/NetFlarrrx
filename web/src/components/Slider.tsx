import { useLayoutEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { recallScroll, rememberScroll } from '../lib/scrollMemory';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
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
  const frame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => { if (strip.current) rememberScroll(memoryKey, strip.current.scrollLeft); });
  };
  return (
    <section>
      <div className="slider-header">
        {row.link ? (
          <Link to={row.link} className="slider-title min-w-0 pr-4">
            <span className="truncate">{row.title}</span>
            <ChevronRightIcon />
          </Link>
        ) : (
          <div className="slider-title"><span className="truncate">{row.title}</span></div>
        )}
        {row.total > 0 && row.slug.startsWith('new') && (
          <span className="ml-auto flex-shrink-0 text-sm font-medium text-gray-400">{row.total.toLocaleString()} {row.total === 1 ? 'title' : 'titles'}</span>
        )}
      </div>
      <div ref={strip} onScroll={onScroll} className="scrollbar-none -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-4 pt-1 md:gap-4">
        {row.items.map((card) => (
          <div key={card.id} className="snap-start">
            <TitleCard card={card} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function SliderPlaceholder({ title }: { title: string }) {
  return (
    <section>
      <div className="slider-header"><div className="slider-title">{title}</div></div>
      <div className="-mx-4 flex gap-3 overflow-hidden px-4 pb-4 md:gap-4">
        {Array.from({ length: 8 }, (_, i) => <TitleCardPlaceholder key={i} />)}
      </div>
    </section>
  );
}
