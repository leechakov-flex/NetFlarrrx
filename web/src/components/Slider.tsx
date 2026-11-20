import { Link } from 'react-router-dom';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import type { HomeRow } from '../lib/api';
import { TitleCard, TitleCardPlaceholder } from './TitleCard';

/** Seerr MediaSlider: header (linked title + chevron) and a horizontally scrolling card row. */
export function Slider({ row }: { row: HomeRow }) {
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
      <div className="scrollbar-none -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-4 pt-1 md:gap-4">
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
