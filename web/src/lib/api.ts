import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  BrowseQuery, BrowseResponse, Genre, HomeResponse, Kind, MetaResponse, TitleDetail, TopResponse,
} from '../../../src/api/types';

export type { BrowseQuery, BrowseResponse, Genre, HomeResponse, Kind, MetaResponse, TitleDetail, TopResponse };
export type { TitleCard, HomeRow, SeerrState, SortKey } from '../../../src/api/types';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export function browseParams(q: BrowseQuery, page?: number): string {
  const p = new URLSearchParams();
  if (q.kind) p.set('kind', q.kind);
  if (q.genres?.length) p.set('genres', q.genres.join(','));
  if (q.added) p.set('added', String(q.added));
  if (q.minRating) p.set('minRating', String(q.minRating));
  if (q.minVotes) p.set('minVotes', String(q.minVotes));
  if (q.sort) p.set('sort', q.sort);
  if (q.q) p.set('q', q.q);
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
