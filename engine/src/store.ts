import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isNflEvent, type Cohort, type DiscoveryStatus, type RunIssue, type RunKind, type RunStatus, type SportEvent, type Window } from './domain.ts';

/** Raw `events` row (v3 schema). */
export interface EventRow {
  id: string;
  sport: string;
  competition: string;
  competition_id: string;
  provider: string;
  provider_event_id: string;
  season: number | null;
  stage: string | null;
  participants_json: string;
  meta_json: string;
  start_time: string;
  status: string;
  provider_status: string;
}

export function rowToEvent(r: EventRow): SportEvent {
  return {
    id: r.id, sport: r.sport, competition: r.competition, competitionId: r.competition_id, provider: r.provider, providerEventId: r.provider_event_id,
    season: r.season, startTime: r.start_time, status: r.status as SportEvent['status'], providerStatus: r.provider_status, stage: r.stage,
    participants: JSON.parse(r.participants_json), meta: JSON.parse(r.meta_json),
  };
}

export interface RankingSnapshot {
  /** Provider snapshot identity (e.g. ESPN season/week ref). */
  id: string;
  tour: string;
  providerUpdatedAt: string;
  fetchedAt: string;
  /** True only when the full ranking list was read. */
  complete: boolean;
  /** Provider athlete ID → rank. Absent athletes in a complete snapshot rank below its last entry. */
  ranks: Record<string, number>;
}

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

/**
 * v3: multi-sport events. Rebuilds `events` (SQLite's documented table-rebuild procedure; foreign keys are
 * disabled by migrate() and checked before commit) to add generic columns and make NFL-only columns nullable.
 * NFL rows keep their exact legacy values; participants, stage and meta are derived from them without
 * changing stable IDs. Non-NFL sports never get fabricated home/away teams or weeks.
 */
const SCHEMA_V3 = `
CREATE TABLE events_v3 (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  competition TEXT NOT NULL,
  competition_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  season INTEGER,
  -- Legacy NFL-only columns: exact values for NFL rows, NULL for other sports.
  season_type INTEGER,
  week INTEGER,
  home_json TEXT,
  away_json TEXT,
  stage TEXT,
  participants_json TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  start_time TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  -- Observation bounds for completion time. Never overwritten once set.
  last_observed_nonfinal_at TEXT,
  first_observed_final_at TEXT
);
INSERT INTO events_v3 (id, sport, competition, competition_id, provider, provider_event_id, season, season_type, week, home_json, away_json,
  stage, participants_json, meta_json, start_time, status, provider_status, first_seen_at, last_seen_at, last_observed_nonfinal_at, first_observed_final_at)
SELECT id, sport, competition, competition, provider, provider_event_id, season, season_type, week, home_json, away_json,
  'Week ' || week,
  json_array(
    json_object('id', json_extract(home_json, '$.abbr'), 'name', json_extract(home_json, '$.name'), 'shortName', json_extract(home_json, '$.shortName'), 'abbr', json_extract(home_json, '$.abbr'), 'role', 'home'),
    json_object('id', json_extract(away_json, '$.abbr'), 'name', json_extract(away_json, '$.name'), 'shortName', json_extract(away_json, '$.shortName'), 'abbr', json_extract(away_json, '$.abbr'), 'role', 'away')),
  json_object('seasonType', season_type, 'week', week),
  start_time, status, provider_status, first_seen_at, last_seen_at, last_observed_nonfinal_at, first_observed_final_at
FROM events;
DROP TABLE events;
ALTER TABLE events_v3 RENAME TO events;
CREATE INDEX events_sport_start ON events (sport, start_time);

-- Per-run eligibility reason (e.g. tennis ranking outcome), alongside the existing eligible flag.
ALTER TABLE run_events ADD COLUMN reason TEXT;

-- Ranking snapshots used for eligibility (tennis). ranks_json maps provider athlete ID → rank.
CREATE TABLE ranking_snapshots (
  id TEXT PRIMARY KEY,
  tour TEXT NOT NULL,
  provider_updated_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  complete INTEGER NOT NULL,
  ranks_json TEXT NOT NULL
);
`;

