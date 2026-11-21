import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { TitleCard as Card } from '../lib/api';
import { addedLabel, serviceLine, tmdbImage } from '../lib/format';
import { Icons } from './icons';
import { StatusBadgeMini } from './ui';

const toneClass = { service: 'text-ink-muted', digital: 'text-ink-digital', soon: 'text-ink-accent-subtle' } as const;

/**
 * Poster card (Figma "TitleCard"): a 2:3 poster with the Movie/Series badge and
 * Seerr status, and under it, as plain text, where it's on (grey), rent or buy
 * (amber) or when it's coming (indigo).
 *
 * `art="logo"` is the Apple-TV-style variant: the textless poster with the title
 * logo always in the same place at the bottom, over a dark fade. Discover asks
 * for it only on rows where nearly every card has both pieces; a card in such a
 * row that lacks one falls back to its regular poster.
 */
export function TitleCard({ card, fill = false, art = 'poster' }: { card: Card; fill?: boolean; art?: 'poster' | 'logo' }) {
  const [broken, setBroken] = useState(false);
  const logoMode = art === 'logo' && !!card.logoPath && !!card.textlessPosterPath && !broken;
  const poster = broken ? null : logoMode ? tmdbImage.textless(card.textlessPosterPath) : tmdbImage.poster(card.posterPath);
  const added = addedLabel(card.addedAt);
  const line = serviceLine(card);
  return (
    <Link
      to={`/title/${card.id}`}
      className={`${fill ? 'w-full' : 'w-[7.5rem] md:w-44'} group block flex-shrink-0 outline-none`}
      aria-label={[`${card.title}${card.year ? ` (${card.year})` : ''}`, line?.text, card.backOnNetflix ? 'back' : added].filter(Boolean).join(', ')}
    >
      <div className="relative transform-gpu overflow-hidden rounded-xl bg-surface shadow ring-1 ring-line transition duration-300 group-hover:scale-105 group-hover:shadow-lg group-hover:ring-line-muted group-focus-visible:ring-2 group-focus-visible:ring-indigo-400"
        style={{ paddingBottom: '150%' }}>
        <div className="absolute inset-0 h-full w-full overflow-hidden">
          {poster ? (
            <img src={poster} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-700 to-gray-800">
              <Icons.film className="h-12 w-12 text-gray-600" />
            </div>
          )}
          {logoMode && (
            <>
              <div className="absolute inset-x-0 bottom-0 h-[45%]" style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.85) 100%)' }} />
              <img src={tmdbImage.logo(card.logoPath)!} alt="" loading="lazy" decoding="async"
                className="absolute inset-x-[10%] bottom-[6%] h-[20%] w-[80%] object-contain object-bottom drop-shadow-[0_1px_6px_rgba(0,0,0,0.6)]" />
            </>
          )}
          <div className="absolute left-0 right-0 top-0 flex items-start justify-between p-2">
            <span className="pointer-events-none rounded-full bg-gray-900/70 px-2 type-badge-tag uppercase tracking-wide text-ink-secondary ring-1 ring-white/10">
              {card.kind === 'movie' ? 'Movie' : 'Series'}
            </span>
            <StatusBadgeMini state={card.seerr} />
          </div>
          <div aria-hidden className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100">
            <div className="absolute inset-x-0 bottom-0 top-1/3" style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.88) 100%)' }} />
            <div className="absolute inset-x-0 bottom-0 px-2 pb-2 text-white">
              {card.year && <div className="type-caption-default">{card.year}</div>}
              <h2 className="type-title-item whitespace-normal md:type-title-card"
                style={{ WebkitLineClamp: 3, display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical', wordBreak: 'break-word' }}>
                {card.title}
              </h2>
              {(added || card.backOnNetflix) && <div className="mt-1 type-body-xsmall text-ink-secondary">{card.backOnNetflix ? `Back · ${added?.replace('Added ', '')}` : added}</div>}
            </div>
          </div>
        </div>
      </div>
      <div className={`mt-1.5 truncate type-caption-default ${line ? toneClass[line.tone] : 'text-transparent'}`}>{line?.text ?? '·'}</div>
    </Link>
  );
}

export function TitleCardPlaceholder({ fill = false }: { fill?: boolean }) {
  return (
    <div className={`${fill ? 'w-full' : 'w-[7.5rem] md:w-44'} flex-shrink-0`}>
      <div className="relative animate-pulse rounded-xl bg-raised ring-1 ring-line" style={{ paddingBottom: '150%' }} />
      <div className="mt-1.5 h-[18px]" />
    </div>
  );
}
