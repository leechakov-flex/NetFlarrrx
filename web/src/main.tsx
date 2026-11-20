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
import { Empty } from './components/ui';
import { FeedbackProvider } from './components/Feedback';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5 * 60_000, retry: 1, refetchOnWindowFocus: false } },
});

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
            <Route path="/browse" element={<Browse key="all" title="Netflix" />} />
            <Route path="/search" element={<Browse key="search" title="Search" search />} />
            <Route path="/top" element={<TopRated />} />
            <Route path="/title/:id" element={<TitleDetail />} />
            <Route path="/more" element={<More />} />
            <Route path="*" element={<Empty>Page not found.</Empty>} />
          </Routes>
        </Layout>
      </BrowserRouter>
      </FeedbackProvider>
    </QueryClientProvider>
  </StrictMode>,
);
