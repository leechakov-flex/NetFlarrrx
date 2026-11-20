import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  BrowseQuery, BrowseResponse, Genre, HomeResponse, Kind, MetaResponse, RequestResult, SeasonInfo, SeasonsResponse, ThemeSummary, TitleDetail, TopResponse,
} from '../../../src/api/types';

export type { BrowseQuery, BrowseResponse, Genre, HomeResponse, Kind, MetaResponse, RequestResult, SeasonInfo, SeasonsResponse, ThemeSummary, TitleDetail, TopResponse };
export type { TitleCard, HomeRow, SeerrState, SortKey } from '../../../src/api/types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

async function toError(res: Response) {
  const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
  return new ApiError(res.status, body?.error ?? `${res.status} ${res.statusText}`, body?.code);
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw await toError(res);
  return res.json() as Promise<T>;
}

export async function postJson<T>(path: string, body: unknown, passcode?: string | null): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(passcode ? { 'x-passcode': passcode } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw await toError(res);
  return res.json() as Promise<T>;
}

// The passcode is kept on this device so it's asked for once.
const PASSCODE_KEY = 'netflarrrx.passcode';
export const savedPasscode = {
  get(): string | null { try { return localStorage.getItem(PASSCODE_KEY); } catch { return null; } },
  set(v: string) { try { localStorage.setItem(PASSCODE_KEY, v); } catch { /* private mode: ask each time */ } },
  clear() { try { localStorage.removeItem(PASSCODE_KEY); } catch { /* ignore */ } },
};

export function browseParams(q: BrowseQuery, page?: number): string {
  const p = new URLSearchParams();
  if (q.kind) p.set('kind', q.kind);
  if (q.genres?.length) p.set('genres', q.genres.join(','));
  if (q.added) p.set('added', String(q.added));
  if (q.minRating) p.set('minRating', String(q.minRating));
  if (q.maxRating !== undefined && q.maxRating < 10) p.set('maxRating', String(q.maxRating));
  if (q.minVotes) p.set('minVotes', String(q.minVotes));
  if (q.sort) p.set('sort', q.sort);
  if (q.q) p.set('q', q.q);
  if (q.hideHave) p.set('hide', 'have');
  if (q.theme) p.set('theme', q.theme);
  if (page && page > 1) p.set('page', String(page));
  return p.toString();
}

export const useMeta = () => useQuery({ queryKey: ['meta'], queryFn: () => getJson<MetaResponse>('/api/meta'), staleTime: 60_000 });
export const useHome = () => useQuery({ queryKey: ['home'], queryFn: () => getJson<HomeResponse>('/api/home') });
export const useGenres = (kind?: Kind) =>
  useQuery({ queryKey: ['genres', kind ?? 'all'], queryFn: () => getJson<Genre[]>(`/api/genres${kind ? `?kind=${kind}` : ''}`), staleTime: 10 * 60_000 });
export const useTop = (kind: Kind) => useQuery({ queryKey: ['top', kind], queryFn: () => getJson<TopResponse>(`/api/top?kind=${kind}`) });
export const useTitle = (id: number) =>
  useQuery({ queryKey: ['title', id], queryFn: () => getJson<TitleDetail>(`/api/titles/${id}`), enabled: Number.isInteger(id) && id > 0 });

export function useBrowse(q: BrowseQuery) {
  return useInfiniteQuery({
    queryKey: ['browse', browseParams(q)],
    queryFn: ({ pageParam }) => getJson<BrowseResponse>(`/api/titles?${browseParams(q, pageParam)}`),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  });
}

/** Just the count, for the filter panel's "Show N titles" button. */
export const useBrowseCount = (q: BrowseQuery, enabled: boolean) =>
  useQuery({
    queryKey: ['browse-count', browseParams(q)],
    queryFn: async () => (await getJson<BrowseResponse>(`/api/titles?${browseParams(q)}`)).total,
    enabled,
    placeholderData: (prev) => prev,
  });

/** Live from Seerr, so a short cache. */
export const useSeasons = (id: number, enabled: boolean) =>
  useQuery({ queryKey: ['seasons', id], queryFn: () => getJson<SeasonsResponse>(`/api/titles/${id}/seasons`), enabled, staleTime: 15_000, retry: 0 });
export const useThemes = () => useQuery({ queryKey: ['themes'], queryFn: () => getJson<ThemeSummary[]>('/api/themes'), staleTime: 10 * 60_000 });
