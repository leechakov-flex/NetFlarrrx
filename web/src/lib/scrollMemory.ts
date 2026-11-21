/**
 * Remembers scroll positions per history entry, so Back returns you to where
 * you were: the page's vertical position and each Discover row's horizontal one.
 * Keyed by React Router's location.key, which stays the same for an entry when
 * you come back to it and is new when you navigate fresh (a new visit starts at
 * the top, like a browser). Kept in memory, mirrored to sessionStorage so it
 * also survives a reload of the tab. Storage can be unavailable (private mode),
 * so every access is guarded.
 */
const STORAGE_KEY = 'monkeysee.scroll';
const MAX_ENTRIES = 300;

let memory: Map<string, number> | null = null;
function load(): Map<string, number> {
  if (memory) return memory;
  memory = new Map();
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) for (const [k, v] of JSON.parse(raw) as [string, number][]) memory.set(k, v);
  } catch { /* no storage: memory only */ }
  return memory;
}

let saveTimer: number | undefined;
function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...load()].slice(-MAX_ENTRIES))); } catch { /* ignore */ }
  }, 250);
}

export function rememberScroll(key: string, value: number) {
  const m = load();
  m.delete(key);              // keep newest last, so trimming drops the oldest
  m.set(key, Math.round(value));
  persist();
}

export function recallScroll(key: string): number | undefined {
  return load().get(key);
}
