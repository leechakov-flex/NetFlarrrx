import { useMemo, useState } from 'react';
import { useCompanies, type CompanyOption, type CompanyPick } from '../lib/api';
import { Icons } from './icons';
import { Button, Spinner } from './ui';
import { SlideOver } from './SlideOver';

/** Name for a studio or network key, from the companies list (falls back to the key). */
export function useCompanyNames() {
  const c = useCompanies();
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const x of [...(c.data?.studios ?? []), ...(c.data?.networks ?? [])]) m.set(x.key, x.name);
    return (key: string) => m.get(key) ?? key.replace(/-/g, ' ');
  }, [c.data]);
}

const toggle = (list: string[] | undefined, k: string) => {
  const s = new Set(list ?? []);
  if (s.has(k)) s.delete(k); else s.add(k);
  return s.size ? [...s] : undefined;
};

/**
 * Figma "Studio or network picker": Studios / Networks tabs, a search box and the
 * list, most titles first, with what you've picked pinned at the top. Studios
 * narrow movies; networks narrow series.
 */
export function CompanyList({ value, onChange, only }: { value: CompanyPick; onChange: (v: CompanyPick) => void; only?: 'studios' | 'networks' }) {
  const c = useCompanies();
  const [tab, setTab] = useState<'studios' | 'networks'>(only ?? (value.networks?.length && !value.studios?.length ? 'networks' : 'studios'));
  const [q, setQ] = useState('');
  const list: CompanyOption[] = c.data?.[tab] ?? [];
  const picked = new Set(value[tab] ?? []);
  const needle = q.trim().toLowerCase();
  const shown = (needle ? list.filter((x) => x.name.toLowerCase().includes(needle)) : [...list])
    .sort((a, b) => Number(picked.has(b.key)) - Number(picked.has(a.key)))
    .slice(0, needle ? 100 : 60);
  const tabCls = (on: boolean) => `flex-1 rounded-full py-1.5 type-label-default transition ${on ? 'bg-inverse text-ink-inverse' : 'text-ink-secondary hover:text-white'}`;
  return (
    <div>
      {!only && (
        <div className="mb-3 flex rounded-full bg-surface p-1 ring-1 ring-line-strong" role="tablist">
          {(['studios', 'networks'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tabCls(tab === t)} onClick={() => { setTab(t); setQ(''); }}>
              {t === 'studios' ? 'Movie studios' : 'TV networks'}{value[t]?.length ? ` · ${value[t]!.length}` : ''}
            </button>
          ))}
        </div>
      )}
      <label className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 ring-1 ring-line-strong focus-within:ring-indigo-400">
        <Icons.search className="h-4 w-4 text-ink-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'studios' ? 'A24, 20th Century, Neon…' : 'NBC, FX, HBO…'}
          className="min-w-0 flex-1 bg-transparent type-body-default text-white placeholder:text-ink-muted focus:outline-none" aria-label={`Search ${tab}`} />
      </label>
      {c.isPending ? <div className="flex justify-center py-8"><Spinner className="h-6 w-6" /></div> : (
        <ul className="mt-2 divide-y divide-line">
          {shown.map((x) => {
            const on = picked.has(x.key);
            return (
              <li key={x.key}>
                <button type="button" aria-pressed={on} onClick={() => onChange({ ...value, [tab]: toggle(value[tab], x.key) })}
                  className="flex w-full items-center gap-3 py-2.5 text-left transition hover:bg-raised/50">
                  <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ring-1 ${on ? 'bg-indigo-500 ring-indigo-400' : 'ring-line-strong'}`}>
                    {on && <Icons.check className="h-3.5 w-3.5 text-white" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate type-body-default text-white">{x.name}</span>
                  <span className="type-body-small text-ink-muted">{x.count.toLocaleString()}</span>
                </button>
              </li>
            );
          })}
          {!shown.length && <li className="py-6 text-center type-body-default text-ink-tertiary">{list.length ? 'No match.' : 'Studios and networks fill in as titles are refreshed from TMDB.'}</li>}
        </ul>
      )}
    </div>
  );
}

/** The picker in its own panel (Discover). */
export function CompanyPickerSheet({ open, onClose, value, onApply }: { open: boolean; onClose: () => void; value: CompanyPick; onApply: (v: CompanyPick) => void }) {
  const [draft, setDraft] = useState<CompanyPick>(value);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) { setWasOpen(open); if (open) setDraft(value); }
  const n = (draft.studios?.length ?? 0) + (draft.networks?.length ?? 0);
  return (
    <SlideOver open={open} onClose={onClose} accentTitle title="Studios and networks" subText="Studios narrow movies; networks narrow series."
      footer={
        <div className="flex gap-3">
          <Button onClick={() => setDraft({})}>Clear</Button>
          <Button buttonType="primary" className="flex-1" onClick={() => { onApply(draft); onClose(); }}>{n ? `Show ${n} selected` : 'Show everything'}</Button>
        </div>
      }>
      <CompanyList value={draft} onChange={setDraft} />
    </SlideOver>
  );
}
