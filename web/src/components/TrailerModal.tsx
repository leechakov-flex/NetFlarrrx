import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from './icons';
const XMarkIcon = Icons.xmark;

/** Full-screen trailer overlay. The YouTube embed only loads once the person taps Play. */
export function TrailerModal({ videoKey, title, onClose }: { videoKey: string; title: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; };
  }, [onClose]);
  const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoKey)}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/90 p-4 backdrop-blur-sm" onClick={onClose}
      role="dialog" aria-modal="true" aria-label={`${title} trailer`}>
      <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="truncate pr-4 text-lg font-semibold text-gray-100">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close trailer" className="rounded-md p-1 text-gray-300 transition hover:bg-gray-800 hover:text-white">
            <XMarkIcon className="h-7 w-7" />
          </button>
        </div>
        <div className="relative w-full overflow-hidden rounded-lg bg-black shadow-2xl ring-1 ring-gray-700" style={{ paddingBottom: '56.25%' }}>
          <iframe
            className="absolute inset-0 h-full w-full"
            src={src}
            title={`${title} trailer`}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
