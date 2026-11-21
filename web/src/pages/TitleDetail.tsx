import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMeta, useTitle, type TitleDetail as Detail } from '../lib/api';
import { languageName, longDate, runtime, SERVICE_NAMES, shortDate, tmdbImage } from '../lib/format';
import { Badge, Button, Credits, Empty, Spinner } from '../components/ui';
import { TrailerModal } from '../components/TrailerModal';
import { RequestButton } from '../components/RequestButton';
import { TitleCard } from '../components/TitleCard';
import { Icons } from '../components/icons';
import { useMediaQuery } from '../components/Layout';

const seerrLabel = { available: 'Available', partial: 'Partially available', requested: 'Requested', processing: 'Processing' } as const;

/**
 * Title page (Figma Build screen 5, Apple TV style): the textless poster fills the
 * top of the phone screen, fading to black, with the title logo on the fade. On a
 * wide screen the wide clean backdrop does the same. Titles without that art use
 * the regular backdrop and a text title.
 */
export function TitleDetail() {
  const id = Number(useParams().id);
  const t = useTitle(id);
  const [trailer, setTrailer] = useState(false);
  const wide = useMediaQuery('(min-width: 1024px)');

  if (t.isPending) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (t.isError || !t.data) return <Empty>That title isn’t on any of your services.</Empty>;
  const d = t.data;
  const heroArt = wide ? tmdbImage.backdrop(d.backdropPath) : d.textlessPosterPath ? tmdbImage.textlessLarge(d.textlessPosterPath) : tmdbImage.posterLarge(d.posterPath) ?? tmdbImage.backdrop(d.backdropPath);
  const logo = tmdbImage.logo(d.logoPath);
  const genreLine = [d.kind === 'movie' ? 'Movie' : 'Series', ...d.genres.slice(0, 2).map((g) => g.name), d.year].filter(Boolean).join(' · ');

  return (
    <div className="-mx-4">
      <Hero art={heroArt} wide={wide}>
        {logo ? (
          <img src={logo} alt={d.title} className="mx-auto h-24 w-[72%] max-w-sm object-contain object-bottom drop-shadow-[0_2px_10px_rgba(0,0,0,0.7)] lg:mx-0 lg:h-28 lg:w-auto lg:max-w-md lg:object-left-bottom" />
        ) : (
          <h1 className="type-heading-page text-white lg:text-4xl">
            {d.title}{d.year && <span className="type-heading-page-suffix text-ink-muted"> ({d.year})</span>}
          </h1>
        )}
        <p className="mt-3 type-body-lead text-ink-secondary">{genreLine}</p>
        {d.soon && <div className="mt-3 flex justify-center lg:justify-start"><Badge type="primary">Coming {shortDate(d.soon.date)}</Badge></div>}
        <div className="mt-4 flex justify-center gap-3 lg:justify-start">
          <RequestButton d={d} />
          {d.trailer && (
            <Button buttonType="ghost" onClick={() => setTrailer(true)}>
              <Icons.trailer className="h-5 w-5" />
              <span>Trailer</span>
            </Button>
          )}
        </div>
      </Hero>

      <div className="px-4 lg:grid lg:grid-cols-[1fr_20rem] lg:gap-8">
        <div className="min-w-0">
          {d.overview
            ? <p className="mt-2 type-body-default text-ink-strong lg:text-base">{d.overview}</p>
            : <p className="mt-2 type-body-default text-ink-muted">{d.soon ? 'No overview yet. It fills in from TMDB as the premiere gets closer.' : 'No overview on TMDB yet.'}</p>}
          {d.newSeason && <NewSeasonBanner d={d} />}
          <WhereToWatch d={d} />
          {d.cast.length > 0 && <CastRow people={d.cast} />}
          {d.related.length > 0 && (
            <section className="mt-8">
              <h2 className="slider-title mb-3">Related</h2>
              <div className="scrollbar-none -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 md:gap-4">
                {d.related.map((c) => <div key={c.id} className="snap-start"><TitleCard card={c} /></div>)}
              </div>
            </section>
          )}
        </div>
        <Facts d={d} />
      </div>
      <div className="px-4"><Credits /></div>
      {trailer && d.trailer && <TrailerModal videoKey={d.trailer.key} title={d.trailer.name ? `${d.title} · ${d.trailer.name}` : d.title} onClose={() => setTrailer(false)} />}
    </div>
  );
}

function Hero({ art, wide, children }: { art: string | null; wide: boolean; children: React.ReactNode }) {
  // The title block sits on the bottom of the art, on its fade, so the page below never runs under it.
  return (
    <div className={`relative w-full overflow-hidden ${wide ? 'min-h-[34rem]' : 'min-h-[min(150vw,78vh)]'} flex flex-col justify-end`}>
      {art ? <img src={art} alt="" className="absolute inset-0 h-full w-full object-cover object-top" /> : <div className="absolute inset-0 bg-surface" />}
      <div className="absolute inset-x-0 bottom-0 h-[65%]" style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.9) 70%, #000 100%)' }} />
      {wide && <div className="absolute inset-y-0 left-0 w-2/3" style={{ background: 'linear-gradient(90deg, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0) 100%)' }} />}
      <div className="relative px-4 pb-6 pt-40 text-center lg:max-w-2xl lg:px-8 lg:text-left">{children}</div>
    </div>
  );
}

/** Figma "New season of a series you have": above Where to watch, with its own Request button. */
function NewSeasonBanner({ d }: { d: Detail }) {
  const ns = d.newSeason!;
  const where = d.watch.services[0]?.name;
  return (
    <section className="mt-6 flex items-center gap-4 rounded-xl bg-indigo-500 px-4 py-4">
      <div className="min-w-0 flex-1">
        <h2 className="type-heading-section text-white">Season {ns.season} is out</h2>
        <p className="mt-0.5 type-body-default text-indigo-100">
          You have season{ns.haveThrough === 1 ? ' 1' : `s 1–${ns.haveThrough}`}.{where ? ` On ${where}.` : ''}
        </p>
      </div>
      <RequestButton d={{ ...d, download: null }} />
    </section>
  );
}

