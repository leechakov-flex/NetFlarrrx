import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModal } from '../lib/useModal';
import { Button, Spinner } from './ui';

/**
 * Confirm before something that can't be undone. The title names the action and the
 * object, the body says what's lost, and the confirm button repeats the verb.
 * Cancel gets focus first, so Enter never deletes by accident.
 */
export function ConfirmDialog({ open, title, children, confirmLabel, busy = false, onConfirm, onClose }: {
  open: boolean; title: string; children: ReactNode; confirmLabel: string; busy?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useModal(ref, open, () => { if (!busy) onClose(); }, cancel);
  if (!open) return null;
  return createPortal(
    <div ref={ref} className="fixed inset-0 z-50 flex items-end justify-center bg-app/70 p-4 sm:items-center" onClick={() => { if (!busy) onClose(); }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body"
        className="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl ring-1 ring-line-strong" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title" className="type-heading-section text-ink-primary">{title}</h2>
        <div id="confirm-body" className="mt-2 space-y-2 type-body-default text-ink-secondary">{children}</div>
        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button ref={cancel} onClick={onClose} disabled={busy}>Cancel</Button>
          <Button buttonType="danger" onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {busy && <Spinner className="h-4 w-4 text-white" />}{confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
