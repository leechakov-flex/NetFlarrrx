import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { usePerson, type PersonResponse } from '../lib/api';
import { tmdbImage } from '../lib/format';
import { Empty, Spinner } from '../components/ui';
import { TitleCard } from '../components/TitleCard';
import { Icons } from '../components/icons';
import { BackButton } from '../components/Layout';

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
    // Figma Mobile / Person: 16px between blocks; back button as the top bar on phones.
    <div className="flex flex-col gap-4 pt-4">
      <BackButton className="lg:hidden" />
      <div className="flex items-center gap-4">
        <div className="flex h-24 w-24 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-raised ring-1 ring-line">
          {photo ? <img src={photo} alt="" className="h-full w-full object-cover" /> : <Icons.film className="h-8 w-8 text-ink-muted" />}
        </div>
        <div className="min-w-0">
          <h1 className="truncate type-heading-page text-ink-accent">{p.name}</h1>
          {p.department && <p className="mt-0.5 type-body-default text-ink-tertiary">{p.department === 'Acting' ? 'Actor' : p.department}</p>}
        </div>
      </div>
      {bio && (
        <p className="max-w-3xl type-body-default text-ink-strong">
          {more || bio.length < 320 ? bio : `${bio.slice(0, 300).replace(/\s+\S*$/, '')}… `}
          {bio.length >= 320 && <button type="button" className="type-label-default text-indigo-300" onClick={() => setMore(!more)}>{more ? ' Less' : 'More'}</button>}
        </p>
      )}

      <section>
        <h2 className="mb-4 flex h-7 items-baseline gap-2 type-heading-section text-ink-primary">On your services{p.onServices.length ? <span className="type-body-default text-ink-muted">{p.onServices.length}</span> : null}</h2>
        {p.onServices.length ? (
          <div className="grid grid-cols-3 gap-x-[11px] gap-y-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
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
    </div>
  );
}

/** Not on your services: shown for reference, and searchable in case it's on one under another name. */
function Elsewhere({ items }: { items: PersonResponse['elsewhere'] }) {
  return (
    <section>
      <h2 className="flex h-7 items-center type-heading-section text-ink-primary">Also known for</h2>
      <p className="mb-4 mt-4 type-caption-default text-ink-muted">Not on your services. Tapping one searches all services for it.</p>
      <div className="grid grid-cols-3 gap-x-[11px] gap-y-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
        {items.map((c) => {
          const poster = tmdbImage.poster(c.posterPath);
          return (
            <Link key={`${c.tmdbType}:${c.tmdbId}`} to={`/search?q=${encodeURIComponent(c.title)}`} className="group block opacity-80 transition hover:opacity-100">
              <div className="relative overflow-hidden rounded-xl bg-surface ring-1 ring-line" style={{ paddingBottom: '150%' }}>
                {poster ? <img src={poster} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover grayscale-[35%]" />
                  : <div className="absolute inset-0 flex items-center justify-center p-2 text-center type-caption-strong text-ink-secondary">{c.title}</div>}
              </div>
              <div className="mt-0.5 truncate type-caption-strong text-ink-primary">{c.title}</div>
              <div className="truncate type-body-xsmall text-ink-muted">{[c.year, c.role].filter(Boolean).join(' · ')}</div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
