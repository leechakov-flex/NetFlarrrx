import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { getJobState, setJobState, type Db } from '../db/db.js';
import { log } from '../log.js';

export interface BackupState {
  ok: boolean;
  at: string;
  file?: string;
  bytes?: number;
  titles?: number;
  kept?: number;
  error?: string;
}

// monkeysee-YYYY-MM-DD.sqlite; netflarrrx-… files are from before the rename and age out normally.
const NAME = /^(?:monkeysee|netflarrrx)-(\d{4}-\d{2}-\d{2})\.sqlite$/;
const byDate = (a: string, b: string) => a.replace(NAME, '$1').localeCompare(b.replace(NAME, '$1'));

export function backupDir(cfg: Config): string | null {
  if (cfg.BACKUP_DIR) return cfg.BACKUP_DIR;
  return cfg.DATA_DIR === ':memory:' ? null : join(cfg.DATA_DIR, 'backups');
}

const localDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/**
 * Snapshot the database with VACUUM INTO (consistent while the app runs),
 * check the copy opens and passes SQLite's quick_check, then keep the newest
 * BACKUP_KEEP daily files. One file per day; a second run the same day replaces it.
 */
export function runBackup(db: Db, cfg: Config, now = new Date()): BackupState {
  const dir = backupDir(cfg);
  const at = now.toISOString();
  if (!dir) return record(db, { ok: false, at, error: 'no backup folder: set BACKUP_DIR' });
  const file = join(dir, `monkeysee-${localDate(now, cfg.TZ)}.sqlite`);
  const tmp = `${file}.partial`;
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(tmp)) rmSync(tmp);
    db.prepare('VACUUM INTO ?').run(tmp);
    const copy = new DatabaseSync(tmp, { readOnly: true });
    let titles: number;
    try {
      const check = copy.prepare('PRAGMA quick_check').get() as { quick_check: string };
      if (check.quick_check !== 'ok') throw new Error(`backup failed integrity check: ${check.quick_check}`);
      titles = (copy.prepare('SELECT count(*) n FROM availability').get() as { n: number }).n;
    } finally {
      copy.close();
    }
    if (existsSync(file)) rmSync(file);
    // Rename only after the check, so a half-written file never looks like a backup.
    renameSync(tmp, file);
    const kept = prune(dir, cfg.BACKUP_KEEP);
    const state = { ok: true, at, file, bytes: statSync(file).size, titles, kept };
    log.info('backup: done', { ...state });
    return record(db, state);
  } catch (err) {
    try { if (existsSync(tmp)) rmSync(tmp); } catch { /* ignore */ }
    const error = err instanceof Error ? err.message : String(err);
    log.error('backup: failed', { dir, error });
    return record(db, { ok: false, at, error });
  }
}

function prune(dir: string, keep: number): number {
  const files = readdirSync(dir).filter((f) => NAME.test(f)).sort(byDate).reverse();   // newest first (ISO dates)
  for (const f of files.slice(Math.max(1, keep))) rmSync(join(dir, f));
  return Math.min(files.length, Math.max(1, keep));
}

function record(db: Db, state: BackupState): BackupState {
  // A failure keeps the last good backup's time so health can say how old it is.
  const prev = getJobState<BackupState & { lastOkAt?: string }>(db, 'backup')?.value;
  setJobState(db, 'backup', { ...state, lastOkAt: state.ok ? state.at : prev?.lastOkAt ?? null });
  return state;
}

export function lastBackup(db: Db) {
  return getJobState<BackupState & { lastOkAt?: string | null }>(db, 'backup')?.value ?? null;
}
