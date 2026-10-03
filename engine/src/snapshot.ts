import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY_SCHEMA_VERSION, LibrarySnapshot } from '@sportscenter/contracts';
import { trustedSources, type Preferences, type Source } from './config.ts';
import type { SportEvent, Team } from './domain.ts';
import { followedNflTeams, isFollowed, neutralTitle } from './pipeline.ts';
import type { Store } from './store.ts';

interface Row {
  event_id: string;
  competition: string;
  season: number;
  season_type: number;
  week: number;
  start_time: string;
  home_json: string;
  away_json: string;
  video_id: string;
  source_id: string;
  duration_seconds: number | null;
  published_at: string;
}

/**
 * Personalized library: followed events with a trusted, matched, metadata-eligible primary highlight.
 * Eligibility is recomputed from current preferences, so diagnostic-only events never leak in.
 * Query anchor for this spike is event start time (not a decision on the final Home window).
 */
export function buildSnapshot(store: Store, prefs: Preferences, sources: Source[], now: string, days = 7): LibrarySnapshot {
  const since = new Date(Date.parse(now) - days * 86_400_000).toISOString();
  const trusted = new Map(trustedSources(sources, 'nfl', 'NFL', prefs.region).map((s) => [s.id, s]));
  const followed = followedNflTeams(prefs);
  const rows = store.db
    .prepare(
      `SELECT e.id AS event_id, e.competition, e.season, e.season_type, e.week, e.start_time, e.home_json, e.away_json,
              h.video_id, h.source_id, c.duration_seconds, c.published_at
       FROM highlights h
       JOIN events e ON e.id = h.event_id
       JOIN discovery d ON d.event_id = h.event_id AND d.status = 'FOUND'
       JOIN candidates c ON c.event_id = h.event_id AND c.video_id = h.video_id AND c.metadata_eligible = 1
         -- The v1 TV contract means "embeddable": embed-only reasons no longer block eligibility, so filter them here.
         AND c.metadata_reasons_json NOT LIKE '%embedd%'
       WHERE e.sport = 'nfl' AND e.start_time >= ? AND e.start_time <= ?
       ORDER BY e.start_time DESC, e.id`,
    )
    .all(since, now) as unknown as Row[];

  const items = rows.flatMap((r) => {
    const source = trusted.get(r.source_id);
    const home = JSON.parse(r.home_json) as Team;
    const away = JSON.parse(r.away_json) as Team;
    const event = { home, away } as SportEvent;
    if (!source || !isFollowed(event, followed) || r.duration_seconds === null) return [];
    return [
      {
        eventId: r.event_id,
        sport: 'nfl',
        competition: r.competition,
        neutralTitle: neutralTitle(event),
        subtitle: `${r.competition} · Week ${r.week}`,
        eventStartTime: r.start_time,
        video: { platform: 'youtube' as const, videoId: r.video_id, durationSeconds: r.duration_seconds, publishedAt: new Date(r.published_at).toISOString() },
        source: { id: source.id, displayName: source.displayName, tier: source.tier },
        metadataEligible: true as const,
        targetDevicePlayback: store.playbackStatus(r.video_id, 'target-tv'),
      },
    ];
  });

  return LibrarySnapshot.parse({ schemaVersion: LIBRARY_SCHEMA_VERSION, generatedAt: now, region: prefs.region, items });
}

/** Validate, then atomically replace the snapshot file (write temp + rename). */
export function writeSnapshot(file: string, snapshot: LibrarySnapshot): void {
  const valid = LibrarySnapshot.parse(snapshot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
