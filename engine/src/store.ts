import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Cohort, DiscoveryStatus, RunIssue, RunKind, RunStatus, SportEvent, Window } from './domain.ts';

/** v1: the original NFL discovery schema (IF NOT EXISTS adopts databases created before versioning). */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  cohort TEXT NOT NULL CHECK (cohort IN ('personal','diagnostic')),
  kind TEXT NOT NULL CHECK (kind IN ('prospective','backfill','manual')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT CHECK (status IN ('ok','incomplete','failed')),
  issues_json TEXT NOT NULL DEFAULT '[]',
  config_json TEXT NOT NULL,
  quota_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  competition TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  season_type INTEGER NOT NULL,
  week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  home_json TEXT NOT NULL,
  away_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  -- Observation bounds for completion time. Never overwritten once set.
  last_observed_nonfinal_at TEXT,
  first_observed_final_at TEXT
);

-- Per-run denominators: which events each run considered eligible, under that run's config.
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  eligible INTEGER NOT NULL,
  PRIMARY KEY (run_id, event_id)
);

CREATE TABLE IF NOT EXISTS discovery (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  status TEXT NOT NULL CHECK (status IN ('WAITING_FOR_EVENT_END','SEARCHING','FOUND','UNAVAILABLE')),
  first_searched_at TEXT,
  found_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  source_id TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  method TEXT NOT NULL,
  scan_complete INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL DEFAULT '{}'
);

-- Raw publisher titles stay inside the engine; they are never exported to the TV.
CREATE TABLE IF NOT EXISTS candidates (
  event_id TEXT NOT NULL REFERENCES events(id),
  video_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  raw_title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  duration_seconds INTEGER,
  confidence REAL NOT NULL,
  match_flags_json TEXT NOT NULL,
  metadata_eligible INTEGER NOT NULL,
  metadata_reasons_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (event_id, video_id)
);

-- Deterministic primary per event (one row per event: no duplicate library items).
CREATE TABLE IF NOT EXISTS highlights (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  video_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  selected_at TEXT NOT NULL
);

-- Playback evidence, independent of metadata screening.
CREATE TABLE IF NOT EXISTS playback_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('target-tv','browser')),
  region TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('VERIFIED','FAILED')),
  failure_reason TEXT,
  notes TEXT
);

-- Manual match audits: the only source of "correct"/"wrong" match truth.
CREATE TABLE IF NOT EXISTS match_audits (
  event_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('correct','wrong')),
  audited_at TEXT NOT NULL,
  notes TEXT,
  PRIMARY KEY (event_id, video_id)
);
`;

/** v2: playlist-publishing experiment — install identity, metadata revalidation, title screening, publish state. */
const SCHEMA_V2 = `
CREATE TABLE engine_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Latest metadata check per video, from discovery or catalog revalidation.
-- available = 0 only when videos.list succeeded and omitted the video (confirmed removal), never on a failed fetch.
CREATE TABLE video_checks (
  video_id TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL,
  available INTEGER NOT NULL,
  channel_id TEXT,
  title TEXT,
  title_fingerprint TEXT,
  screen_reasons_json TEXT NOT NULL
);

-- Title spoiler heuristic per video, valid for one title fingerprint and screening version.
-- 'unflagged' means the heuristic found no warning, not that the title is proven spoiler-safe.
CREATE TABLE title_screens (
  video_id TEXT PRIMARY KEY,
  title_fingerprint TEXT NOT NULL,
  screening_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('flagged','unflagged','unreviewed')),
  reasons_json TEXT NOT NULL,
  screened_at TEXT NOT NULL
);

