import fs from 'node:fs';
import path from 'node:path';
import { CATALOG_SCHEMA_VERSION, CatalogSnapshot, type CatalogCollection, type CatalogExclusion, type CatalogItem } from '@sportscenter/contracts';
import { PRIORITY_RANK, trustedSources, type Collection, type CollectionsConfig, type Preferences, type Source } from './config.ts';
import type { RunStatus, SportEvent, Team } from './domain.ts';
import { followedNflTeams, isFollowed, neutralTitle } from './pipeline.ts';
import { revalidateVideos, type RevalidationResult } from './revalidate.ts';
import { SCREENING_VERSION } from './spoilers.ts';
import type { Store } from './store.ts';
import type { YouTubeClient } from './youtube/client.ts';

/** Sports with an adapter. Collections for other sports are rejected until their adapter exists. */
export const SUPPORTED_SPORTS = ['nfl'] as const;

const DAY_MS = 86_400_000;

export interface CatalogOptions {
  prefs: Preferences;
  sources: Source[];
  collections: CollectionsConfig;
  now: string;
  configRevision: string;
}

interface EventRow {
  event_id: string;
  sport: string;
  competition: string;
  week: number;
  start_time: string;
  home_json: string;
  away_json: string;
  discovery: string | null;
  video_id: string | null;
  source_id: string | null;
  duration_seconds: number | null;
  published_at: string | null;
  metadata_eligible: number | null;
}

interface Candidate {
  event: EventRow;
  home: Team;
  away: Team;
  priority: number;
  item?: CatalogItem;
  /** Why the event cannot appear in any collection. */
  reason?: string;
  /** The item's evidence is older than the maximum age and could not be refreshed. */
  stale: boolean;
}

/** Completed, followed events in the widest collection window, with their primary highlight (if any). */
function loadCandidates(store: Store, o: CatalogOptions): EventRow[] {
  const maxDays = Math.max(0, ...o.collections.collections.map((c) => c.windowDays));
  const since = new Date(Date.parse(o.now) - maxDays * DAY_MS).toISOString();
  return store.db
    .prepare(
      `SELECT e.id AS event_id, e.sport, e.competition, e.week, e.start_time, e.home_json, e.away_json, d.status AS discovery,
              h.video_id, h.source_id, c.duration_seconds, c.published_at, c.metadata_eligible
       FROM events e
       LEFT JOIN discovery d ON d.event_id = e.id
       LEFT JOIN highlights h ON h.event_id = e.id
       LEFT JOIN candidates c ON c.event_id = h.event_id AND c.video_id = h.video_id
       WHERE e.sport = 'nfl' AND e.status = 'COMPLETED' AND e.start_time >= ? AND e.start_time <= ?
       ORDER BY e.start_time, e.id`,
    )
    .all(since, o.now) as unknown as EventRow[];
}

/** Why a completed event has no primary highlight: discovery state, or a matched-but-ineligible candidate. */
function noHighlightReason(store: Store, row: EventRow): string {
  const reasons = (store.db.prepare("SELECT metadata_reasons_json FROM candidates WHERE event_id = ? AND confidence > 0").all(row.event_id) as { metadata_reasons_json: string }[]).flatMap(
    (r) => JSON.parse(r.metadata_reasons_json) as string[],
  );
  // Reported separately: the inherited embeddable rule may exclude videos SmartTube could play.
  if (reasons.includes('embedding_disabled')) return 'embedding_disabled';
  return `no_highlight:${row.discovery ?? 'NOT_TRACKED'}`;
}

