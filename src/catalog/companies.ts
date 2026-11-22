// Movie studios (TMDB production companies) and TV networks, for the studio and
// network filters. TMDB lists some studios under several names over the years
// (20th Century Fox became 20th Century Studios); those share one group here.
import { all, type Db } from '../db/db.js';

export type CompanyKind = 'studio' | 'network';

const GROUPS: { name: string; match: RegExp }[] = [
  { name: '20th Century', match: /^(20th Century (Fox|Studios)|Twentieth Century Fox)( Film Corporation)?$/ },
  { name: 'Searchlight Pictures', match: /^(Fox )?Searchlight Pictures$/ },
  { name: 'Warner Bros.', match: /^Warner Bros\.( Pictures| Entertainment)?$/ },
  { name: 'Universal Pictures', match: /^Universal( Pictures)?$/ },
  { name: 'Paramount Pictures', match: /^Paramount( Pictures)?$/ },
  { name: 'Walt Disney Pictures', match: /^(Walt )?Disney Pictures$/ },
  { name: 'Columbia Pictures', match: /^Columbia Pictures( Corporation)?$/ },
  { name: 'Lionsgate', match: /^(Lionsgate|Lions Gate)( Films)?$/ },
  { name: 'Metro-Goldwyn-Mayer', match: /^(Metro-Goldwyn-Mayer|MGM)( Pictures| Studios)?$/ },
  { name: 'DreamWorks', match: /^DreamWorks( Pictures| SKG)?$/ },
];

export function companyGroup(name: string): string {
  return GROUPS.find((g) => g.match.test(name.trim()))?.name ?? name.trim();
}
/** URL key for a group: "20th Century" -> "20th-century". */
export const companyKey = (group: string) => group.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function saveCompanies(db: Db, titleId: number, kind: CompanyKind, list: { id: number; name: string }[]) {
  db.prepare('DELETE FROM title_companies WHERE title_id = ?').run(titleId);
  const c = db.prepare(`INSERT INTO companies (kind, id, name, group_name, group_key) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (kind, id) DO UPDATE SET name = excluded.name, group_name = excluded.group_name, group_key = excluded.group_key`);
  const tc = db.prepare('INSERT OR IGNORE INTO title_companies (title_id, kind, company_id) VALUES (?, ?, ?)');
  for (const x of list) {
    if (!x.name) continue;
    const group = companyGroup(x.name);
    c.run(kind, x.id, x.name, group, companyKey(group));
    tc.run(titleId, kind, x.id);
  }
}

/** SQL: the title is from one of these studios or networks (studios match movies, networks series). */
export function companyWhere(studios: string[] = [], networks: string[] = []): { sql: string; params: string[] } | null {
  const parts: string[] = [];
  const params: string[] = [];
  for (const [kind, keys] of [['studio', studios], ['network', networks]] as const) {
    if (!keys.length) continue;
    parts.push(`EXISTS (SELECT 1 FROM title_companies tc JOIN companies c ON c.kind = tc.kind AND c.id = tc.company_id
      WHERE tc.title_id = tk.id AND tc.kind = ? AND c.group_key IN (${keys.map(() => '?').join(',')}))`);
    params.push(kind, ...keys);
  }
  return parts.length ? { sql: `(${parts.join(' OR ')})`, params } : null;
}

export interface CompanyCount { key: string; name: string; count: number }

/** Studios or networks with titles on your services, most titles first. */
export function companyCounts(db: Db, kind: CompanyKind, eligible: { from: string; sql: string; params: (string | number)[] }, limit = 400): CompanyCount[] {
  // MATERIALIZED: work out the eligible titles once. Without it SQLite could re-run the whole
  // scope for every studio link (82k of them), which never finished on a full catalog.
  return all<CompanyCount>(db, `
    WITH e AS MATERIALIZED (SELECT DISTINCT tk.id ${eligible.from} WHERE ${eligible.sql})
    SELECT c.group_key AS key, c.group_name AS name, count(DISTINCT e.id) AS count
    FROM e
    JOIN title_companies tc ON tc.title_id = e.id AND tc.kind = ?
    JOIN companies c ON c.kind = tc.kind AND c.id = tc.company_id
    GROUP BY c.group_key ORDER BY count DESC, name LIMIT ?`, [...eligible.params, kind, limit]);
}
