import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeftIcon, EllipsisHorizontalIcon, FilmIcon, MagnifyingGlassIcon, SparklesIcon, TrophyIcon, TvIcon, XCircleIcon,
} from '@heroicons/react/24/outline';
import {
  EllipsisHorizontalIcon as EllipsisSolid, FilmIcon as FilmSolid, SparklesIcon as SparklesSolid, TrophyIcon as TrophySolid, TvIcon as TvSolid,
} from '@heroicons/react/24/solid';
import { useMeta } from '../lib/api';
import { relativeTime } from '../lib/format';

const nav = [
  { to: '/', label: 'Discover', icon: SparklesIcon, active: SparklesSolid, match: (p: string) => p === '/' },
  { to: '/movies', label: 'Movies', icon: FilmIcon, active: FilmSolid, match: (p: string) => p.startsWith('/movies') },
  { to: '/series', label: 'Series', icon: TvIcon, active: TvSolid, match: (p: string) => p.startsWith('/series') },
  { to: '/top', label: 'Top rated', icon: TrophyIcon, active: TrophySolid, match: (p: string) => p.startsWith('/top') },
];

function useMediaQuery(query: string) {
  const get = () => typeof window !== 'undefined' && window.matchMedia(query).matches;
  const [match, setMatch] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

function SearchInput() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const onSearch = location.pathname === '/search';
  const [value, setValue] = useState(onSearch ? params.get('q') ?? '' : '');
  const timer = useRef<number | undefined>(undefined);
  const wide = useMediaQuery('(min-width: 1024px)');

  useEffect(() => { if (!onSearch) setValue(''); }, [onSearch]);

  const go = (q: string, replace: boolean) => {
    if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`, { replace });
    else if (onSearch) navigate('/', { replace: true });
  };

  return (
    // Figma: the wider desktop field says "Search Netflix titles".
    <form
      role="search"
      className="relative flex w-full items-center text-white focus-within:text-gray-200"
      onSubmit={(e) => { e.preventDefault(); window.clearTimeout(timer.current); go(value, onSearch); }}
    >
      <label htmlFor="search_field" className="sr-only">Search</label>
      <MagnifyingGlassIcon className="pointer-events-none absolute left-4 h-5 w-5" />
      <input
        id="search_field"
        type="search"
        autoComplete="off"
        placeholder={wide ? 'Search Netflix titles' : 'Search Netflix'}
        value={value}
        onChange={(e) => {
          const q = e.target.value;
          setValue(q);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => go(q, onSearch), 350);
        }}
        className="block w-full rounded-full border border-gray-600 bg-gray-900/80 py-2 pl-10 pr-10 text-white placeholder-gray-300 hover:border-gray-500 focus:border-gray-500 focus:bg-gray-900 focus:placeholder-gray-400 focus:outline-none focus:ring-0 sm:text-base [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => { setValue(''); go('', true); }}
          className="absolute right-2 m-auto h-7 w-7 p-1 text-gray-400 transition hover:text-white">
          <XCircleIcon className="h-5 w-5" />
        </button>
      )}
    </form>
  );
}

function Sidebar() {
  const { pathname } = useLocation();
  const meta = useMeta();
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-gray-700 bg-gray-800 lg:flex">
      <div className="px-4 pt-5">
        <Link to="/" className="block text-3xl font-bold"><span className="text-overseerr">NetFlarrrx</span></Link>
        <p className="mt-1 text-sm font-medium text-gray-400">What’s new on Netflix</p>
      </div>
      <nav className="mt-8 flex-1 space-y-1 px-4">
        {nav.map((item) => {
          const on = item.match(pathname);
          const Icon = on ? item.active : item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={`flex items-center rounded-md px-2 py-2 text-lg font-medium leading-6 text-white transition duration-150 ease-in-out ${
                on ? 'bg-gradient-to-br from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500' : 'hover:bg-gray-700'
              }`}
            >
              <Icon className="mr-3 h-6 w-6" />
              {item.label}
            </NavLink>
          );
        })}
      </nav>
      {meta.data && (
        <Link to="/more" className="m-4 rounded-md border border-gray-700 px-3 py-2.5 transition hover:border-gray-500">
          <div className="text-sm font-semibold text-gray-200">Last sync: {relativeTime(meta.data.lastSyncAt) ?? 'not yet'}</div>
          <div className="text-xs text-gray-400">
            {meta.data.eligible.toLocaleString()} titles · {meta.data.newThisWeek.toLocaleString()} new this week
          </div>
        </Link>
      )}
    </aside>
  );
}

function MobileMenu() {
  const { pathname } = useLocation();
  const items = [...nav, { to: '/more', label: 'More', icon: EllipsisHorizontalIcon, active: EllipsisSolid, match: (p: string) => p.startsWith('/more') }];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 lg:hidden">
      <div className="pb-safe border-t border-gray-600 bg-gray-800/90 backdrop-blur">
        <div className="flex items-center justify-between px-6 pt-3 text-gray-100">
          {items.map((item) => {
            const on = item.match(pathname);
            const Icon = on ? item.active : item.icon;
            return (
              <NavLink key={item.to} to={item.to} className={`flex flex-col items-center space-y-1 ${on ? 'text-indigo-500' : ''}`}>
                <Icon className="h-6 w-6" />
                <span className="text-xs font-medium">{item.label}</span>
              </NavLink>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isDetail = pathname.startsWith('/title/');
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  return (
    <div className="flex min-h-screen min-w-0 bg-gray-900">
      {/* Seerr's header glow */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-bl from-gray-800 to-gray-900">
        <div className="relative inset-0 h-full w-full bg-gradient-to-t from-gray-900 to-transparent" />
      </div>
      <Sidebar />
      <div className="relative mb-24 flex w-0 min-w-0 flex-1 flex-col lg:mb-0 lg:ml-64">
        <div className={`fixed left-0 right-0 top-0 z-20 flex h-16 items-center px-4 transition duration-300 lg:left-64 ${scrolled ? 'bg-gray-900/80 backdrop-blur' : ''}`}
          style={{ paddingTop: 'env(safe-area-inset-top)' }}>
          {isDetail && (
            <button type="button" aria-label="Back" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))} className="mr-3 text-white">
              <ArrowLeftIcon className="w-7" />
            </button>
          )}
          <SearchInput />
        </div>
        <main className="relative top-16 z-0 focus:outline-none">
          <div className="mx-auto max-w-[96rem] px-4 pb-10">
            {!online && (
              <div role="status" className="mt-2 rounded-md border border-yellow-500/60 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-100">
                <span className="font-semibold">Can’t reach MonkeyServer.</span> You’re offline; titles load again once you’re back on your home network.
              </div>
            )}
            {children}
          </div>
        </main>
      </div>
      <MobileMenu />
    </div>
  );
}
