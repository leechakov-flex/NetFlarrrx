import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from './icons';
const XMarkIcon = Icons.xmark;

/** Seerr Common/SlideOver: dimmed backdrop and a right-hand panel with a gradient title. */
export function SlideOver({ open, onClose, title, subText, children, footer, accentTitle = false }:
  { open: boolean; onClose: () => void; title: string; subText?: string; children: ReactNode; footer?: ReactNode; accentTitle?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 overflow-hidden bg-app/70" onClick={onClose}>
      <section className="absolute inset-y-0 right-0 flex max-w-full" role="dialog" aria-modal="true" aria-label={title}>
        <div className="relative h-full w-screen max-w-md p-2 sm:p-3" onClick={(e) => e.stopPropagation()}>
          <div className="flex h-full flex-col rounded-lg bg-app shadow-xl ring-1 ring-line">
            <header className="space-y-0.5 border-b border-line p-4">
              <div className="flex items-center justify-between space-x-3">
                <h2 className={`type-heading-page ${accentTitle ? 'text-ink-accent' : 'text-ink-primary'}`}>{title}</h2>
                <button type="button" aria-label="Close" onClick={onClose} className="h-7 text-ink-secondary transition hover:text-ink-primary">
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              {subText && <p className="type-body-default text-ink-muted">{subText}</p>}
            </header>
            <div className="flex-1 overflow-y-auto px-4 py-5">{children}</div>
            {footer && <footer className="border-t border-line p-4">{footer}</footer>}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