/** Sequential migrations: MIGRATIONS[i] upgrades user_version i → i+1. Append only; never edit a shipped entry. */
export const MIGRATIONS: readonly string[] = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3];

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
  // Table rebuilds require foreign keys off (it cannot change inside a transaction); each migration is
  // checked with foreign_key_check before it commits, so a violation rolls that migration back.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let v = from; v < migrations.length; v++) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(migrations[v]!);
        const fk = db.prepare('PRAGMA foreign_key_check').all();
        if (fk.length) throw new Error(`foreign_key_check: ${fk.length} violation(s)`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw new Error(`Migration to v${v + 1} failed and was rolled back: ${(err as Error).message}`);
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
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
    const nfl = isNflEvent(e) ? e : undefined; // legacy columns stay populated for NFL readers
    this.db
      .prepare(
        `INSERT INTO events (id, sport, competition, competition_id, provider, provider_event_id, season, season_type, week, home_json, away_json,
           stage, participants_json, meta_json, start_time, status, provider_status, first_seen_at, last_seen_at, last_observed_nonfinal_at, first_observed_final_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           competition = excluded.competition, competition_id = excluded.competition_id,
           season = excluded.season, season_type = excluded.season_type, week = excluded.week,
           home_json = excluded.home_json, away_json = excluded.away_json,
           stage = excluded.stage, participants_json = excluded.participants_json, meta_json = excluded.meta_json,
           start_time = excluded.start_time, status = excluded.status, provider_status = excluded.provider_status,
           last_seen_at = excluded.last_seen_at,
           last_observed_nonfinal_at = CASE
             WHEN events.first_observed_final_at IS NULL AND excluded.last_observed_nonfinal_at IS NOT NULL
             THEN excluded.last_observed_nonfinal_at ELSE events.last_observed_nonfinal_at END,
           first_observed_final_at = COALESCE(events.first_observed_final_at, excluded.first_observed_final_at)`,
      )
      .run(
        e.id, e.sport, e.competition, e.competitionId, e.provider, e.providerEventId, e.season,
        nfl?.seasonType ?? null, nfl?.week ?? null, nfl ? JSON.stringify(nfl.home) : null, nfl ? JSON.stringify(nfl.away) : null,
        e.stage, JSON.stringify(e.participants), JSON.stringify(e.meta), e.startTime, e.status, e.providerStatus, observedAt, observedAt,
        isFinal ? null : observedAt,
        // A backfill seeing an already-final game does not bound completion time; only prospective runs record it.
        isFinal && prospective ? observedAt : null,
      );
  }

  /** Load a stored event in its generic form (no legacy NFL fields). */
  event(id: string): SportEvent | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
    return r && rowToEvent(r);
  }

  recordRunEvent(runId: string, eventId: string, eligible: boolean, reason?: string): void {
    this.db.prepare('INSERT OR REPLACE INTO run_events (run_id, event_id, eligible, reason) VALUES (?,?,?,?)').run(runId, eventId, eligible ? 1 : 0, reason ?? null);
  }

  saveRankingSnapshot(s: RankingSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO ranking_snapshots (id, tour, provider_updated_at, fetched_at, complete, ranks_json) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, complete = excluded.complete, ranks_json = excluded.ranks_json`,
      )
      .run(s.id, s.tour, s.providerUpdatedAt, s.fetchedAt, s.complete ? 1 : 0, JSON.stringify(s.ranks));
  }

  /** Most recent complete snapshot for a tour (by provider update time), if any. */
  latestRankingSnapshot(tour: string): RankingSnapshot | undefined {
    const r = this.db
      .prepare('SELECT * FROM ranking_snapshots WHERE tour = ? AND complete = 1 ORDER BY provider_updated_at DESC, fetched_at DESC LIMIT 1')
      .get(tour) as { id: string; tour: string; provider_updated_at: string; fetched_at: string; complete: number; ranks_json: string } | undefined;
    return r && { id: r.id, tour: r.tour, providerUpdatedAt: r.provider_updated_at, fetchedAt: r.fetched_at, complete: r.complete === 1, ranks: JSON.parse(r.ranks_json) };
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

  /**
   * Deterministic primary among eligible candidates: preferred source first (`sourceRank`, lower wins), then
   * highest confidence, then the longer video (best content, e.g. an extended cut), then earliest publish, then ID.
   */
  selectPrimary(eventId: string, at: string, sourceRank: (sourceId: string) => number = () => 0): { videoId: string; sourceId: string } | undefined {
    const rows = this.db
      .prepare('SELECT video_id, source_id, confidence, duration_seconds, published_at FROM candidates WHERE event_id = ? AND metadata_eligible = 1')
      .all(eventId) as { video_id: string; source_id: string; confidence: number; duration_seconds: number | null; published_at: string }[];
    const best = rows.sort(
      (a, b) =>
        sourceRank(a.source_id) - sourceRank(b.source_id) || b.confidence - a.confidence || (b.duration_seconds ?? 0) - (a.duration_seconds ?? 0) ||
        a.published_at.localeCompare(b.published_at) || a.video_id.localeCompare(b.video_id),
    )[0];
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

  getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM engine_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO engine_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

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
