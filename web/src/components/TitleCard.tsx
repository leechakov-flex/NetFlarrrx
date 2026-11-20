import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FilmIcon } from '@heroicons/react/24/outline';
import type { TitleCard as Card } from '../lib/api';
import { addedLabel, tmdbImage } from '../lib/format';
import { StatusBadgeMini } from './ui';

/**
 * Seerr's TitleCard: 2:3 poster, rounded-xl, ring gray-700, a MOVIE/SERIES pill
 * and the status mini-badge. As in the Figma card, the year, title and date added
 * stay hidden until hover or keyboard focus, so the poster carries the row.
 */
export function TitleCard({ card, fill = false }: { card: Card; fill?: boolean }) {
  const [broken, setBroken] = useState(false);
  const poster = broken ? null : tmdbImage.poster(card.posterPath);
  const added = addedLabel(card.addedAt);
  return (
    <Link
      to={`/title/${card.id}`}
      className={`${fill ? 'w-full' : 'w-36 sm:w-36 md:w-44'} group block flex-shrink-0 outline-none`}
      aria-label={[`${card.title}${card.year ? ` (${card.year})` : ''}`, card.backOnNetflix ? 'back on Netflix' : added].filter(Boolean).join(', ')}
    >
      <div
        className="relative transform-gpu overflow-hidden rounded-xl bg-gray-800 shadow ring-1 ring-gray-700 transition duration-300 group-hover:scale-105 group-hover:shadow-lg group-hover:ring-gray-500 group-focus-visible:ring-2 group-focus-visible:ring-indigo-400"
        style={{ paddingBottom: '150%' }}
      >
        <div className="absolute inset-0 h-full w-full overflow-hidden">
          {poster ? (
            <img src={poster} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-700 to-gray-800">
              <FilmIcon className="h-12 w-12 text-gray-600" />
            </div>
          )}
          <div className="absolute left-0 right-0 top-0 flex items-start justify-between p-2">
            <span className={`pointer-events-none rounded-full border shadow-md ${card.kind === 'movie' ? 'border-blue-500 bg-blue-600/80' : 'border-purple-600 bg-purple-600/80'}`}>
              <span className="flex h-4 items-center px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-white sm:h-5">
                {card.kind === 'movie' ? 'Movie' : 'Series'}
              </span>
            </span>
            <StatusBadgeMini state={card.seerr} />
          </div>
          <div
            aria-hidden
            className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            <div
              className="absolute inset-x-0 bottom-0 top-1/3"
              style={{ background: 'linear-gradient(180deg, rgba(45, 55, 72, 0) 0%, rgba(45, 55, 72, 0.92) 100%)' }}
            />
            <div className="absolute inset-x-0 bottom-0 px-2 pb-2 text-white">
            {card.year && <div className="text-sm font-medium">{card.year}</div>}
            <h2
              className="whitespace-normal text-lg font-bold leading-tight md:text-xl"
              style={{ WebkitLineClamp: 3, display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', wordBreak: 'break-word' }}
            >
              {card.title}
            </h2>
            {(added || card.backOnNetflix) && (
              <div className="mt-1 text-xs font-medium text-gray-200">{card.backOnNetflix ? `Back · ${added?.replace('Added ', '')}` : added}</div>
            )}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

export function TitleCardPlaceholder({ fill = false }: { fill?: boolean }) {
  return (
    <div className={`${fill ? 'w-full' : 'w-36 sm:w-36 md:w-44'} flex-shrink-0`}>
      <div className="relative animate-pulse rounded-xl bg-gray-700 ring-1 ring-gray-700" style={{ paddingBottom: '150%' }} />
    </div>
  );
}
