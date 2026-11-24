import { Link } from 'react-router-dom';
import { useThemes } from '../lib/api';
import { BackButton } from '../components/Layout';
import { Icons } from '../components/icons';
import { LoadError, Spinner } from '../components/ui';

/** Collections (Figma Build screen 19): every ready-made row, with how many titles it has now. */
export function Collections() {
  const themes = useThemes();
  if (themes.isError) return <LoadError what="collections" onRetry={() => void themes.refetch()} />;
  return (
    <div className="flex max-w-2xl flex-col gap-3 pt-4">
      <BackButton className="lg:hidden" />
      <h1 className="type-heading-page text-ink-primary">Collections</h1>
      <p className="type-body-default text-ink-secondary">Ready-made rows of what’s on your services. The newest titles are first.</p>
      {themes.isPending ? <div className="flex justify-center py-16"><Spinner /></div> : (
        <ul className="divide-y divide-line">
          {/* Empty ones would be dead ends; they come back when titles arrive. */}
          {themes.data.filter((t) => t.count > 0).map((t) => (
            <li key={t.slug}>
              <Link to={`/browse?theme=${t.slug}`} className="flex items-center gap-3 py-3.5 transition hover:text-white">
                <span className="min-w-0 flex-1 truncate type-label-strong text-ink-primary">{t.title}</span>
                <span className="flex-shrink-0 type-body-small text-ink-tertiary">{t.count.toLocaleString()} {t.count === 1 ? 'title' : 'titles'}</span>
                <Icons.chevronRight className="h-5 w-5 flex-shrink-0 text-ink-muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
