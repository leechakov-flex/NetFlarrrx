import { describe, it, expect } from 'vitest';
import { diffSnapshot, type AvailabilityState, type Diff } from './diff.js';

// A tiny in-memory "database" that applies diffs, so tests can run multi-day
// sequences the same way the real sync does.
class Sim {
  rows: (AvailabilityState & { backOnService: boolean; baseline: boolean })[] = [];
  nextId = 1;
  day = 0;
  runs = 0;
  constructor(public removeAfterMisses = 2, public returnWindowDays = 14) {}

  at(day: number) { return new Date(Date.UTC(2026, 10, 1 + day, 11)).toISOString(); }

  sync(ids: number[], day = this.day + 1): Diff {
    this.day = day;
    const now = this.at(day);
    const d = diffSnapshot(this.rows, ids, {
      now, baseline: this.runs === 0, removeAfterMisses: this.removeAfterMisses, returnWindowDays: this.returnWindowDays,
    });
    this.runs += 1;
    for (const i of d.insert) {
      this.rows.push({ id: this.nextId++, watchmodeId: i.watchmodeId, addedAt: i.addedAt, missingCount: 0,
        missingSince: null, removedAt: null, backOnService: false, baseline: i.baseline });
    }
    const byId = new Map(this.rows.map((r) => [r.id, r]));
    for (const id of d.seen) Object.assign(byId.get(id)!, { missingCount: 0, missingSince: null });
    for (const id of d.returnedKeepDate) Object.assign(byId.get(id)!, { missingCount: 0, missingSince: null, removedAt: null });
    for (const id of d.returnedNewDate) Object.assign(byId.get(id)!, { missingCount: 0, missingSince: null, removedAt: null, addedAt: now, backOnService: true });
    for (const m of d.missed) Object.assign(byId.get(m.id)!, { missingCount: m.missingCount, missingSince: m.missingSince });
    for (const r of d.removed) Object.assign(byId.get(r.id)!, { missingCount: r.missingCount, removedAt: r.removedAt });
    return d;
  }

  row(wid: number) { return this.rows.find((r) => r.watchmodeId === wid)!; }
  active() { return this.rows.filter((r) => r.removedAt === null).map((r) => r.watchmodeId).sort((a, b) => a - b); }
}

