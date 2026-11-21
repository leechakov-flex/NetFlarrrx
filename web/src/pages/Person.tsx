import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { usePerson, type PersonResponse } from '../lib/api';
import { tmdbImage } from '../lib/format';
import { Credits, Empty, PageTitle, Spinner } from '../components/ui';
import { TitleCard } from '../components/TitleCard';
import { Icons } from '../components/icons';

/**
 * Person (Figma Build screen 11): tapped from Cast & Crew. Their photo and bio,
 * what they're in that's on your services, then the rest of their best-known work.
 */
export function Person() {
  const [params] = useSearchParams();
  const id = Number(params.get('id')) || null;
  const q = usePerson(id, params.get('name'));
  const [more, setMore] = useState(false);
  if (q.isPending) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (q.isError || !q.data) return <Empty>Couldn’t find that person on TMDB.</Empty>;
  const p = q.data;
  const photo = tmdbImage.profile(p.profilePath);
  const bio = p.biography ?? '';
  return (
    <>
      <div className="flex items-center gap-4 pt-2">
        <div className="flex h-24 w-24 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-raised ring-1 ring-line">
          {photo ? <img src={photo} alt="" className="h-full w-full object-cover" /> : <Icons.film className="h-8 w-8 text-ink-muted" />}
        </div>
        <div className="min-w-0">
          <PageTitle>{p.name}</PageTitle>
          {p.department && <p className="-mt-3 type-body-default text-ink-tertiary">{p.department === 'Acting' ? 'Actor' : p.department}</p>}
        </div>
      </div>
      {bio && (
        <p className="mt-4 max-w-3xl type-body-default text-ink-strong">
          {more || bio.length < 320 ? bio : `${bio.slice(0, 300).replace(/\s+\S*$/, '')}… `}
          {bio.length >= 320 && <button type="button" className="type-label-default text-indigo-300" onClick={() => setMore(!more)}>{more ? ' Less' : 'More'}</button>}
        </p>
      )}

      <section className="mt-8">
        <h2 className="slider-title mb-3">On your services{p.onServices.length ? <span className="ml-2 type-body-default font-normal text-ink-muted">{p.onServices.length}</span> : null}</h2>
        {p.onServices.length ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
            {p.onServices.map((c) => (
              <div key={c.id}>
                <TitleCard card={c} fill />
                {c.role && <p className="mt-0.5 truncate type-body-xsmall text-ink-muted">{c.role}</p>}
              </div>
            ))}
          </div>
        ) : <p className="type-body-default text-ink-tertiary">Nothing they’re in is on your services right now.</p>}
      </section>

      {p.elsewhere.length > 0 && <Elsewhere items={p.elsewhere} />}
      <Credits />
    </>
  );
}

/** Not on your services: shown for reference, and searchable in case it's on one under another name. */
function Elsewhere({ items }: { items: PersonResponse['elsewhere'] }) {
  return (
    <section className="mt-10">
      <h2 className="slider-title mb-1">Also known for</h2>
      <p className="mb-3 type-caption-default text-ink-muted">Not on your services.</p>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
        {items.map((c) => {
          const poster = tmdbImage.poster(c.posterPath);
          return (
            <Link key={`${c.tmdbType}:${c.tmdbId}`} to={`/search?q=${encodeURIComponent(c.title)}`} className="group block opacity-80 transition hover:opacity-100">
              <div className="relative overflow-hidden rounded-xl bg-surface ring-1 ring-line" style={{ paddingBottom: '150%' }}>
                {poster ? <img src={poster} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover grayscale-[35%]" />
                  : <div className="absolute inset-0 flex items-center justify-center p-2 text-center type-caption-strong text-ink-secondary">{c.title}</div>}
              </div>
              <div className="mt-1.5 truncate type-caption-strong text-white">{c.title}</div>
              <div className="truncate type-body-xsmall text-ink-muted">{[c.year, c.role].filter(Boolean).join(' · ')}</div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
