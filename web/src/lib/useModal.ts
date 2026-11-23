import { useEffect, useRef, type RefObject } from 'react';

/**
 * What every overlay (slide-over, trailer, passcode prompt) needs to behave as a real modal:
 * - focus moves inside when it opens and back to whatever opened it when it closes;
 * - everything else on the page goes `inert`, so Tab can't wander behind it (toasts stay live);
 * - Escape closes only the topmost overlay, so the passcode prompt over a panel closes alone.
 * `node` is the overlay's outermost element, the one portaled straight into <body>.
 */
const stack: { close: () => void }[] = [];

export function useModal(node: RefObject<HTMLElement | null>, open: boolean, onClose: () => void, focusFirst?: RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const root = node.current;
    if (!open || !root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry = { close: () => close.current() };
    stack.push(entry);
    // Inert everything beside this overlay that isn't already; remember what we changed.
    const changed = [...document.body.children].filter((el): el is HTMLElement =>
      el instanceof HTMLElement && el !== root && !el.inert && !el.hasAttribute('data-toasts'));
    changed.forEach((el) => { el.inert = true; });
    (focusFirst?.current ?? root.querySelector<HTMLElement>('[data-autofocus]') ?? root.querySelector<HTMLElement>('[role="dialog"]') ?? root).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && stack[stack.length - 1] === entry) { e.stopPropagation(); entry.close(); } };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      changed.forEach((el) => { el.inert = false; });
      stack.splice(stack.indexOf(entry), 1);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, node, focusFirst]);
}
