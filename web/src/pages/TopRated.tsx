import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../components/icons';
const FilmIcon = Icons.film, StarIcon = Icons.star;
import type { Kind } from '../lib/api';
import { useTop } from '../lib/api';
import { runtime, tmdbImage } from '../lib/format';
import { Credits, Empty, PageTitle, Spinner, StatusBadgeMini } from '../components/ui';

export function TopRated() {
  const [kind, setKind] = useState<Kind>('movie');
  const top = useTop(kind);
  return (
    <>
      <PageTitle>Top rated</PageTitle>
      {/* Figma "Type toggle": two halves, the chosen one white. */}
      <div className="mb-4 flex overflow-hidden rounded-md ring-1 ring-inset ring-line-strong sm:inline-flex" role="tablist">
        {(['movie', 'series'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={`flex-1 py-2 type-label-default transition sm:flex-none sm:px-8 ${
              kind === k ? 'bg-inverse text-ink-inverse' : 'bg-app text-ink-secondary hover:bg-raised'
            }`}
          >
            {k === 'movie' ? 'Movies' : 'Series'}
          </button>
        ))}
      </div>
      <p className="mb-4 type-caption-default text-ink-muted">
        Ranked by TMDB score · at least {top.data?.minVotes.toLocaleString() ?? 200} votes · English-original
      </p>
      {top.isPending ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : top.isError ? (
        <Empty>Couldn’t load the ranking.</Empty>
      ) : top.data.items.length === 0 ? (
        <Empty>No titles have enough votes yet.</Empty>
      ) : (
        <ol className="grid gap-4 lg:grid-cols-2 lg:gap-x-8">
          {top.data.items.map((t) => {
            const poster = tmdbImage.poster(t.posterPath);
            return (
              <li key={t.id}>
                <Link to={`/title/${t.id}`} className="group flex items-center gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">
                  <span className="w-[26px] flex-shrink-0 text-center type-heading-section text-ink-primary">{t.rank}</span>
                  <span className="relative h-[84px] w-14 flex-shrink-0 overflow-hidden rounded-md bg-raised ring-1 ring-line">
                    {poster ? <img src={poster} alt="" loading="lazy" className="h-full w-full object-cover" /> : <FilmIcon className="m-auto mt-7 h-6 w-6 text-gray-500" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 block type-title-item text-ink-primary group-hover:underline">{t.title}</span>
                    <span className="mt-1 block type-body-small text-ink-tertiary">{[t.year, runtime(t.runtime)].filter(Boolean).join(' · ')}</span>
                    <span className="mt-1 flex items-center gap-1 type-body-small">
                      <StarIcon className="h-4 w-4 text-rating" />
                      <span className="type-caption-strong text-ink-strong">{t.voteAverage?.toFixed(1)}</span>
                      <span className="text-ink-muted">· {t.voteCount?.toLocaleString()} votes</span>
                    </span>
                  </span>
                  <StatusBadgeMini state={t.seerr} />
                </Link>
              </li>
            );
          })}
        </ol>
      )}
      <Credits />
    </>
  );
}
