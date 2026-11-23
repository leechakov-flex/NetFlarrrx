import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useHome, useMeta, type CompanyPick, type ServiceKey } from '../lib/api';
import { CompanyPickerSheet, useCompanyNames } from '../components/CompanyPicker';
import { Icons } from '../components/icons';
import { Slider, SliderPlaceholder } from '../components/Slider';
import { Empty, LoadError, Spinner } from '../components/ui';

const chip = (on: boolean) =>
  `flex flex-shrink-0 items-center gap-1 rounded-full px-3 py-1.5 type-label-default transition ${on ? 'bg-inverse text-ink-inverse' : 'bg-app text-ink-secondary ring-1 ring-inset ring-line-strong hover:bg-raised'}`;

/**
 * Discover filter chips (Figma "FilterChip"): All, the services, then any studios or
 * networks you picked (tap to remove) and "Studio or network" to pick some.
 * Kept in the URL so Back returns to them.
 */
function FilterChips({ value, onChange, co, onCo }: { value: ServiceKey[]; onChange: (v: ServiceKey[]) => void; co: CompanyPick; onCo: (v: CompanyPick) => void }) {
  const services = useMeta().data?.services ?? [];
  const name = useCompanyNames();
  const [picker, setPicker] = useState(false);
  const toggle = (k: ServiceKey) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  const picked = [...(co.studios ?? []).map((k) => ['studios', k] as const), ...(co.networks ?? []).map((k) => ['networks', k] as const)];
  const none = value.length === 0 && picked.length === 0;
  return (
    <>
      {/* Sticky under the status bar (phone) or the search bar (desktop), on the same frosted background. */}
      <div className="sticky top-[env(safe-area-inset-top)] z-10 -mx-4 mt-2 bg-app/80 py-2 backdrop-blur lg:-mx-8 lg:mt-0 lg:top-[68px] lg:py-0 lg:pb-2">
      <div className="scrollbar-none flex gap-2 overflow-x-auto px-4 lg:px-8" role="group" aria-label="Filter Discover">
        <button type="button" className={chip(none)} aria-pressed={none} onClick={() => { onChange([]); onCo({}); }}>All</button>
        {services.length > 1 && services.map((s) => (
          <button key={s.key} type="button" className={chip(value.includes(s.key))} aria-pressed={value.includes(s.key)} onClick={() => toggle(s.key)}>{s.name}</button>
        ))}
        {picked.map(([kind, k]) => (
          <button key={`${kind}:${k}`} type="button" className={chip(true)} aria-label={`Remove ${name(k)}`}
            onClick={() => onCo({ ...co, [kind]: co[kind]!.filter((x) => x !== k) })}>
            {name(k)}<Icons.xmark className="h-3.5 w-3.5" />
          </button>
        ))}
        <button type="button" className={chip(false)} onClick={() => setPicker(true)}>
          <Icons.plus className="h-3.5 w-3.5" />Studio or network
        </button>
      </div>
      </div>
      <CompanyPickerSheet open={picker} onClose={() => setPicker(false)} value={co} onApply={onCo} />
    </>
  );
}

export function Discover() {
  const [params, setParams] = useSearchParams();
  const only = (params.get('services')?.split(',').filter(Boolean) ?? []) as ServiceKey[];
  const list = (k: string) => params.get(k)?.split(',').filter(Boolean) ?? [];
  const co: CompanyPick = { studios: list('studios'), networks: list('networks') };
  const home = useHome(only, co);
  const save = (services: ServiceKey[], c: CompanyPick) => {
    const p: Record<string, string> = {};
    if (services.length) p.services = services.join(',');
    if (c.studios?.length) p.studios = c.studios.join(',');
    if (c.networks?.length) p.networks = c.networks.join(',');
    setParams(p, { replace: true });
  };
  if (home.isError) return <LoadError what="Discover" onRetry={() => void home.refetch()} />;
  return (
    <>
      <FilterChips value={only} onChange={(v) => save(v, co)} co={co} onCo={(c) => save(only, c)} />
      {home.isPlaceholderData && <div className="mt-3 flex items-center gap-2 type-body-small text-ink-tertiary"><Spinner className="h-4 w-4" /> Updating rows…</div>}
      {home.isPending
        ? ['Just released', 'Available from theaters', 'Coming soon', 'Stand-up specials'].map((t) => <SliderPlaceholder key={t} title={t} />)
        : <div className={`transition-opacity ${home.isPlaceholderData ? 'pointer-events-none opacity-40' : ''}`}>{home.data.rows.map((row) => <Slider key={row.slug} row={row} />)}</div>}
      {home.data && home.data.rows.length === 0 && <Empty>No titles yet. The first sync is still running.</Empty>}
    </>
  );
}
