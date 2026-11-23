import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, useListSearch, useLists, type ListOption, type PickedListInfo } from '../lib/api';
import { useGuardedPost } from '../lib/guardedPost';
import { relativeTime } from '../lib/format';
import { useToast } from '../components/Feedback';
import { BackButton } from '../components/Layout';
import { Button, LoadError, Spinner } from '../components/ui';
import { Icons } from '../components/icons';

/**
 * Recommendation lists (Figma Build screen 18): lists from MDBList that become Discover
 * rows. Your lists on top; search MDBList (its most-liked lists when the box is empty).
 */
export function Lists() {
  const lists = useLists();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const configured = lists.data?.configured ?? false;
  const search = useListSearch(query, configured);
  const post = useGuardedPost();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['lists'] });
    void qc.invalidateQueries({ queryKey: ['list-search'] });
    void qc.invalidateQueries({ queryKey: ['home'] });
  };
  const act = async (id: number, run: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try {
      if ((await run()) === null) return;     // passcode cancelled
      toast('success', done);
      await refresh();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Couldn’t reach MonkeySee. Try again in a moment.');
    } finally {
      setBusy(null);
    }
  };
  const add = (l: ListOption) => act(l.id, () => post(`/api/lists`, { id: l.id, name: l.name, userName: l.userName, items: l.items, likes: l.likes }), `Added ${l.name}. Its row is on Discover.`);
  const remove = (l: PickedListInfo) => act(l.id, () => post(`/api/lists/${l.id}/remove`), `Removed ${l.name} from Discover.`);

  if (lists.isPending) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (lists.isError) return <LoadError what="your lists" onRetry={() => void lists.refetch()} />;
  return (
    <div className="flex max-w-2xl flex-col gap-3 pt-4">
      <BackButton className="lg:hidden" />
      <h1 className="type-heading-page text-ink-primary">Recommendation lists</h1>
      <p className="type-body-default text-ink-secondary">
        Lists from MDBList become rows on Discover, showing the titles on your services you don’t have yet.
      </p>
      {!configured ? (
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 type-body-default text-ink-tertiary">
          <li>Make a free account at mdblist.com.</li>
          <li>In Preferences, copy your API key.</li>
          <li>Put it in <code className="text-white">monkeysee.env</code> as <code className="text-white">MDBLIST_API_KEY</code>, then restart MonkeySee.</li>
        </ol>
      ) : (
        <>
          <h2 className="mt-4 type-heading-section text-ink-primary">Your lists</h2>
          {lists.data.picked.length === 0
            ? <p className="type-body-default text-ink-tertiary">None yet. Add one below and it appears on Discover.</p>
            : (
              <ul className="divide-y divide-line">
                {lists.data.picked.map((l) => (
                  <li key={l.id} className="flex items-center gap-3 py-3">
                    <Link to={`/browse?list=${l.id}&hide=have`} className="min-w-0 flex-1">
                      <span className="block truncate type-label-strong text-ink-primary">{l.name}</span>
                      <span className="block type-body-small text-ink-tertiary">
                        {[l.userName && `by ${l.userName}`, `${l.inCatalog.toLocaleString()}${l.items ? ` of ${l.items.toLocaleString()}` : ''} on your services`, l.syncedAt && `updated ${relativeTime(l.syncedAt)}`].filter(Boolean).join(' · ')}
                      </span>
                      {l.error && <span className="block type-body-small text-ink-on-warning">Last update failed. MonkeySee tries again tomorrow.</span>}
                    </Link>
                    <button type="button" aria-label={`Remove ${l.name}`} disabled={busy === l.id} onClick={() => void remove(l)}
                      className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-ink-secondary transition hover:bg-raised hover:text-ink-primary disabled:opacity-50">
                      {busy === l.id ? <Spinner className="h-5 w-5" /> : <Icons.xmark className="h-5 w-5" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}

          <h2 className="mt-6 type-heading-section text-ink-primary">Find lists</h2>
          <label className="flex items-center gap-2 rounded-full bg-surface px-4 py-2.5 ring-1 ring-line-strong focus-within:ring-indigo-400">
            <Icons.search className="h-[18px] w-[18px] text-ink-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="A24, Oscar winners, cozy mysteries…" aria-label="Search MDBList"
              className="min-w-0 flex-1 bg-transparent type-body-default text-ink-primary placeholder:text-ink-muted focus:outline-none" />
            {q && <button type="button" aria-label="Clear search" onClick={() => setQ('')}><Icons.xmarkCircle className="h-5 w-5 text-ink-muted" /></button>}
          </label>
          <p className="type-caption-default text-ink-muted">{query ? `Lists matching “${query}”` : 'Most-liked lists on MDBList'}</p>
          {search.isError ? (
            <p className="type-body-default text-ink-on-warning">{search.error instanceof ApiError ? search.error.message : 'Couldn’t reach MDBList. Try again in a moment.'}</p>
          ) : search.isPending ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : search.data.results.length === 0 ? (
            <p className="type-body-default text-ink-tertiary">No lists match “{query}”. Try a shorter word.</p>
          ) : (
            <ul className={`divide-y divide-line ${search.isPlaceholderData ? 'opacity-50' : ''}`}>
              {search.data.results.map((l) => (
                <li key={l.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate type-label-strong text-ink-primary">{l.name}</span>
                    <span className="block type-body-small text-ink-tertiary">
                      {[l.userName && `by ${l.userName}`, l.items != null && `${l.items.toLocaleString()} titles`, l.likes ? `${l.likes.toLocaleString()} likes` : null].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  {l.picked
                    ? <span className="flex-shrink-0 type-label-default text-ink-tertiary">Added</span>
                    : <Button className="flex-shrink-0" disabled={busy === l.id} onClick={() => void add(l)}>{busy === l.id ? <Spinner className="h-4 w-4" /> : <Icons.plus className="h-4 w-4" />}Add</Button>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
