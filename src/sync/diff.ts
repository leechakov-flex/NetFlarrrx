// Pure snapshot diff. Given the current availability state for one provider and
// region, plus the set of titles one complete sync saw, it decides what changes.
// No I/O here, so every rule in "Date added" is unit-testable.
//
// Rules:
//  - A title never seen before is new. On the baseline run it gets no date added.
//  - A seen title that was only "missing" (not yet removed) just resets.
//  - A title is removed only after `removeAfterMisses` consecutive complete misses.
//    Its removal time is the first miss.
//  - A removed title that returns within `returnWindowDays` of removal keeps its
//    date added. After that window it gets a new date and is flagged "back".

export interface AvailabilityState {
  id: number;                  // availability row id
  watchmodeId: number;
  addedAt: string | null;
  missingCount: number;
  missingSince: string | null;
  removedAt: string | null;
}

export interface DiffOptions {
  now: string;                 // ISO time of this sync
  baseline: boolean;           // first complete sync for this provider and region
  removeAfterMisses: number;
  returnWindowDays: number;
}

export interface Diff {
  insert: { watchmodeId: number; addedAt: string | null; baseline: boolean }[];
  seen: number[];                                            // active rows seen again
  returnedKeepDate: number[];                                // back within the window
  returnedNewDate: number[];                                 // back after the window
  missed: { id: number; missingCount: number; missingSince: string }[];
  removed: { id: number; missingCount: number; removedAt: string }[];
}

export function diffSnapshot(state: AvailabilityState[], snapshot: Iterable<number>, opts: DiffOptions): Diff {
  if (opts.removeAfterMisses < 1) throw new Error('removeAfterMisses must be at least 1');
  const seenIds = new Set(snapshot);
  const byWatchmode = new Map<number, AvailabilityState>();
  for (const row of state) byWatchmode.set(row.watchmodeId, row);

  const out: Diff = { insert: [], seen: [], returnedKeepDate: [], returnedNewDate: [], missed: [], removed: [] };
  const windowMs = opts.returnWindowDays * 86_400_000;
  const nowMs = Date.parse(opts.now);

  for (const wid of seenIds) {
    const row = byWatchmode.get(wid);
    if (!row) {
      out.insert.push({ watchmodeId: wid, addedAt: opts.baseline ? null : opts.now, baseline: opts.baseline });
    } else if (row.removedAt === null) {
      out.seen.push(row.id);
    } else if (nowMs - Date.parse(row.removedAt) <= windowMs) {
      out.returnedKeepDate.push(row.id);
    } else {
      out.returnedNewDate.push(row.id);
    }
  }

  for (const row of state) {
    if (row.removedAt !== null || seenIds.has(row.watchmodeId)) continue;
    const missingCount = row.missingCount + 1;
    const missingSince = row.missingSince ?? opts.now;
    if (missingCount >= opts.removeAfterMisses) {
      out.removed.push({ id: row.id, missingCount, removedAt: missingSince });
    } else {
      out.missed.push({ id: row.id, missingCount, missingSince });
    }
  }

  return out;
}

export function summarize(d: Diff) {
  return {
    added: d.insert.length,
    returned: d.returnedKeepDate.length,
    back_on_service: d.returnedNewDate.length,
    missed: d.missed.length,
    removed: d.removed.length,
  };
}
