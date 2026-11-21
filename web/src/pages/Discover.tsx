import { useHome } from '../lib/api';
import { longDate } from '../lib/format';
import { Slider, SliderPlaceholder } from '../components/Slider';
import { Credits, Empty } from '../components/ui';

export function Discover() {
  const home = useHome();
  if (home.isError) return <Empty>Couldn’t load Netflix titles. Is the sync running?</Empty>;
  return (
    <>
      {home.data?.showTrackingNotice && (
        <div className="mt-4 rounded-md border border-indigo-500 bg-indigo-500/10 px-3 py-2.5 text-indigo-100">
          <p className="text-sm font-semibold">
            {home.data.trackingSince ? `Tracking Netflix since ${longDate(home.data.trackingSince)}` : 'Starting to track Netflix'}
          </p>
          <p className="mt-0.5 text-sm">“New on Netflix” rows fill in as Netflix adds titles. Until then, the newest releases and episodes lead.</p>
        </div>
      )}
      {home.isPending
        ? ['New on Netflix this week', 'New movies', 'New episodes and seasons', 'Stand-up specials'].map((t) => <SliderPlaceholder key={t} title={t} />)
        : home.data.rows.map((row) => <Slider key={row.slug} row={row} />)}
      {home.data && home.data.rows.length === 0 && <Empty>No titles yet. The first sync is still running.</Empty>}
      <Credits />
    </>
  );
}
