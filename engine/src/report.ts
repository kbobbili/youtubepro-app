import type { Cohort, RunKind } from './domain.ts';
import { adapterFor } from './adapters/index.ts';
import type { Store } from './store.ts';

export interface Report {
  sport: string;
  cohort: Cohort;
  kind: RunKind | 'all';
  runs: { total: number; ok: number; incomplete: number; failed: number; firstStartedAt?: string; lastStartedAt?: string; observationDays: number };
  /** Distinct completed events eligible in at least one run (each event counted once). */
  eligibleEvents: number;
  matched: number;
  metadataEligible: number;
  pending: number;
  unavailable: number;
  incompleteOnly: number;
  playback: { targetTvVerified: number; targetTvFailed: number; browserVerified: number };
  audits: { correct: number; wrong: number; unaudited: number };
  latency: {
    /** Publish time minus estimated end (start + the sport's estimated duration). An estimate, not measured completion. */
    medianMinutesAfterEstimatedEnd?: number;
    /** Events with a prospective non-final → final observation pair (bounded completion). */
    eventsWithObservedCompletionBounds: number;
    /** Discovery time minus publish time; limited by run cadence. */
    medianMinutesPublishToDiscovery?: number;
  };
  quotaUnits: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
};

export function buildReport(store: Store, cohort: Cohort, kind: RunKind | 'all' = 'all', sport = 'nfl'): Report {
  const adapter = adapterFor(sport);
  const kindClause = kind === 'all' ? '' : 'AND r.kind = ?';
  // Prospective coverage counts only games first observed before they ended; games already final when
  // observation began belong to the backfill baseline.
  const prospectiveClause = kind === 'prospective' ? 'AND e.last_observed_nonfinal_at IS NOT NULL' : '';
  const args: string[] = kind === 'all' ? [sport, cohort] : [sport, cohort, kind];

  const runs = store.db
    .prepare(`SELECT r.status, r.started_at, r.quota_json FROM runs r WHERE r.sport = ? AND r.cohort = ? ${kindClause} ORDER BY r.started_at`)
    .all(...args) as { status: string | null; started_at: string; quota_json: string }[];

  const events = store.db
    .prepare(
      `SELECT e.id, e.start_time, e.last_observed_nonfinal_at, e.first_observed_final_at, d.status AS discovery, d.found_at,
              h.video_id AS primary_video, c.published_at,
              (SELECT COUNT(*) FROM candidates x WHERE x.event_id = e.id AND x.confidence > 0) AS matched,
              (SELECT COUNT(*) FROM discovery_attempts a JOIN runs r2 ON r2.id = a.run_id
                 WHERE a.event_id = e.id AND a.scan_complete = 1 AND r2.cohort = ?) AS complete_attempts
       FROM events e
       LEFT JOIN discovery d ON d.event_id = e.id
       LEFT JOIN highlights h ON h.event_id = e.id
       LEFT JOIN candidates c ON c.event_id = h.event_id AND c.video_id = h.video_id
       WHERE e.status = 'COMPLETED' ${prospectiveClause} AND e.id IN (
         SELECT re.event_id FROM run_events re JOIN runs r ON r.id = re.run_id
         WHERE re.eligible = 1 AND r.sport = ? AND r.cohort = ? ${kindClause})`,
    )
    .all(cohort, ...args) as {
    id: string; start_time: string; last_observed_nonfinal_at: string | null; first_observed_final_at: string | null;
    discovery: string | null; found_at: string | null; primary_video: string | null; published_at: string | null;
    matched: number; complete_attempts: number;
  }[];

  const playback = { targetTvVerified: 0, targetTvFailed: 0, browserVerified: 0 };
  const audits = { correct: 0, wrong: 0, unaudited: 0 };
  const afterEnd: number[] = [];
  const toDiscovery: number[] = [];
  let bounded = 0;
  for (const e of events) {
    if (e.last_observed_nonfinal_at && e.first_observed_final_at) bounded++;
    if (!e.primary_video) continue;
    const tv = store.playbackStatus(e.primary_video, 'target-tv');
    if (tv === 'VERIFIED') playback.targetTvVerified++;
    if (tv === 'FAILED') playback.targetTvFailed++;
    if (store.playbackStatus(e.primary_video, 'browser') === 'VERIFIED') playback.browserVerified++;
    const audit = store.db.prepare('SELECT verdict FROM match_audits WHERE event_id = ? AND video_id = ?').get(e.id, e.primary_video) as { verdict: string } | undefined;
    if (audit?.verdict === 'correct') audits.correct++;
    else if (audit?.verdict === 'wrong') audits.wrong++;
    else audits.unaudited++;
    if (e.published_at) {
      const ev = store.event(e.id);
      afterEnd.push((Date.parse(e.published_at) - (Date.parse(e.start_time) + (ev ? adapter.estimatedDurationMs(ev) : 0))) / 60_000);
      // Only meaningful when the game was being watched before it ended.
      if (e.found_at && e.last_observed_nonfinal_at) toDiscovery.push((Date.parse(e.found_at) - Date.parse(e.published_at)) / 60_000);
    }
  }

  const quotaUnits = runs.reduce((sum, r) => sum + ((JSON.parse(r.quota_json) as { estimatedUnits?: number }).estimatedUnits ?? 0), 0);
  const days = new Set(runs.filter((r) => r.status !== 'failed').map((r) => r.started_at.slice(0, 10)));

  return {
    sport,
    cohort,
    kind,
    runs: {
      total: runs.length,
      ok: runs.filter((r) => r.status === 'ok').length,
      incomplete: runs.filter((r) => r.status === 'incomplete').length,
      failed: runs.filter((r) => r.status === 'failed' || r.status === null).length,
      firstStartedAt: runs[0]?.started_at,
      lastStartedAt: runs.at(-1)?.started_at,
      observationDays: days.size,
    },
    eligibleEvents: events.length,
    matched: events.filter((e) => e.matched > 0).length,
    metadataEligible: events.filter((e) => e.discovery === 'FOUND').length,
    pending: events.filter((e) => e.discovery === 'SEARCHING').length,
    unavailable: events.filter((e) => e.discovery === 'UNAVAILABLE').length,
    // UNAVAILABLE without attempts means no trusted source covers the competition: a known gap, not an incomplete scan.
    incompleteOnly: events.filter((e) => e.discovery !== 'FOUND' && e.discovery !== 'UNAVAILABLE' && e.complete_attempts === 0).length,
    playback,
    audits,
    latency: {
      medianMinutesAfterEstimatedEnd: median(afterEnd),
      eventsWithObservedCompletionBounds: bounded,
      medianMinutesPublishToDiscovery: median(toDiscovery),
    },
    quotaUnits,
  };
}
