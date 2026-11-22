// Builds Discover on its own thread with its own database connection, so the
// server keeps answering everything else while it works (Discover reads tens of
// thousands of rows and can take seconds on a full catalog).
import { parentPort, workerData } from 'node:worker_threads';
import type { Config } from '../config.js';
import { openDb } from '../db/db.js';
import { home, type CompanyPick } from './queries.js';
import type { ServiceKey } from '../services.js';

const cfg = workerData.cfg as Config;
const db = openDb(cfg.DATA_DIR);
parentPort!.on('message', (m: { id: number; now: string; only: ServiceKey[]; co: CompanyPick }) => {
  try {
    parentPort!.postMessage({ id: m.id, value: home(db, cfg, new Date(m.now), m.only, m.co) });
  } catch (err) {
    parentPort!.postMessage({ id: m.id, error: (err as Error).message });
  }
});