describe('diffSnapshot', () => {
  it('baseline run inserts everything with no date added', () => {
    const s = new Sim();
    const d = s.sync([1, 2, 3], 0);
    expect(d.insert).toHaveLength(3);
    expect(d.insert.every((i) => i.addedAt === null && i.baseline)).toBe(true);
  });

  it('titles first seen after the baseline get that sync as date added', () => {
    const s = new Sim();
    s.sync([1, 2], 0);
    const d = s.sync([1, 2, 3], 1);
    expect(d.insert).toEqual([{ watchmodeId: 3, addedAt: s.at(1), baseline: false }]);
    expect(s.row(1).addedAt).toBeNull();
  });

  it('page order and duplicates do not change the result', () => {
    const a = new Sim(); const b = new Sim();
    a.sync([1, 2, 3], 0); b.sync([3, 1, 2, 2, 1], 0);
    const da = a.sync([4, 1, 2, 5], 1); const db = b.sync([5, 5, 2, 4, 1], 1);
    const norm = (d: Diff) => ({ ...d, insert: [...d.insert].sort((x, y) => x.watchmodeId - y.watchmodeId) });
    expect(norm(da).insert).toEqual(norm(db).insert);
    expect(da.missed.length).toBe(db.missed.length);
    expect(a.active()).toEqual(b.active());
  });

  it('a single miss does not remove a title', () => {
    const s = new Sim();
    s.sync([1, 2], 0);
    const d = s.sync([1], 1);
    expect(d.missed).toEqual([{ id: s.row(2).id, missingCount: 1, missingSince: s.at(1) }]);
    expect(d.removed).toEqual([]);
    expect(s.active()).toEqual([1, 2]);
  });

  it('a miss followed by a sighting resets without touching the date', () => {
    const s = new Sim();
    s.sync([1], 0);
    s.sync([1, 2], 1);
    s.sync([1], 2);
    const d = s.sync([1, 2], 3);
    expect(d.seen).toContain(s.row(2).id);
    expect(d.insert).toEqual([]);
    expect(s.row(2)).toMatchObject({ addedAt: s.at(1), missingCount: 0, missingSince: null, removedAt: null });
  });

  it('two consecutive misses remove the title, dated at the first miss', () => {
    const s = new Sim();
    s.sync([1, 2], 0);
    s.sync([1], 1);
    const d = s.sync([1], 2);
    expect(d.removed).toEqual([{ id: s.row(2).id, missingCount: 2, removedAt: s.at(1) }]);
    expect(s.active()).toEqual([1]);
  });

  it('a removed title is not counted again while it stays gone', () => {
    const s = new Sim();
    s.sync([1, 2], 0); s.sync([1], 1); s.sync([1], 2);
    const d = s.sync([1], 3);
    expect(d.missed).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('a return within the window keeps the original date added', () => {
    const s = new Sim();
    s.sync([1], 0);
    s.sync([1, 2], 1);            // 2 added day 1
    s.sync([1], 2); s.sync([1], 3); // removed, dated day 2
    const d = s.sync([1, 2], 16); // 14 days after removal
    expect(d.returnedKeepDate).toEqual([s.row(2).id]);
    expect(s.row(2)).toMatchObject({ addedAt: s.at(1), backOnService: false, removedAt: null });
  });

  it('a return after the window gets a new date and is flagged back', () => {
    const s = new Sim();
    s.sync([1], 0);
    s.sync([1, 2], 1);
    s.sync([1], 2); s.sync([1], 3);
    const d = s.sync([1, 2], 17);  // 15 days after removal
    expect(d.returnedNewDate).toEqual([s.row(2).id]);
    expect(s.row(2)).toMatchObject({ addedAt: s.at(17), backOnService: true });
  });

  it('a baseline title that leaves and returns late becomes datable', () => {
    const s = new Sim();
    s.sync([1, 2], 0);
    s.sync([1], 1); s.sync([1], 2);
    s.sync([1, 2], 30);
    expect(s.row(2)).toMatchObject({ addedAt: s.at(30), backOnService: true, baseline: true });
  });

  it('honours a different miss threshold', () => {
    const s = new Sim(3);
    s.sync([1, 2], 0); s.sync([1], 1); s.sync([1], 2);
    expect(s.active()).toEqual([1, 2]);
    s.sync([1], 3);
    expect(s.active()).toEqual([1]);
    expect(s.row(2).removedAt).toBe(s.at(1));
  });

  it('an empty snapshot marks every active title missed, never removed, after one run', () => {
    // The sync layer holds suspicious runs before they reach here; this checks
    // the diff itself stays conservative.
    const s = new Sim();
    s.sync([1, 2, 3], 0);
    const d = s.sync([], 1);
    expect(d.missed).toHaveLength(3);
    expect(d.removed).toHaveLength(0);
  });

  it('rejects a zero miss threshold', () => {
    expect(() => diffSnapshot([], [1], { now: new Date().toISOString(), baseline: true, removeAfterMisses: 0, returnWindowDays: 14 }))
      .toThrow();
  });

  it('a long random sequence never removes a title seen within its last two syncs', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const s = new Sim();
    const history: number[][] = [];
    for (let day = 0; day < 60; day += 1) {
      const ids = Array.from({ length: 40 }, (_, i) => i + 1).filter(() => rand() > 0.15);
      history.push(ids);
      s.sync(ids, day);
      const recent = new Set([...(history.at(-1) ?? []), ...(history.at(-2) ?? [])]);
      for (const wid of recent) expect(s.row(wid).removedAt, `title ${wid} on day ${day}`).toBeNull();
    }
  });
});
