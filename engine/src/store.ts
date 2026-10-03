import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Cohort, DiscoveryStatus, RunIssue, RunKind, RunStatus, SportEvent, Window } from './domain.ts';

const SCHEMA = `
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

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
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
}
