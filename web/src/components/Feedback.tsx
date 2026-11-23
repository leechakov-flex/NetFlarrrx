import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from './icons';
const CheckCircleIcon = Icons.checkCircle, ExclamationTriangleIcon = Icons.warning, LockClosedIcon = Icons.lock, XCircleIcon = Icons.xmarkCircle, XMarkIcon = Icons.xmark;
import { Button } from './ui';
import { useModal } from '../lib/useModal';

// ---------- Toasts (Seerr's top-right toasts) ----------

type ToastKind = 'success' | 'error' | 'warning';
interface Toast { id: number; kind: ToastKind; text: string }

const ToastCtx = createContext<(kind: ToastKind, text: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

const toastIcon = {
  success: <CheckCircleIcon className="h-6 w-6 text-green-400" />,
  error: <XCircleIcon className="h-6 w-6 text-red-400" />,
  warning: <ExclamationTriangleIcon className="h-6 w-6 text-yellow-400" />,
};

// ---------- Passcode prompt ----------

type Ask = (opts?: { wrong?: boolean }) => Promise<string | null>;
const PasscodeCtx = createContext<Ask>(async () => null);
export const useAskPasscode = () => useContext(PasscodeCtx);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    // Errors stay until dismissed (WCAG 2.2.1); the rest fade after 5 seconds.
    if (kind !== 'error') setTimeout(() => dismiss(id), 5000);
  }, [dismiss]);

  const [prompt, setPrompt] = useState<{ wrong: boolean; resolve: (v: string | null) => void } | null>(null);
  const ask: Ask = useCallback((opts) => new Promise((resolve) => setPrompt({ wrong: !!opts?.wrong, resolve })), []);

  return (
    <ToastCtx.Provider value={push}>
      <PasscodeCtx.Provider value={ask}>
        {children}
        {prompt && (
          <PasscodeModal
            wrong={prompt.wrong}
            onDone={(v) => { prompt.resolve(v); setPrompt(null); }}
          />
        )}
        {createPortal(
          // Toasts sit at the bottom, above the phone tab bar, so they never cover the back
          // button or the search bar. Newest nearest the edge.
          <div data-toasts className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+92px)] z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:px-8" aria-live="polite">
            {toasts.map((t) => (
              <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'}
                className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg bg-gray-800 px-4 py-3 shadow-lg ring-1 ring-gray-700">
                <span className="mt-0.5 flex-shrink-0">{toastIcon[t.kind]}</span>
                <p className="flex-1 text-sm font-medium leading-6 text-white">{t.text}</p>
                <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="mt-0.5 text-gray-400 hover:text-white">
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
      </PasscodeCtx.Provider>
    </ToastCtx.Provider>
  );
}

/** Seerr Common/Modal look: centred panel, gradient title, right-aligned actions. */
function PasscodeModal({ wrong, onDone }: { wrong: boolean; onDone: (v: string | null) => void }) {
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, true, () => onDone(null), input);

  return createPortal(
    <div ref={ref} className="fixed inset-0 z-50 flex items-center justify-center bg-gray-800/70 p-4" onClick={() => onDone(null)}>
      <form
        role="dialog" aria-modal="true" aria-labelledby="passcode-title"
        className="w-full max-w-md rounded-xl bg-gray-800 p-6 shadow-xl ring-1 ring-gray-700"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (value.trim()) onDone(value.trim()); }}
      >
        <div className="flex items-start gap-4">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-indigo-500/20">
            <LockClosedIcon className="h-6 w-6 text-indigo-300" />
          </span>
          <div className="flex-1">
            <h2 id="passcode-title" className="text-overseerr text-2xl font-bold leading-7">Enter passcode</h2>
            <p className="mt-1 text-sm text-gray-300">
              {wrong ? 'That passcode didn’t work. Try again.' : 'Requests go straight to MonkeyServer. Enter the passcode once and this device remembers it.'}
            </p>
          </div>
        </div>
        <input
          ref={input}
          type="password"
          autoComplete="current-password"
          aria-label="Passcode"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={`mt-5 block w-full rounded-md border bg-gray-700 px-3 py-2 text-white placeholder-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 ${wrong ? 'border-red-500' : 'border-gray-500'}`}
          placeholder="Passcode"
        />
        <div className="mt-6 flex flex-row-reverse gap-3">
          <Button buttonType="primary" type="submit" disabled={!value.trim()}>Continue</Button>
          <Button onClick={() => onDone(null)}>Cancel</Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
