import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SchemaOutdatedError, Store, userVersion } from '../src/store.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A pre-versioning (user_version 0) database with representative NFL rows, as production had. */
function legacyDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-migrate-'));
  dirs.push(dir);
  const file = path.join(dir, 'sportscenter.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(MIGRATIONS[0]!);
  db.exec(`
    INSERT INTO runs (id, sport, cohort, kind, started_at, window_start, window_end, status, config_json) VALUES ('r1','nfl','personal','prospective','2026-10-02T00:00:00Z','a','b','ok','{}');
    INSERT INTO events VALUES ('nfl:espn:1','nfl','NFL','espn','1',2026,2,3,'2026-09-27T17:00:00Z','COMPLETED','STATUS_FINAL','{"abbr":"BUF"}','{"abbr":"LAC"}','2026-09-28T00:00:00Z','2026-10-02T00:00:00Z','2026-09-27T18:00:00Z','2026-09-27T21:00:00Z');
    INSERT INTO run_events VALUES ('r1','nfl:espn:1',1);
    INSERT INTO discovery VALUES ('nfl:espn:1','FOUND','2026-09-27T21:00:00Z','2026-09-27T21:00:00Z','2026-10-02T00:00:00Z');
    INSERT INTO candidates VALUES ('nfl:espn:1','v1','nfl-youtube','UC','t','2026-09-27T21:30:00Z',900,1,'[]',1,'[]','x','y');
    INSERT INTO highlights VALUES ('nfl:espn:1','v1','nfl-youtube','2026-09-27T21:31:00Z');
    INSERT INTO match_audits VALUES ('nfl:espn:1','v1','correct','2026-10-02T00:00:00Z',NULL);
  `);
  db.close();
  return file;
}

const dump = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(['runs', 'events', 'run_events', 'discovery', 'candidates', 'highlights', 'match_audits'].map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));
  } finally {
    db.close();
  }
};

describe('store migrations', () => {
  it('opening an outdated file database fails closed instead of migrating implicitly', () => {
    const file = legacyDb();
    expect(() => new Store(file)).toThrow(SchemaOutdatedError);
  });

  it('backs up consistently, migrates v0 → current, and preserves every existing row', () => {
    const file = legacyDb();
    const before = dump(file);
    const r = Store.migrateFile(file, path.join(path.dirname(file), 'backups'), '2026-10-03T12:00:00.000Z');
    expect(r).toMatchObject({ from: 0, to: MIGRATIONS.length });
    expect(dump(file)).toEqual(before);
    expect(dump(r.backup!)).toEqual(before); // restorable copy of the pre-migration state

    const store = new Store(file);
    expect(userVersion(store.db)).toBe(MIGRATIONS.length);
    expect(store.installId(() => 'install-1')).toBe('install-1');
    expect(store.installId(() => 'install-2')).toBe('install-1'); // stable once created
    store.close();
    expect(Store.migrateFile(file, path.join(path.dirname(file), 'backups'), 'later')).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length });
  });

  it('an interrupted migration rolls back and leaves the previous version intact', () => {
    const file = legacyDb();
    Store.migrateFile(file, path.join(path.dirname(file), 'backups'), 'now');
    const broken = [...MIGRATIONS, 'CREATE TABLE half_done (a INTEGER); THIS IS NOT SQL;'];
    expect(() => Store.migrateFile(file, path.join(path.dirname(file), 'backups'), 'now2', broken)).toThrow(/rolled back/);
    const db = new DatabaseSync(file, { readOnly: true });
    expect(userVersion(db)).toBe(MIGRATIONS.length);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'").get()).toEqual({ n: 0 });
    db.close();
  });

  it('refuses a database newer than the engine', () => {
    const file = legacyDb();
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    expect(() => Store.migrateFile(file, path.dirname(file), 'now')).toThrow(/newer than this engine/);
  });
});
