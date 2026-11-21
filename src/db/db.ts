import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { migrations } from './migrations.js';

export type Db = DatabaseSync;
export type Params = Record<string, SQLInputValue> | SQLInputValue[];

export const DB_FILE = 'monkeysee.sqlite';
/** The app was called NetFlarrrx before; its database file is renamed on first start. */
const OLD_DB_FILE = 'netflarrrx.sqlite';

export function openDb(dataDir: string): Db {
  const path = dataDir === ':memory:' ? ':memory:' : join(dataDir, DB_FILE);
  if (path !== ':memory:') {
    mkdirSync(dataDir, { recursive: true });
    adoptOldDb(dataDir);
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

/** Move netflarrrx.sqlite (and its -wal/-shm files) to monkeysee.sqlite, once, before opening. */
export function adoptOldDb(dataDir: string) {
  const oldPath = join(dataDir, OLD_DB_FILE), newPath = join(dataDir, DB_FILE);
  if (existsSync(newPath) || !existsSync(oldPath)) return;
  for (const suffix of ['-wal', '-shm', '']) {   // main file last, so a crash midway retries next start
    if (existsSync(oldPath + suffix)) renameSync(oldPath + suffix, newPath + suffix);
  }
}

export function migrate(db: Db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(all<{ version: number }>(db, 'SELECT version FROM schema_migrations').map((r) => r.version));
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    tx(db, () => {
      db.exec(m.sql);
      run(db, 'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, new Date().toISOString()]);
    });
  }
}

// Runs fn inside a transaction; rolls back on any error. Nested calls join the outer one.
let depth = 0;
export function tx<T>(db: Db, fn: () => T): T {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth += 1;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth -= 1;
  }
}

function bind(params?: Params): SQLInputValue[] | [Record<string, SQLInputValue>] {
  if (params === undefined) return [];
  return Array.isArray(params) ? params : [params];
}

export function run(db: Db, sql: string, params?: Params) {
  return db.prepare(sql).run(...(bind(params) as SQLInputValue[]));
}

export function get<T>(db: Db, sql: string, params?: Params): T | undefined {
  return db.prepare(sql).get(...(bind(params) as SQLInputValue[])) as T | undefined;
}

export function all<T>(db: Db, sql: string, params?: Params): T[] {
  return db.prepare(sql).all(...(bind(params) as SQLInputValue[])) as T[];
}

export function setJobState(db: Db, key: string, value: unknown, now = new Date().toISOString()) {
  run(db, `INSERT INTO job_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  [key, JSON.stringify(value), now]);
}

export function getJobState<T>(db: Db, key: string): { value: T; updated_at: string } | undefined {
  const row = get<{ value: string; updated_at: string }>(db, 'SELECT value, updated_at FROM job_state WHERE key = ?', [key]);
  return row ? { value: JSON.parse(row.value) as T, updated_at: row.updated_at } : undefined;
}
