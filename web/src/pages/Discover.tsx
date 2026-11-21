import { useSearchParams } from 'react-router-dom';
import { useHome, useMeta, type ServiceKey } from '../lib/api';
import { longDate } from '../lib/format';
import { Slider, SliderPlaceholder } from '../components/Slider';
import { Credits, Empty, Spinner } from '../components/ui';

/** Service chips (Figma "FilterChip"): All, or one or more services. Kept in the URL so Back returns to them. */
function ServiceChips({ value, onChange }: { value: ServiceKey[]; onChange: (v: ServiceKey[]) => void }) {
  const services = useMeta().data?.services ?? [];
  if (services.length < 2) return null;
  const chip = (on: boolean) =>
    `flex-shrink-0 rounded-full px-3.5 py-1.5 type-label-default transition ${on ? 'bg-inverse text-ink-inverse' : 'bg-surface text-ink-secondary ring-1 ring-inset ring-line-strong hover:bg-raised'}`;
  const toggle = (k: ServiceKey) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  return (
    <div className="scrollbar-none -mx-4 mt-4 flex gap-2 overflow-x-auto px-4 lg:mt-2" role="group" aria-label="Services">
      <button type="button" className={chip(value.length === 0)} aria-pressed={value.length === 0} onClick={() => onChange([])}>All</button>
      {services.map((s) => (
        <button key={s.key} type="button" className={chip(value.includes(s.key))} aria-pressed={value.includes(s.key)} onClick={() => toggle(s.key)}>{s.name}</button>
      ))}
    </div>
  );
}

export function Discover() {
  const [params, setParams] = useSearchParams();
  const only = (params.get('services')?.split(',').filter(Boolean) ?? []) as ServiceKey[];
  const home = useHome(only);
  const setOnly = (v: ServiceKey[]) => setParams(v.length ? { services: v.join(',') } : {}, { replace: true });
  if (home.isError) return <Empty>Couldn’t load titles. Is the sync running?</Empty>;
  return (
    <>
      <ServiceChips value={only} onChange={setOnly} />
      {home.isPlaceholderData && <div className="mt-3 flex items-center gap-2 type-body-small text-ink-tertiary"><Spinner className="h-4 w-4" /> Updating rows…</div>}
      {home.data?.showTrackingNotice && (
        <div className="mt-4 rounded-md border border-indigo-500 bg-indigo-500/10 px-3 py-2.5 text-indigo-100">
          <p className="type-label-strong">
            {home.data.trackingSince ? `Tracking since ${longDate(home.data.trackingSince)}` : 'Starting to track your services'}
          </p>
          <p className="mt-0.5 type-body-default">“Just released” fills in as titles arrive. Until then, the newest releases lead.</p>
        </div>
      )}
      {home.isPending
        ? ['Just released', 'Available from theaters', 'Coming soon', 'Stand-up specials'].map((t) => <SliderPlaceholder key={t} title={t} />)
        : <div className={`transition-opacity ${home.isPlaceholderData ? 'pointer-events-none opacity-40' : ''}`}>{home.data.rows.map((row) => <Slider key={row.slug} row={row} />)}</div>}
      {home.data && home.data.rows.length === 0 && <Empty>No titles yet. The first sync is still running.</Empty>}
      <Credits />
    </>
  );
}
