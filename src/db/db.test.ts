import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, get, openDb } from './db.js';

describe('rename from NetFlarrrx', () => {
  it('moves an existing netflarrrx.sqlite to monkeysee.sqlite and keeps its data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-db-'));
    const old = new DatabaseSync(join(dir, 'netflarrrx.sqlite'));
    old.exec('CREATE TABLE keepme (v TEXT); INSERT INTO keepme VALUES (\'hello\');');
    old.close();
    const db = openDb(dir);
    expect(get<{ v: string }>(db, 'SELECT v FROM keepme')?.v).toBe('hello');
    db.close();
    expect(existsSync(join(dir, DB_FILE))).toBe(true);
    expect(existsSync(join(dir, 'netflarrrx.sqlite'))).toBe(false);
  });

  it('leaves an old file alone once monkeysee.sqlite exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-db-'));
    openDb(dir).close();
    writeFileSync(join(dir, 'netflarrrx.sqlite'), 'stale');
    openDb(dir).close();
    expect(existsSync(join(dir, 'netflarrrx.sqlite'))).toBe(true);
  });
});
