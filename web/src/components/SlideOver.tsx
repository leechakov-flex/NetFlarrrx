import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { XMarkIcon } from '@heroicons/react/24/outline';

/** Seerr Common/SlideOver: dimmed backdrop and a right-hand panel with a gradient title. */
export function SlideOver({ open, onClose, title, subText, children, footer }:
  { open: boolean; onClose: () => void; title: string; subText?: string; children: ReactNode; footer?: ReactNode }) {
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
    <div className="fixed inset-0 z-50 overflow-hidden bg-gray-800/70" onClick={onClose}>
      <section className="absolute inset-y-0 right-0 flex max-w-full" role="dialog" aria-modal="true" aria-label={title}>
        <div className="relative h-full w-screen max-w-md p-2 sm:p-3" onClick={(e) => e.stopPropagation()}>
          <div className="flex h-full flex-col rounded-lg bg-gray-800/80 shadow-xl ring-1 ring-gray-700 backdrop-blur">
            <header className="space-y-1 border-b border-gray-700 px-4 py-4">
              <div className="flex items-center justify-between space-x-3">
                <h2 className="text-overseerr text-2xl font-bold leading-7">{title}</h2>
                <button type="button" aria-label="Close" onClick={onClose} className="h-7 text-gray-200 transition hover:text-white">
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              {subText && <p className="text-sm text-gray-400">{subText}</p>}
            </header>
            <div className="flex-1 overflow-y-auto px-4 py-5">{children}</div>
            {footer && <footer className="border-t border-gray-700 px-4 py-4">{footer}</footer>}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
