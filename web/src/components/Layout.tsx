import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom';
import { recallScroll, rememberScroll } from '../lib/scrollMemory';
import { useMeta } from '../lib/api';
import { relativeTime } from '../lib/format';
import { Icons } from './icons';

const nav = [
  { to: '/', label: 'Discover', icon: Icons.sparkles, match: (p: string) => p === '/' },
  { to: '/movies', label: 'Movies', icon: Icons.film, match: (p: string) => p.startsWith('/movies') },
  { to: '/series', label: 'Series', icon: Icons.tv, match: (p: string) => p.startsWith('/series') },
  { to: '/top', label: 'Top rated', icon: Icons.rosette, match: (p: string) => p.startsWith('/top') },
];

export function useMediaQuery(query: string) {
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

function SearchInput({ placeholder = 'Search all services', autoFocus = false }: { placeholder?: string; autoFocus?: boolean }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const onSearch = location.pathname === '/search';
  const [value, setValue] = useState(onSearch ? params.get('q') ?? '' : '');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => { if (!onSearch) setValue(''); }, [onSearch]);

  const go = (q: string, replace: boolean) => {
    if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`, { replace });
    else if (onSearch) navigate('/search', { replace: true });
  };

  return (
    <form
      role="search"
      className="relative flex w-full items-center text-white focus-within:text-gray-200"
      onSubmit={(e) => { e.preventDefault(); window.clearTimeout(timer.current); go(value, onSearch); }}
    >
      <label htmlFor="search_field" className="sr-only">Search</label>
      <Icons.search className="pointer-events-none absolute left-4 h-4 w-4" />
      <input
        id="search_field"
        type="search"
        autoComplete="off"
        placeholder={placeholder}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => {
          const q = e.target.value;
          setValue(q);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => go(q, onSearch), 350);
        }}
        className="block w-full rounded-full border border-line-strong bg-gray-900/80 py-2 pl-10 pr-10 type-body-default text-white placeholder-gray-300 hover:border-line-muted focus:border-line-muted focus:bg-gray-900 focus:placeholder-gray-400 focus:outline-none focus:ring-0 sm:text-base [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => { setValue(''); go('', true); }}
          className="absolute right-2 m-auto h-7 w-7 p-1 text-gray-400 transition hover:text-white">
          <Icons.xmarkCircle className="h-5 w-5" />
        </button>
      )}
    </form>
  );
}

function Sidebar() {
  const { pathname } = useLocation();
  const meta = useMeta();
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-line bg-surface lg:flex">
      <div className="px-4 pt-5">
        <Link to="/" className="block text-3xl font-bold"><span className="text-overseerr">MonkeySee</span></Link>
        <p className="mt-1 type-caption-default text-ink-muted">What’s new on your services</p>
      </div>
      <nav className="mt-8 flex-1 space-y-1 px-4">
        {[...nav, { to: '/library', label: 'Library', icon: Icons.library, match: (p: string) => p.startsWith('/library') }, { to: '/downloads', label: 'Downloads', icon: Icons.download, match: (p: string) => p.startsWith('/downloads') }].map((item) => {
          const on = item.match(pathname);
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={`flex items-center rounded-md px-2 py-2 text-lg font-medium leading-6 text-white transition duration-150 ease-in-out ${
                on ? 'bg-gradient-to-br from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500' : 'hover:bg-gray-700'
              }`}
            >
              <Icon className="mr-3 h-5 w-5" />
              <span className="flex-1">{item.label}</span>
              {item.to === '/downloads' && (meta.data?.downloads?.attention ?? 0) > 0 && (
                <span className="rounded-full bg-red-500 px-2 text-xs font-bold leading-5 text-white">{meta.data!.downloads!.attention}</span>
              )}
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

/**
 * iOS 26 style tab bar (Figma "MobileMenu"): a floating Liquid Glass pill with the
 * five tabs, the current one in a lighter pill, and Search as its own round glass
 * button beside it, as on Apple TV.
 */
function MobileMenu() {
  const { pathname } = useLocation();
  const items = [...nav, { to: '/more', label: 'More', icon: Icons.ellipsis, match: (p: string) => p.startsWith('/more') || p.startsWith('/downloads') || p.startsWith('/library') }];
  const attention = useMeta().data?.downloads?.attention ?? 0;
  const onSearch = pathname.startsWith('/search');
  return (
    <nav className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-3 lg:hidden" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}>
      <div className="pointer-events-auto flex items-center gap-2.5">
        <div className="glass flex min-w-0 flex-1 items-center rounded-full p-[3px]">
          {items.map((item) => {
            const on = item.match(pathname);
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} aria-current={on ? 'page' : undefined}
                className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-full pb-1.5 pt-2 transition ${on ? 'bg-glass-active text-glass-tint' : 'text-ink-secondary'}`}>
                <span className="relative">
                  <Icon className="h-[22px] w-[22px]" />
                  {item.to === '/more' && attention > 0 && (
                    <span aria-label={`${attention} downloads need attention`} className="absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white">{attention}</span>
                  )}
                </span>
                <span className={`max-w-full truncate px-1 ${on ? 'type-nav-tab-active' : 'type-nav-tab'}`}>{item.label}</span>
              </NavLink>
            );
          })}
        </div>
        <NavLink to="/search" aria-label="Search" aria-current={onSearch ? 'page' : undefined}
          className="glass flex h-[60px] w-[60px] flex-shrink-0 items-center justify-center rounded-full">
          <span className={`flex h-[52px] w-[52px] items-center justify-center rounded-full ${onSearch ? 'bg-glass-active text-glass-tint' : 'text-ink-secondary'}`}>
            <Icons.search className="h-6 w-6" />
          </span>
        </NavLink>
      </div>
    </nav>
  );
}

