import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowDownTrayIcon, FilmIcon } from '@heroicons/react/24/outline';
import { StarIcon } from '@heroicons/react/20/solid';
import { useMeta, useTitle } from '../lib/api';
import { languageName, longDate, runtime, seasons, tmdbImage } from '../lib/format';
import { Badge, Button, Credits, Empty, Spinner, statusBadge } from '../components/ui';
import { TrailerModal } from '../components/TrailerModal';

const seerrLabel = { available: 'Available', partial: 'Partially available', requested: 'Requested', processing: 'Processing' } as const;

export function TitleDetail() {
  const id = Number(useParams().id);
  const t = useTitle(id);
  const meta = useMeta();
  const [trailer, setTrailer] = useState(false);

  if (t.isPending) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (t.isError || !t.data) return <Empty>That title isn’t in the Netflix catalog.</Empty>;
  const d = t.data;
  const poster = tmdbImage.posterLarge(d.posterPath);
  const backdrop = tmdbImage.backdrop(d.backdropPath);
  const attrs = [d.certification, d.kind === 'movie' ? runtime(d.runtime) : seasons(d.seasons), d.genres.map((g) => g.name).join(', ')].filter(Boolean);
  const added = d.addedAt
    ? `Added to Netflix ${longDate(d.addedAt)?.replace(/, \d{4}$/, '')}`
    : meta.data?.trackingSince ? `On Netflix before ${longDate(meta.data.trackingSince)?.replace(/, \d{4}$/, '')}` : null;

  return (
    <div className="media-page" style={{ height: 'auto' }}>
      {backdrop && (
        <div className="media-page-bg-image">
          <img src={backdrop} alt="" className="h-full w-full object-cover" style={{ maxHeight: 560 }} />
          <div className="absolute inset-0" style={{ backgroundImage: 'linear-gradient(rgba(17, 24, 39, 0.47) 0%, rgba(17, 24, 39, 1) 100%)', maxHeight: 560 }} />
          <div className="absolute inset-x-0 bg-gray-900" style={{ top: 560, bottom: 0 }} />
        </div>
      )}
      <div className="relative">
        <div className="media-header">
          <div className="media-poster">
            {poster ? <img src={poster} alt="" className="h-full w-full" /> : (
              <div className="flex aspect-[2/3] items-center justify-center bg-gray-800"><FilmIcon className="h-12 w-12 text-gray-600" /></div>
            )}
          </div>
          <div className="media-title">
            <div className="media-status">
              {added && <Badge type={d.addedAt ? 'primary' : 'default'}>{added}</Badge>}
              {d.backOnNetflix && <Badge type="primary">Back on Netflix</Badge>}
              <Badge>{d.kind === 'movie' ? 'Movie' : 'Series'}</Badge>
              {statusBadge(d.seerr)}
              {!d.onNetflix && <Badge type="warning">Left Netflix</Badge>}
            </div>
            <h1 data-testid="media-title">
              {d.title}{d.year && <span className="media-year"> ({d.year})</span>}
            </h1>
            <span className="media-attributes">
              {attrs.map((a, i) => (
                <span key={i}>{i > 0 && <span className="mx-1">|</span>}{a}</span>
              ))}
            </span>
          </div>
          <div className="media-actions">
            <Button buttonType="primary" disabled title="Requesting arrives in the next update">
              <ArrowDownTrayIcon className="h-5 w-5" />
              <span>Request</span>
            </Button>
            {d.trailer && (
              <Button onClick={() => setTrailer(true)}>
                <FilmIcon className="h-5 w-5" />
                <span>Play trailer</span>
              </Button>
            )}
          </div>
        </div>

        <div className="media-overview">
          <div className="media-overview-left">
            {d.overview ? <p>{d.overview}</p> : <p className="italic">No overview on TMDB yet.</p>}
          </div>
          <div className="media-overview-right">
            <div className="media-facts">
              {d.voteAverage !== null && (
                <div className="media-fact justify-end gap-1.5">
                  <StarIcon className="h-4 w-4 self-center text-amber-300" />
                  <span>{d.voteAverage.toFixed(1)} TMDB</span>
                  <span className="font-normal text-gray-400">· {d.voteCount?.toLocaleString()} votes</span>
                </div>
              )}
              <Fact label="Added to Netflix" value={d.addedAt ? longDate(d.addedAt) : meta.data?.trackingSince ? `Before ${longDate(meta.data.trackingSince)}` : null} />
              <Fact label={d.kind === 'movie' ? 'Release date' : 'First aired'} value={longDate(d.releaseDate)} />
              <Fact label="Original language" value={languageName(d.originalLanguage)} />
              {d.kind === 'movie' ? <Fact label="Runtime" value={runtime(d.runtime)} /> : <Fact label="Seasons" value={d.seasons ? String(d.seasons) : null} />}
              <Fact label="Seerr status" value={d.seerr ? seerrLabel[d.seerr] : 'Not requested'} />
            </div>
          </div>
        </div>
        <Credits />
      </div>
      {trailer && d.trailer && <TrailerModal videoKey={d.trailer.key} title={d.trailer.name ? `${d.title} · ${d.trailer.name}` : d.title} onClose={() => setTrailer(false)} />}
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
