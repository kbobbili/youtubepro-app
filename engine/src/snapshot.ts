import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY_SCHEMA_VERSION, LibrarySnapshot } from '@sportscenter/contracts';
import { ADAPTERS } from './adapters/index.ts';
import { trustedSources, type Preferences, type Source } from './config.ts';
import { rowToEvent, type EventRow, type Store } from './store.ts';

interface Row extends EventRow {
  video_id: string;
  source_id: string;
  duration_seconds: number | null;
  published_at: string;
}

/**
 * Personalized library (v1 TV contract, shape unchanged): followed events with a trusted, matched,
 * metadata-eligible, embeddable primary highlight. Eligibility is recomputed from current preferences,
 * so diagnostic-only events never leak in. Query anchor is event start time (not a decision on the final Home window).
 */
export function buildSnapshot(store: Store, prefs: Preferences, sources: Source[], now: string, days = 7): LibrarySnapshot {
  const since = new Date(Date.parse(now) - days * 86_400_000).toISOString();
  const adapters = new Map(ADAPTERS.map((a) => [a.sport, a]));
  const rows = store.db
    .prepare(
      `SELECT e.*, h.video_id, h.source_id, c.duration_seconds, c.published_at
       FROM highlights h
       JOIN events e ON e.id = h.event_id
       JOIN discovery d ON d.event_id = h.event_id AND d.status = 'FOUND'
       JOIN candidates c ON c.event_id = h.event_id AND c.video_id = h.video_id AND c.metadata_eligible = 1
         -- The v1 TV contract means "embeddable": embed-only reasons no longer block eligibility, so filter them here.
         AND c.metadata_reasons_json NOT LIKE '%embedd%'
       WHERE e.start_time >= ? AND e.start_time <= ?
       ORDER BY e.start_time DESC, e.id`,
    )
    .all(since, now) as unknown as Row[];

  const items = rows.flatMap((r) => {
    const adapter = adapters.get(r.sport);
    if (!adapter || r.duration_seconds === null) return [];
    const event = rowToEvent(r);
    const source = trustedSources(sources, r.sport, adapter.sourceCompetition(event), prefs.region).find((s) => s.id === r.source_id);
    if (!source || !adapter.follow(event, prefs).followed) return [];
    return [
      {
        eventId: r.id,
        sport: r.sport,
        competition: r.competition,
        neutralTitle: adapter.neutralTitle(event),
        subtitle: adapter.subtitle(event),
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
