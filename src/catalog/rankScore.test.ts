import { describe, expect, it } from 'vitest';
import { all, migrate, openDb, run } from '../db/db.js';

describe('rank_score (popularity weighted by rating)', () => {
  const db = openDb(':memory:'); migrate(db);
  const add = (id: number, popularity: number, vote_average: number | null, vote_count: number | null) =>
    run(db, `INSERT INTO titles (watchmode_id, title, watchmode_type, tmdb_id, tmdb_type, popularity, vote_average, vote_count, created_at, updated_at)
             VALUES (?, ?, 'movie', ?, 'movie', ?, ?, ?, '2026-01-01', '2026-01-01')`, [id, `t${id}`, id, popularity, vote_average, vote_count]);
  add(1, 100, 8.0, 5000);   // well liked
  add(2, 100, 5.0, 5000);   // poorly rated
  add(3, 100, 9.5, 3);      // hardly any votes yet
  add(4, 100, null, null);  // brand new, no score
  add(5, 180, 5.0, 5000);   // much more popular but bad
  const r = Object.fromEntries(all<{ id: number; s: number; b: number }>(db,
    'SELECT watchmode_id id, rank_score s, rating_bayes b FROM title_kinds').map((x: { id: number; s: number; b: number }) => [x.id, x]));

  it('lifts good titles and sinks bad ones at the same popularity', () => {
    expect(r[1]!.s).toBeGreaterThan(200);
    expect(r[2]!.s).toBeLessThan(45);
  });
  it('does not trust a handful of votes', () => {
    expect(r[3]!.b).toBeLessThan(6.7);
    expect(r[3]!.s).toBeGreaterThan(95);
    expect(r[3]!.s).toBeLessThan(110);
    expect(r[4]!.s).toBeCloseTo(100);
  });
  it('lets a well rated title beat a more popular bad one', () => {
    expect(r[1]!.s).toBeGreaterThan(r[5]!.s);
  });
});