-- Engine-owned playlists. Never adopted by title; owner channel and install marker are tracked.
CREATE TABLE publish_playlists (
  collection_id TEXT PRIMARY KEY,
  playlist_id TEXT,
  channel_id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('creating','active','unresolved','conflict')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per publisher run. units counts attempted calls (succeeded or not), updated as each call is made.
CREATE TABLE publish_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  quota_day TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry-run','apply')),
  status TEXT CHECK (status IN ('ok','incomplete','failed','budget_limited')),
  catalog_generated_at TEXT,
  calls_json TEXT NOT NULL DEFAULT '{}',
  units INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX publish_runs_quota_day ON publish_runs (quota_day);
`;

/** Sequential migrations: MIGRATIONS[i] upgrades user_version i → i+1. Append only; never edit a shipped entry. */
export const MIGRATIONS: readonly string[] = [SCHEMA_V1, SCHEMA_V2];

export class SchemaOutdatedError extends Error {}

export function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

export function verifyIntegrity(db: DatabaseSync): void {
  const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]!.integrity_check !== 'ok') throw new Error(`integrity_check failed: ${JSON.stringify(integrity)}`);
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  if (fk.length) throw new Error(`foreign_key_check failed: ${fk.length} violation(s)`);
}

/**
 * Apply pending migrations, each in its own transaction (user_version is set inside it, so an
 * interrupted migration rolls back cleanly), then verify integrity and foreign keys.
 */
export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): { from: number; to: number } {
  const from = userVersion(db);
  if (from > migrations.length) throw new Error(`Database schema v${from} is newer than this engine (v${migrations.length}); run the matching engine version`);
  for (let v = from; v < migrations.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration to v${v + 1} failed and was rolled back: ${(err as Error).message}`);
    }
  }
  verifyIntegrity(db);
  return { from, to: userVersion(db) };
}

export interface MigrationResult {
  from: number;
  to: number;
  backup?: string;
}

export interface CandidateRow {
  eventId: string;
  videoId: string;
  sourceId: string;
  channelId: string;
  rawTitle: string;
  publishedAt: string;
  durationSeconds: number | null;
  confidence: number;
  flags: string[];
  metadataEligible: boolean;
  metadataReasons: string[];
}

export class Store {
  readonly db: DatabaseSync;