/** Figma "Where to watch": a row per service, then rent or buy stores, or the premiere for coming soon. */
function WhereToWatch({ d }: { d: Detail }) {
  const rows: { tag: string; tone: 'service' | 'digital' | 'soon'; text: string }[] = [];
  for (const s of d.watch.services) rows.push({ tag: s.name, tone: 'service', text: 'Included with your subscription' });
  if (d.watch.soon) {
    const where = d.watch.soon.service ? SERVICE_NAMES[d.watch.soon.service] : null;
    rows.push({ tag: `${shortDate(d.watch.soon.date)} · ${where ?? 'Rent or buy'}`, tone: 'soon',
      text: where ? `Streams on ${where} from ${shortDate(d.watch.soon.date)}. It moves to New on your services that day.` : `Out to rent or buy from ${shortDate(d.watch.soon.date)}.` });
  }
  if (d.watch.stores.length || d.digital) {
    rows.push({ tag: 'Rent or buy', tone: 'digital', text: d.watch.services.length ? d.watch.stores.join(', ') || 'Digital stores' : `Not on your services yet. Rent or buy on ${d.watch.stores.slice(0, 3).join(', ') || 'digital stores'}.` });
  }
  if (!rows.length) return null;
  const tagClass = {
    service: 'bg-gray-900/85 text-white ring-1 ring-line-strong',
    digital: 'bg-tag-digital-bg/90 text-amber-100 ring-1 ring-tag-digital-border',
    soon: 'bg-tag-soon-bg/95 text-white ring-1 ring-tag-soon-border',
  };
  return (
    <section className="mt-6">
      <h2 className="type-heading-group text-white">Where to watch</h2>
      <div className="mt-3 overflow-hidden rounded-lg border border-line">
        {rows.map((r, i) => (
          <div key={i} className={`flex items-center gap-3 px-3 py-3 ${i ? 'border-t border-line' : ''}`}>
            <span className="w-[5.5rem] flex-shrink-0">
              <span className={`inline-block max-w-full truncate rounded-full px-2 type-badge-tag leading-5 ${tagClass[r.tone]}`}>{r.tag}</span>
            </span>
            <span className="min-w-0 type-body-default text-ink-tertiary">{r.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Figma "PersonCard": headshot (TMDB profile photo) or initials, name, role. */
function CastRow({ people }: { people: Detail['cast'] }) {
  return (
    <section className="mt-8">
      <h2 className="slider-title mb-3">Cast &amp; Crew</h2>
      <div className="scrollbar-none -mx-4 flex gap-3 overflow-x-auto px-4 pb-2">
        {people.map((p, i) => <Person key={`${p.name}-${i}`} p={p} />)}
      </div>
    </section>
  );
}

function Person({ p }: { p: Detail['cast'][number] }) {
  const [broken, setBroken] = useState(false);
  const photo = broken ? null : tmdbImage.profile(p.profilePath);
  const initials = p.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <div className="w-[5.75rem] flex-shrink-0 text-center">
      <div className="mx-auto flex h-[5.5rem] w-[5.5rem] items-center justify-center overflow-hidden rounded-full bg-raised ring-1 ring-line">
        {photo ? <img src={photo} alt="" loading="lazy" onError={() => setBroken(true)} className="h-full w-full object-cover" />
          : <span className="type-heading-section text-ink-secondary">{initials}</span>}
      </div>
      <div className="mt-2 type-caption-strong text-white" style={{ WebkitLineClamp: 2, display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical' }}>{p.name}</div>
      {p.role && <div className="type-body-xsmall text-ink-muted" style={{ WebkitLineClamp: 2, display: '-webkit-box', overflow: 'hidden', WebkitBoxOrient: 'vertical' }}>{p.role}</div>}
    </div>
  );
}

function Facts({ d }: { d: Detail }) {
  const meta = useMeta();
  const added = d.addedAt ? longDate(d.addedAt) : meta.data?.trackingSince && !d.soon ? `Before ${longDate(meta.data.trackingSince)}` : null;
  return (
    <div className="mt-8 lg:mt-2">
      <div className="media-facts">
        {d.voteAverage !== null && d.voteCount ? (
          <div className="media-fact justify-end gap-1.5">
            <Icons.star className="h-4 w-4 self-center text-rating" />
            <span>{d.voteAverage.toFixed(1)} TMDB</span>
            <span className="font-normal text-ink-muted">· {d.voteCount.toLocaleString()} votes</span>
          </div>
        ) : null}
        {d.soon
          ? <Fact label={d.soon.service ? `Coming to ${SERVICE_NAMES[d.soon.service]}` : 'Out to rent or buy'} value={longDate(d.soon.date)} />
          : <Fact label="Added" value={added} />}
        <Fact label={d.kind === 'movie' ? 'Release date' : 'First aired'} value={longDate(d.releaseDate)} />
        <Fact label="Original language" value={languageName(d.originalLanguage)} />
        {d.kind === 'movie' ? <Fact label="Runtime" value={runtime(d.runtime)} /> : <Fact label="Seasons" value={d.seasons ? String(d.seasons) : null} />}
        {d.certification && <Fact label="Rated" value={d.certification} />}
        <Fact label="Seerr status" value={d.seerr ? seerrLabel[d.seerr] : 'Not requested'} />
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="media-fact">
      <span>{label}</span>
      <span className="media-fact-value">{value}</span>
    </div>
  );
}