function evaluate(store: Store, row: EventRow, o: CatalogOptions, trusted: Map<string, Source>, staleIds: Set<string>): Candidate {
  const home = JSON.parse(row.home_json) as Team;
  const away = JSON.parse(row.away_json) as Team;
  const nfl = o.prefs.sports.nfl;
  const priority = Math.max(-1, ...(nfl?.teams ?? []).filter((t) => t.abbr === home.abbr || t.abbr === away.abbr).map((t) => PRIORITY_RANK[t.priority]));
  const base = { event: row, home, away, priority, stale: false };
  const fail = (reason: string, stale = false): Candidate => ({ ...base, reason, stale });

  if (!row.video_id || !row.source_id || row.discovery !== 'FOUND' || row.metadata_eligible !== 1) return fail(noHighlightReason(store, row));
  if (row.duration_seconds === null || !row.published_at) return fail('duration_unknown');
  const source = trusted.get(row.source_id);
  if (!source) return fail('untrusted_source');

  const check = store.videoCheck(row.video_id);
  const stale = staleIds.has(row.video_id);
  if (!check) return fail('metadata_unchecked', true);
  if (!check.available) return fail('video_unavailable'); // confirmed removal, distinct from a failed refresh
  if (check.channelId !== source.channelId) return fail('channel_mismatch');
  if (check.screenReasons.length) return fail(check.screenReasons.includes('embedding_disabled') ? 'embedding_disabled' : `metadata:${check.screenReasons.join('+')}`);

  const screen = store.titleScreen(row.video_id);
  const current = screen && screen.titleFingerprint === check.titleFingerprint && screen.version === SCREENING_VERSION;
  const titleScreen = current ? screen.status : 'unreviewed';
  if (titleScreen === 'flagged' && !o.collections.publishing.includeFlaggedTitles) return fail(`title_flagged:${screen!.reasons.join('+')}`, stale);
  if (titleScreen === 'unreviewed' && !o.collections.publishing.includeUnreviewedTitles) return fail('title_unreviewed', stale);

  return {
    ...base,
    stale,
    item: {
      eventId: row.event_id,
      sport: row.sport,
      competition: row.competition,
      neutralTitle: neutralTitle({ home, away } as SportEvent),
      subtitle: `${row.competition} · Week ${row.week}`,
      eventStartTime: row.start_time,
      priority,
      video: { platform: 'youtube', videoId: row.video_id, durationSeconds: row.duration_seconds, publishedAt: new Date(row.published_at).toISOString() },
      source: { id: source.id, displayName: source.displayName, tier: source.tier },
      titleScreen,
    },
  };
}

const byStartAsc = (a: Candidate, b: Candidate) => a.event.start_time.localeCompare(b.event.start_time) || a.event.event_id.localeCompare(b.event.event_id);
const byStartDesc = (a: Candidate, b: Candidate) => b.event.start_time.localeCompare(a.event.start_time) || a.event.event_id.localeCompare(b.event.event_id);

function isMember(c: Candidate, col: Collection): boolean {
  if (col.kind === 'mixed') return true;
  if (c.event.sport !== col.sport) return false;
  return col.kind === 'sport' || c.home.abbr === col.team || c.away.abbr === col.team;
}

/**
 * Selection before ordering: filter by membership, window, trust and screening; choose capped membership
 * deterministically; only then sort the selection by display order (event start, oldest first).
 */
function buildCollection(col: Collection, all: Candidate[], o: CatalogOptions, inputIssues: string[], refreshError: string | undefined, storedHistoryFrom: string | null): CatalogCollection {
  const start = new Date(Date.parse(o.now) - col.windowDays * DAY_MS).toISOString();
  const members = all.filter((c) => c.event.start_time >= start && isMember(c, col));
  const exclusions: CatalogExclusion[] = members.filter((c) => !c.item).map((c) => ({ eventId: c.event.event_id, ...(c.event.video_id ? { videoId: c.event.video_id } : {}), reason: c.reason! }));
  const eligible = members.filter((c) => c.item);

  const selected: Candidate[] = [];
  if (col.kind === 'mixed') {
    const perSport = new Map<string, number>();
    const ranked = [...eligible].sort((a, b) => b.priority - a.priority || byStartDesc(a, b));
    for (const c of ranked) {
      const n = perSport.get(c.event.sport) ?? 0;
      const sportCap = col.perSportCaps[c.event.sport];
      if (selected.length >= col.cap || (sportCap !== undefined && n >= sportCap)) {
        exclusions.push({ eventId: c.event.event_id, videoId: c.item!.video.videoId, reason: 'over_cap' });
        continue;
      }
      perSport.set(c.event.sport, n + 1);
      selected.push(c);
    }
  } else {
    const newest = [...eligible].sort(byStartDesc);
    selected.push(...newest.slice(0, col.cap));
    for (const c of newest.slice(col.cap)) exclusions.push({ eventId: c.event.event_id, videoId: c.item!.video.videoId, reason: 'over_cap' });
  }
  selected.sort(byStartAsc);

  const issues = [...inputIssues];
  const staleCount = members.filter((c) => c.stale).length;
  if (staleCount) issues.push(`${staleCount} member video(s) have metadata older than ${o.collections.publishing.maxMetadataAgeHours}h that could not be refreshed (${refreshError ?? 'unknown error'})`);
  if (col.kind !== 'mixed' && !(SUPPORTED_SPORTS as readonly string[]).includes(col.sport)) issues.push(`no adapter for sport ${col.sport}`);

  return {
    id: col.id, title: col.title, kind: col.kind, publish: col.publish,
    status: issues.length ? 'incomplete' : 'complete', issues,
    window: { start, end: new Date(o.now).toISOString() },
    coverage: { storedHistoryFrom },
    items: selected.map((c) => c.item!),
    exclusions: exclusions.sort((a, b) => a.eventId.localeCompare(b.eventId)),
  };
}

