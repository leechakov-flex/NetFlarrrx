// Builds Discover on its own thread with its own database connection, so the
// server keeps answering everything else while it works (Discover reads tens of
// thousands of rows and can take seconds on a full catalog).
import { parentPort, workerData } from 'node:worker_threads';
import type { Config } from '../config.js';
import { openDb } from '../db/db.js';
import { companies, home, type CompanyPick } from './queries.js';
import type { ServiceKey } from '../services.js';

const cfg = workerData.cfg as Config;
const db = openDb(cfg.DATA_DIR);
parentPort!.on('message', (m: { id: number; job?: 'home' | 'companies'; now: string; only: ServiceKey[]; co: CompanyPick }) => {
  try {
    const now = new Date(m.now);
    parentPort!.postMessage({ id: m.id, value: m.job === 'companies' ? companies(db, cfg, now) : home(db, cfg, now, m.only, m.co) });
  } catch (err) {
    parentPort!.postMessage({ id: m.id, error: (err as Error).message });
  }
});
