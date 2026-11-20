import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FilmIcon } from '@heroicons/react/24/outline';
import { StarIcon } from '@heroicons/react/20/solid';
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
      <div className="mb-3 flex" role="tablist">
        {(['movie', 'series'] as const).map((k, i) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={`flex-1 border py-2 text-sm font-medium transition sm:flex-none sm:px-8 ${i === 0 ? 'rounded-l-md' : 'rounded-r-md'} ${
              kind === k ? 'border-indigo-500 bg-indigo-600/80 text-white' : 'border-gray-600 bg-gray-800/80 text-gray-200 hover:bg-gray-700'
            }`}
          >
            {k === 'movie' ? 'Movies' : 'Series'}
          </button>
        ))}
      </div>
      <p className="mb-4 text-sm font-medium text-gray-400">
        Ranked by TMDB score · at least {top.data?.minVotes.toLocaleString() ?? 200} votes · English-original
      </p>
      {top.isPending ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : top.isError ? (
        <Empty>Couldn’t load the ranking.</Empty>
      ) : top.data.items.length === 0 ? (
        <Empty>No titles have enough votes yet.</Empty>
      ) : (
        <ol className="grid gap-3 lg:grid-cols-2">
          {top.data.items.map((t) => {
            const poster = tmdbImage.poster(t.posterPath);
            return (
              <li key={t.id}>
                <Link to={`/title/${t.id}`} className="flex items-center gap-3 rounded-xl bg-gray-800 p-3 ring-1 ring-inset ring-gray-700 transition hover:ring-gray-500">
                  <span className="text-overseerr w-7 flex-shrink-0 text-center text-2xl font-bold">{t.rank}</span>
                  <span className="relative h-[84px] w-14 flex-shrink-0 overflow-hidden rounded-md bg-gray-700 ring-1 ring-inset ring-gray-700">
                    {poster ? <img src={poster} alt="" loading="lazy" className="h-full w-full object-cover" /> : <FilmIcon className="m-auto mt-7 h-6 w-6 text-gray-500" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 block font-bold leading-snug text-white">{t.title}</span>
                    <span className="mt-0.5 block text-sm text-gray-300">{[t.year, runtime(t.runtime)].filter(Boolean).join(' · ')}</span>
                    <span className="mt-0.5 flex items-center gap-1 text-sm">
                      <StarIcon className="h-4 w-4 text-amber-300" />
                      <span className="font-semibold text-gray-100">{t.voteAverage?.toFixed(1)}</span>
                      <span className="text-gray-400">· {t.voteCount?.toLocaleString()} votes</span>
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
