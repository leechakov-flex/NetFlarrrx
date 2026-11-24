import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { Layout } from './components/Layout';
import { Discover } from './pages/Discover';
import { Browse } from './pages/Browse';
import { TopRated } from './pages/TopRated';
import { TitleDetail } from './pages/TitleDetail';
import { More } from './pages/More';
import { Downloads } from './pages/Downloads';
import { Library } from './pages/Library';
import { Person } from './pages/Person';
import { Lists } from './pages/Lists';
import { Collections } from './pages/Collections';
import { Catalog } from './pages/Catalog';
import { Empty } from './components/ui';
import { FeedbackProvider } from './components/Feedback';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5 * 60_000, retry: 1, refetchOnWindowFocus: false } },
});

// Service workers only run on HTTPS (or localhost). On plain http://monkeyserver.local
// the app still installs to the home screen; offline support arrives with HTTPS.
if ('serviceWorker' in navigator && window.isSecureContext && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => undefined); });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <FeedbackProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Discover />} />
            <Route path="/movies" element={<Browse key="movie" kind="movie" title="Movies" />} />
            <Route path="/series" element={<Browse key="series" kind="series" title="Series" />} />
            <Route path="/browse" element={<Browse key="all" title="All titles" />} />
            <Route path="/search" element={<Browse key="search" title="Search" search />} />
            <Route path="/top" element={<TopRated />} />
            <Route path="/title/:id" element={<TitleDetail />} />
            <Route path="/more" element={<More />} />
            <Route path="/downloads" element={<Downloads />} />
            <Route path="/library" element={<Library />} />
            <Route path="/person" element={<Person />} />
            <Route path="/lists" element={<Lists />} />
            <Route path="/collections" element={<Collections />} />
            <Route path="/catalog" element={<Catalog />} />
            <Route path="*" element={<Empty>Page not found.</Empty>} />
          </Routes>
        </Layout>
      </BrowserRouter>
      </FeedbackProvider>
    </QueryClientProvider>
  </StrictMode>,
);