  /**
   * A file database is never migrated implicitly: an outdated schema throws SchemaOutdatedError, so
   * scheduled jobs fail closed until `pnpm migrate` (backup, migrate, verify under the engine lock) runs.
   * In-memory databases (tests) are always migrated.
   */
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file === ':memory:') migrate(this.db);
    else if (userVersion(this.db) !== MIGRATIONS.length) {
      const v = userVersion(this.db);
      this.db.close();
      throw new SchemaOutdatedError(`Database schema is v${v}, engine expects v${MIGRATIONS.length}; run \`pnpm migrate\``);
    }
  }

  /**
   * Back up with VACUUM INTO (SQLite-consistent, never a raw copy of a live WAL file), verify the backup,
   * then migrate and verify. The caller must hold the engine lock so no scheduled writer runs concurrently.
   */
  static migrateFile(file: string, backupDir: string, now: string, migrations: readonly string[] = MIGRATIONS): MigrationResult {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const from = userVersion(db);
      if (from === migrations.length) return { from, to: from };
      let backup: string | undefined;
      if ((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n > 0) {
        fs.mkdirSync(backupDir, { recursive: true });
        backup = path.join(backupDir, `${path.basename(file, '.db')}-v${from}-${now.replace(/[:.]/g, '')}.db`);
        db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
        const check = new DatabaseSync(backup, { readOnly: true });
        try {
          verifyIntegrity(check);
        } finally {
          check.close();
        }
      }
      return { ...migrate(db, migrations), backup };
    } finally {
      db.close();
    }
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  startRun(r: { id: string; sport: string; cohort: Cohort; kind: RunKind; startedAt: string; window: Window; config: unknown }): void {
    this.db
      .prepare('INSERT INTO runs (id, sport, cohort, kind, started_at, window_start, window_end, config_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(r.id, r.sport, r.cohort, r.kind, r.startedAt, r.window.start, r.window.end, JSON.stringify(r.config));
  }

  finishRun(id: string, finishedAt: string, status: RunStatus, issues: RunIssue[], quota: unknown): void {
    this.db
      .prepare('UPDATE runs SET finished_at = ?, status = ?, issues_json = ?, quota_json = ? WHERE id = ?')
      .run(finishedAt, status, JSON.stringify(issues), JSON.stringify(quota), id);
  }

  /** Upsert an observed event; completion observation bounds are write-once. */
  upsertEvent(e: SportEvent, observedAt: string, prospective: boolean): void {
    const isFinal = e.status === 'COMPLETED';
    this.db
      .prepare(
        `INSERT INTO events (id, sport, competition, provider, provider_event_id, season, season_type, week, start_time, status,
           provider_status, home_json, away_json, first_seen_at, last_seen_at, last_observed_nonfinal_at, first_observed_final_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           season = excluded.season, season_type = excluded.season_type, week = excluded.week,
           start_time = excluded.start_time, status = excluded.status, provider_status = excluded.provider_status,
           home_json = excluded.home_json, away_json = excluded.away_json, last_seen_at = excluded.last_seen_at,
           last_observed_nonfinal_at = CASE
             WHEN events.first_observed_final_at IS NULL AND excluded.last_observed_nonfinal_at IS NOT NULL
             THEN excluded.last_observed_nonfinal_at ELSE events.last_observed_nonfinal_at END,
           first_observed_final_at = COALESCE(events.first_observed_final_at, excluded.first_observed_final_at)`,
      )
      .run(
        e.id, e.sport, e.competition, e.provider, e.providerEventId, e.season, e.seasonType, e.week, e.startTime, e.status,
        e.providerStatus, JSON.stringify(e.home), JSON.stringify(e.away), observedAt, observedAt,
        isFinal ? null : observedAt,
        // A backfill seeing an already-final game does not bound completion time; only prospective runs record it.
        isFinal && prospective ? observedAt : null,
      );
  }

  recordRunEvent(runId: string, eventId: string, eligible: boolean): void {
    this.db.prepare('INSERT OR REPLACE INTO run_events (run_id, event_id, eligible) VALUES (?,?,?)').run(runId, eventId, eligible ? 1 : 0);
  }

  getDiscovery(eventId: string): { status: DiscoveryStatus; first_searched_at: string | null; found_at: string | null } | undefined {
    return this.db.prepare('SELECT status, first_searched_at, found_at FROM discovery WHERE event_id = ?').get(eventId) as never;
  }

  setDiscovery(eventId: string, status: DiscoveryStatus, at: string): void {
    this.db
      .prepare(
        `INSERT INTO discovery (event_id, status, first_searched_at, found_at, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(event_id) DO UPDATE SET
           status = excluded.status,
           first_searched_at = COALESCE(discovery.first_searched_at, excluded.first_searched_at),
           found_at = CASE WHEN excluded.status = 'FOUND' THEN COALESCE(discovery.found_at, excluded.found_at) ELSE discovery.found_at END,
           updated_at = excluded.updated_at`,
      )
      .run(eventId, status, status === 'WAITING_FOR_EVENT_END' ? null : at, status === 'FOUND' ? at : null, at);
  }

  recordAttempt(a: { runId: string; eventId: string; sourceId: string; at: string; method: string; scanComplete: boolean; outcome: string; diagnostics: unknown }): void {
    this.db
      .prepare('INSERT INTO discovery_attempts (run_id, event_id, source_id, attempted_at, method, scan_complete, outcome, diagnostics_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(a.runId, a.eventId, a.sourceId, a.at, a.method, a.scanComplete ? 1 : 0, a.outcome, JSON.stringify(a.diagnostics));
  }

  upsertCandidate(c: CandidateRow, at: string): void {
    this.db
      .prepare(
        `INSERT INTO candidates (event_id, video_id, source_id, channel_id, raw_title, published_at, duration_seconds, confidence,
           match_flags_json, metadata_eligible, metadata_reasons_json, first_seen_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(event_id, video_id) DO UPDATE SET
           raw_title = excluded.raw_title, duration_seconds = excluded.duration_seconds, confidence = excluded.confidence,
           match_flags_json = excluded.match_flags_json, metadata_eligible = excluded.metadata_eligible,
           metadata_reasons_json = excluded.metadata_reasons_json, last_seen_at = excluded.last_seen_at`,
      )
      .run(
        c.eventId, c.videoId, c.sourceId, c.channelId, c.rawTitle, c.publishedAt, c.durationSeconds, c.confidence,
        JSON.stringify(c.flags), c.metadataEligible ? 1 : 0, JSON.stringify(c.metadataReasons), at, at,
      );
  }

  /** Deterministic primary: eligible only; highest confidence, then earliest publish, then video ID. */
  selectPrimary(eventId: string, at: string): { videoId: string; sourceId: string } | undefined {
    const best = this.db
      .prepare(
        `SELECT video_id, source_id FROM candidates WHERE event_id = ? AND metadata_eligible = 1
         ORDER BY confidence DESC, published_at ASC, video_id ASC LIMIT 1`,
      )
      .get(eventId) as { video_id: string; source_id: string } | undefined;
    if (!best) {
      this.db.prepare('DELETE FROM highlights WHERE event_id = ?').run(eventId);
      return undefined;
    }
    this.db
      .prepare(
        `INSERT INTO highlights (event_id, video_id, source_id, selected_at) VALUES (?,?,?,?)
         ON CONFLICT(event_id) DO UPDATE SET
           selected_at = CASE WHEN highlights.video_id = excluded.video_id THEN highlights.selected_at ELSE excluded.selected_at END,
           video_id = excluded.video_id, source_id = excluded.source_id`,
      )
      .run(eventId, best.video_id, best.source_id, at);
    return { videoId: best.video_id, sourceId: best.source_id };
  }

  /** Latest playback evidence for a video in an environment, or NOT_TESTED. */
  playbackStatus(videoId: string, environment: 'target-tv' | 'browser'): 'NOT_TESTED' | 'VERIFIED' | 'FAILED' {
    const row = this.db
      .prepare('SELECT status FROM playback_observations WHERE video_id = ? AND environment = ? ORDER BY observed_at DESC, id DESC LIMIT 1')
      .get(videoId, environment) as { status: 'VERIFIED' | 'FAILED' } | undefined;
    return row?.status ?? 'NOT_TESTED';
  }

  recordPlayback(o: { videoId: string; at: string; environment: 'target-tv' | 'browser'; region: string; status: 'VERIFIED' | 'FAILED'; failureReason?: string; notes?: string }): void {
    this.db
      .prepare('INSERT INTO playback_observations (video_id, observed_at, environment, region, status, failure_reason, notes) VALUES (?,?,?,?,?,?,?)')
      .run(o.videoId, o.at, o.environment, o.region, o.status, o.failureReason ?? null, o.notes ?? null);
  }

  recordAudit(eventId: string, videoId: string, verdict: 'correct' | 'wrong', at: string, notes?: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO match_audits (event_id, video_id, verdict, audited_at, notes) VALUES (?,?,?,?,?)')
      .run(eventId, videoId, verdict, at, notes ?? null);
  }

  // ---- v2: revalidation, title screening, publishing ------------------------

  /** Stable engine install ID, durably created on first use (before any remote creation relies on it). */
  installId(create: () => string): string {
    this.db.prepare("INSERT OR IGNORE INTO engine_meta (key, value) VALUES ('install_id', ?)").run(create());
    return (this.db.prepare("SELECT value FROM engine_meta WHERE key = 'install_id'").get() as { value: string }).value;
  }

  /** Record a successful metadata lookup. `available: false` only for confirmed removal (absent from a successful videos.list). */
  recordVideoCheck(c: VideoCheck): void {
    this.db
      .prepare(
        `INSERT INTO video_checks (video_id, checked_at, available, channel_id, title, title_fingerprint, screen_reasons_json) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET checked_at = excluded.checked_at, available = excluded.available, channel_id = excluded.channel_id,
           title = excluded.title, title_fingerprint = excluded.title_fingerprint, screen_reasons_json = excluded.screen_reasons_json`,
      )
      .run(c.videoId, c.checkedAt, c.available ? 1 : 0, c.channelId ?? null, c.title ?? null, c.titleFingerprint ?? null, JSON.stringify(c.screenReasons));
  }

  videoCheck(videoId: string): VideoCheck | undefined {
    const r = this.db.prepare('SELECT * FROM video_checks WHERE video_id = ?').get(videoId) as
      | { video_id: string; checked_at: string; available: number; channel_id: string | null; title: string | null; title_fingerprint: string | null; screen_reasons_json: string }
      | undefined;
    return (
      r && {
        videoId: r.video_id, checkedAt: r.checked_at, available: r.available === 1, channelId: r.channel_id ?? undefined,
        title: r.title ?? undefined, titleFingerprint: r.title_fingerprint ?? undefined, screenReasons: JSON.parse(r.screen_reasons_json),
      }
    );
  }

  recordTitleScreen(s: { videoId: string; titleFingerprint: string; version: number; status: string; reasons: string[]; at: string }): void {
    this.db
      .prepare(
        `INSERT INTO title_screens (video_id, title_fingerprint, screening_version, status, reasons_json, screened_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(video_id) DO UPDATE SET title_fingerprint = excluded.title_fingerprint, screening_version = excluded.screening_version,
           status = excluded.status, reasons_json = excluded.reasons_json, screened_at = excluded.screened_at`,
      )
      .run(s.videoId, s.titleFingerprint, s.version, s.status, JSON.stringify(s.reasons), s.at);
  }

  titleScreen(videoId: string): { titleFingerprint: string; version: number; status: 'flagged' | 'unflagged' | 'unreviewed'; reasons: string[] } | undefined {
    const r = this.db.prepare('SELECT title_fingerprint, screening_version, status, reasons_json FROM title_screens WHERE video_id = ?').get(videoId) as
      | { title_fingerprint: string; screening_version: number; status: 'flagged' | 'unflagged' | 'unreviewed'; reasons_json: string }
      | undefined;
    return r && { titleFingerprint: r.title_fingerprint, version: r.screening_version, status: r.status, reasons: JSON.parse(r.reasons_json) };
  }

  publishPlaylist(collectionId: string): PublishPlaylist | undefined {
    const r = this.db.prepare('SELECT * FROM publish_playlists WHERE collection_id = ?').get(collectionId) as
      | { collection_id: string; playlist_id: string | null; channel_id: string; install_id: string; state: PublishPlaylist['state'] }
      | undefined;
    return r && { collectionId: r.collection_id, playlistId: r.playlist_id ?? undefined, channelId: r.channel_id, installId: r.install_id, state: r.state };
  }

  setPublishPlaylist(p: PublishPlaylist, at: string): void {
    this.db
      .prepare(
        `INSERT INTO publish_playlists (collection_id, playlist_id, channel_id, install_id, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(collection_id) DO UPDATE SET playlist_id = excluded.playlist_id, channel_id = excluded.channel_id,
           install_id = excluded.install_id, state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(p.collectionId, p.playlistId ?? null, p.channelId, p.installId, p.state, at, at);
  }

  deletePublishPlaylist(collectionId: string): void {
    this.db.prepare('DELETE FROM publish_playlists WHERE collection_id = ?').run(collectionId);
  }

  startPublishRun(r: { id: string; startedAt: string; quotaDay: string; mode: 'dry-run' | 'apply'; catalogGeneratedAt?: string }): void {
    this.db
      .prepare('INSERT INTO publish_runs (id, started_at, quota_day, mode, catalog_generated_at) VALUES (?,?,?,?,?)')
      .run(r.id, r.startedAt, r.quotaDay, r.mode, r.catalogGeneratedAt ?? null);
  }

  /** Persisted before each request is sent, so crashed runs still count their attempted calls. */
  recordPublishCalls(runId: string, calls: Record<string, number>, units: number): void {
    this.db.prepare('UPDATE publish_runs SET calls_json = ?, units = ? WHERE id = ?').run(JSON.stringify(calls), units, runId);
  }

  finishPublishRun(runId: string, finishedAt: string, status: 'ok' | 'incomplete' | 'failed' | 'budget_limited', summary: unknown): void {
    this.db.prepare('UPDATE publish_runs SET finished_at = ?, status = ?, summary_json = ? WHERE id = ?').run(finishedAt, status, JSON.stringify(summary), runId);
  }

  /** Units attempted by all publisher runs on a Pacific-time quota day. */
  publishUnitsOn(quotaDay: string): number {
    return (this.db.prepare('SELECT COALESCE(SUM(units), 0) AS n FROM publish_runs WHERE quota_day = ?').get(quotaDay) as { n: number }).n;
  }
}

export interface VideoCheck {
  videoId: string;
  checkedAt: string;
  available: boolean;
  channelId?: string;
  title?: string;
  titleFingerprint?: string;
  screenReasons: string[];
}

export interface PublishPlaylist {
  collectionId: string;
  playlistId?: string;
  channelId: string;
  installId: string;
  /** creating: insert sent, outcome not yet confirmed. unresolved: lookup found nothing after an uncertain create. conflict: duplicate markers. */
  state: 'creating' | 'active' | 'unresolved' | 'conflict';
}