export { SearchInput };

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
  // Back/forward returns to where you were on that page; anything else starts at the top
  // (but filter and sort changes on the same page keep your place).
  const location = useLocation();
  const navType = useNavigationType();
  const lastPath = useRef(pathname);
  useEffect(() => {
    try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch { /* ignore */ }
  }, []);
  // A layout effect, so the old page's listener is gone before the browser clamps
  // the scroll position for the new, shorter page (that would overwrite the saved spot).
  useLayoutEffect(() => {
    const key = `${location.key}:page`;
    const target = navType === 'POP' ? recallScroll(key) : undefined;
    let raf = 0;
    let stopRestore = () => {};
    if (target) {
      // The page may still be rendering or, after a reload, loading more titles as it
      // nears the bottom: keep scrolling towards the old spot for up to 6 seconds, and
      // stop as soon as you scroll yourself.
      const until = performance.now() + 6000;
      let cancelled = false;
      const userScroll = () => { cancelled = true; };
      const events = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
      for (const e of events) window.addEventListener(e, userScroll, { passive: true, once: true });
      stopRestore = () => { cancelled = true; for (const e of events) window.removeEventListener(e, userScroll); };
      const attempt = () => {
        if (cancelled) return;
        const max = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo(0, Math.min(target, max));
        if (max < target && performance.now() < until) raf = requestAnimationFrame(attempt);
        else stopRestore();
      };
      attempt();
    } else if (lastPath.current !== pathname) {
      window.scrollTo(0, 0);
    }
    lastPath.current = pathname;
    let pending = 0;
    const save = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(() => rememberScroll(key, window.scrollY)); };
    window.addEventListener('scroll', save, { passive: true });
    return () => { stopRestore(); cancelAnimationFrame(raf); cancelAnimationFrame(pending); window.removeEventListener('scroll', save); };
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  return (
    <div className="flex min-h-screen min-w-0 bg-app">
      <Sidebar />
      <div className="relative mb-28 flex w-0 min-w-0 flex-1 flex-col lg:mb-0 lg:ml-64">
        {/* Desktop: search across the top. Phones search from the tab bar's round button. */}
        <div className={`fixed left-64 right-0 top-0 z-20 hidden h-16 items-center px-4 transition duration-300 lg:flex ${scrolled ? 'bg-app/80 backdrop-blur' : ''}`}>
          {isDetail && (
            <button type="button" aria-label="Back" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))} className="mr-3 text-white">
              <Icons.chevronLeft className="h-6 w-6" />
            </button>
          )}
          <SearchInput />
        </div>
        {isDetail && (
          <button type="button" aria-label="Back" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
            className="glass fixed left-4 z-30 flex h-11 w-11 items-center justify-center rounded-full text-white lg:hidden"
            style={{ top: 'calc(env(safe-area-inset-top) + 12px)' }}>
            <Icons.chevronLeft className="h-5 w-5" />
          </button>
        )}
        <main className={`relative z-0 focus:outline-none lg:top-16 ${isDetail ? '' : 'pt-[env(safe-area-inset-top)]'}`}>
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
