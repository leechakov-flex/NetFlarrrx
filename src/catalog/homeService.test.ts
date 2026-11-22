import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testConfig } from '../config.js';
import { openDb, run } from '../db/db.js';
import { HomeService } from './homeService.js';

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

describe('Discover cache', () => {
  it('serves the cached Discover, and the last one while a fresh one builds', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ms-home-'));
    const cfg = testConfig({ DATA_DIR: dir });
    const db = openDb(dir);
    const homes = new HomeService(db, cfg);
    const a = await homes.get([], {});
    expect(await homes.get([], {})).toBe(a);                 // same object: from the cache
    run(db, `INSERT INTO job_state (key, value, updated_at) VALUES ('x', '1', '')`);
    homes.invalidate();
    expect(await homes.get([], {})).toBe(a);                 // stale copy served at once...
    await new Promise((r) => setTimeout(r, 20));
    expect(await homes.get([], {})).not.toBe(a);             // ...and replaced by the rebuild
    expect(await homes.get(['netflix'], {})).not.toBe(a);    // each filter has its own entry
    homes.close(); db.close();
  });
});