/**
 * Build the catalog from stored state. `revalidation` reports which member videos could not be refreshed.
 * Discovery completeness is taken from the latest personal run per supported sport.
 */
export function buildCatalog(store: Store, o: CatalogOptions, revalidation: RevalidationResult = { refreshed: [], stale: [] }): CatalogSnapshot {
  const trusted = new Map(trustedSources(o.sources, 'nfl', 'NFL', o.prefs.region).map((s) => [s.id, s]));
  const followed = followedNflTeams(o.prefs);
  const rows = loadCandidates(store, o).filter((r) => isFollowed({ home: JSON.parse(r.home_json), away: JSON.parse(r.away_json) } as SportEvent, followed));
  const staleIds = new Set(revalidation.stale);
  const candidates = rows.map((r) => evaluate(store, r, o, trusted, staleIds));

  const latest = store.db
    .prepare("SELECT id, status, started_at FROM runs WHERE sport = 'nfl' AND cohort = 'personal' ORDER BY started_at DESC, id DESC LIMIT 1")
    .get() as { id: string; status: RunStatus | null; started_at: string } | undefined;
  const inputIssues: string[] = [];
  if (!latest) inputIssues.push('nfl: no personal discovery run recorded');
  else if (latest.status !== 'ok') inputIssues.push(`nfl: latest personal discovery run ${latest.id} is ${latest.status ?? 'unfinished'}`);
  const storedHistoryFrom = (store.db.prepare("SELECT MIN(start_time) AS t FROM events WHERE sport = 'nfl'").get() as { t: string | null }).t;

  return CatalogSnapshot.parse({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: o.now,
    region: o.prefs.region,
    configRevision: o.configRevision,
    sourceRuns: latest ? [{ sport: 'nfl', runId: latest.id, status: latest.status, startedAt: latest.started_at }] : [],
    titleOverrides: { includeFlaggedTitles: o.collections.publishing.includeFlaggedTitles, includeUnreviewedTitles: o.collections.publishing.includeUnreviewedTitles },
    collections: o.collections.collections.map((c) =>
      buildCollection(c, candidates, o, inputIssues, revalidation.error, storedHistoryFrom && new Date(storedHistoryFrom).toISOString()),
    ),
  });
}

/** Refresh stale metadata for every video the catalog could publish, then build the catalog. */
export async function generateCatalog(store: Store, youtube: YouTubeClient | undefined, o: CatalogOptions): Promise<{ catalog: CatalogSnapshot; revalidation: RevalidationResult }> {
  const followed = followedNflTeams(o.prefs);
  const videoIds = loadCandidates(store, o)
    .filter((r) => r.video_id && isFollowed({ home: JSON.parse(r.home_json), away: JSON.parse(r.away_json) } as SportEvent, followed))
    .map((r) => r.video_id!);
  const revalidation = await revalidateVideos(store, youtube, videoIds, {
    region: o.prefs.region, sportOf: () => 'nfl', now: o.now, maxAgeMs: o.collections.publishing.maxMetadataAgeHours * 3_600_000,
  });
  return { catalog: buildCatalog(store, o, revalidation), revalidation };
}

/** Validate, then atomically replace the catalog file. */
export function writeCatalog(file: string, catalog: CatalogSnapshot): void {
  const valid = CatalogSnapshot.parse(catalog);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
