// Display helpers. Dates show in the viewer's own time zone.

const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const monthDayYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const languages = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'language' }) : null;

/** "Added Nov 22", or "Added Nov 22, 2025" when it's not this year. */
export function addedLabel(iso: string | null, now = new Date()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return `Added ${d.getFullYear() === now.getFullYear() ? monthDay.format(d) : monthDayYear.format(d)}`;
}

export function longDate(iso: string | null): string | null {
  if (!iso) return null;
  // Release dates are plain YYYY-MM-DD; read them as local dates so they don't shift a day.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : monthDayYear.format(d);
}

export function runtime(minutes: number | null): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function seasons(n: number | null): string | null {
  return n ? `${n} season${n === 1 ? '' : 's'}` : null;
}

export function languageName(code: string | null): string | null {
  if (!code) return null;
  try { return languages?.of(code) ?? code; } catch { return code; }
}

export function compact(n: number | null): string | null {
  if (n === null || n === undefined) return null;
  return n.toLocaleString('en-US');
}

export function relativeTime(iso: string | null, now = new Date()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `today, ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday, ${time}`;
  return `${monthDay.format(d)}, ${time}`;
}

/** "Nov 25" for a YYYY-MM-DD date (or "Nov 25, 2027" in another year). */
export function shortDate(day: string | null, now = new Date()): string | null {
  if (!day) return null;
  const d = new Date(`${day.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getFullYear() === now.getFullYear() ? monthDay.format(d) : monthDayYear.format(d);
}

export const SERVICE_NAMES = {
  netflix: 'Netflix', prime: 'Prime Video', hbomax: 'HBO Max', hulu: 'Hulu', disney: 'Disney+', paramount: 'Paramount+', peacock: 'Peacock',
} as const;
export type ServiceKey = keyof typeof SERVICE_NAMES;

/** The line under a poster: which service, rent or buy, or when it's coming. */
export function serviceLine(c: { services: ServiceKey[]; digital: boolean; soon: { date: string; service: ServiceKey | null } | null }):
  { text: string; tone: 'service' | 'digital' | 'soon' } | null {
  if (c.soon) return { text: `${shortDate(c.soon.date)} · ${c.soon.service ? SERVICE_NAMES[c.soon.service] : 'Rent or buy'}`, tone: 'soon' };
  if (c.services.length) return { text: SERVICE_NAMES[c.services[0]!] + (c.services.length > 1 ? ` +${c.services.length - 1}` : ''), tone: 'service' };
  if (c.digital) return { text: 'Rent or buy', tone: 'digital' };
  return null;
}

export const tmdbImage = {
  // Same sizes Seerr requests.
  poster: (path: string | null) => (path ? `https://image.tmdb.org/t/p/w300_and_h450_face${path}` : null),
  /** Textless poster and title logo for Apple-TV-style cards and the title page hero. */
  textless: (path: string | null) => (path ? `https://image.tmdb.org/t/p/w342${path}` : null),
  textlessLarge: (path: string | null) => (path ? `https://image.tmdb.org/t/p/w780${path}` : null),
  logo: (path: string | null) => (path ? `https://image.tmdb.org/t/p/w500${path}` : null),
  profile: (path: string | null) => (path ? `https://image.tmdb.org/t/p/w185${path}` : null),
  posterLarge: (path: string | null) => (path ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${path}` : null),
  backdrop: (path: string | null) => (path ? `https://image.tmdb.org/t/p/w1920_and_h800_multi_faces${path}` : null),
};
