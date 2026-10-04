import fs from 'node:fs';
import path from 'node:path';
import { CATALOG_SCHEMA_VERSION, CatalogSnapshot, type CatalogCollection, type CatalogExclusion, type CatalogItem } from '@sportscenter/contracts';
import { ADAPTERS } from './adapters/index.ts';
import type { SportAdapter } from './adapters/types.ts';
import { describeKeep, STAGE_PLAYERS, trustedSources, type Collection, type CollectionsConfig, type Preferences, type Source } from './config.ts';
import type { RunStatus, SportEvent } from './domain.ts';
import { rescreenOutdated, revalidateVideos, type RevalidationResult } from './revalidate.ts';
import { SCREENING_VERSION } from './spoilers.ts';
import { rowToEvent, type EventRow, type Store } from './store.ts';
import type { YouTubeClient } from './youtube/client.ts';
import { blocksPlayback } from './youtube/screen.ts';

const DAY_MS = 86_400_000;

export interface CatalogOptions {
  prefs: Preferences;
  sources: Source[];
  collections: CollectionsConfig;
  now: string;
  configRevision: string;
}

interface Row extends EventRow {
  discovery: string | null;
  video_id: string | null;
  source_id: string | null;
  duration_seconds: number | null;
  published_at: string | null;
  metadata_eligible: number | null;
}

interface Candidate {
  event: SportEvent;
  videoId: string | null;
  priority: number;
  item?: CatalogItem;
  /** Why the event cannot appear in any collection. */
  reason?: string;
  /** The item's evidence is older than the maximum age and could not be refreshed. */
  stale: boolean;
}

/** Sports that have an adapter and are enabled in preferences. */
function activeAdapters(prefs: Preferences): SportAdapter[] {
  return ADAPTERS.filter((a) => (prefs.sports as Record<string, { enabled?: boolean } | undefined>)[a.sport]?.enabled);
}

/** How far back "last N" selections may reach (a season and a bit). */
const HISTORY_DAYS = 400;

/** Completed events within the history horizon, with their primary highlight (if any). */
function loadRows(store: Store, o: CatalogOptions): Row[] {
  const since = new Date(Date.parse(o.now) - HISTORY_DAYS * DAY_MS).toISOString();
  const sports = activeAdapters(o.prefs).map((a) => a.sport);
  if (!sports.length) return [];
  return store.db
    .prepare(
      `SELECT e.*, d.status AS discovery, h.video_id, h.source_id, c.duration_seconds, c.published_at, c.metadata_eligible
       FROM events e
       LEFT JOIN discovery d ON d.event_id = e.id
       LEFT JOIN highlights h ON h.event_id = e.id
       LEFT JOIN candidates c ON c.event_id = h.event_id AND c.video_id = h.video_id
       WHERE e.sport IN (${sports.map(() => '?').join(',')}) AND e.status = 'COMPLETED' AND e.start_time >= ? AND e.start_time <= ?
       ORDER BY e.start_time, e.id`,
    )
    .all(...sports, since, o.now) as unknown as Row[];
}

/** Followed events only: preferences are re-evaluated locally on every build. */
function followedRows(store: Store, o: CatalogOptions): { row: Row; event: SportEvent; adapter: SportAdapter; priority: number }[] {
  const adapters = new Map(ADAPTERS.map((a) => [a.sport, a]));
  return loadRows(store, o).flatMap((row) => {
    const adapter = adapters.get(row.sport)!;
    const event = rowToEvent(row);
    const d = adapter.follow(event, o.prefs);
    return d.followed ? [{ row, event, adapter, priority: d.priority }] : [];
  });
}

function evaluate(store: Store, f: ReturnType<typeof followedRows>[number], o: CatalogOptions, staleIds: Set<string>): Candidate {
  const { row, event, adapter, priority } = f;
  const base = { event, videoId: row.video_id, priority, stale: false };
  const fail = (reason: string, stale = false): Candidate => ({ ...base, reason, stale });

  if (!row.video_id || !row.source_id || row.discovery !== 'FOUND' || row.metadata_eligible !== 1) return fail(`no_highlight:${row.discovery ?? 'NOT_TRACKED'}`);
  if (row.duration_seconds === null || !row.published_at) return fail('duration_unknown');
  const source = trustedSources(o.sources, row.sport, adapter.sourceCompetition(event), o.prefs.region).find((s) => s.id === row.source_id);
  if (!source) return fail('untrusted_source');

  const check = store.videoCheck(row.video_id);
  // Evidence older than the maximum age is stale whether or not a refresh was attempted this run.
  const stale = staleIds.has(row.video_id) || (!!check && Date.parse(o.now) - Date.parse(check.checkedAt) > o.collections.publishing.maxMetadataAgeHours * 3_600_000);
  if (!check) return fail('metadata_unchecked', true);
  if (!check.available) return fail('video_unavailable'); // confirmed removal, distinct from a failed refresh
  if (check.channelId !== source.channelId) return fail('channel_mismatch');
  const blocking = check.screenReasons.filter(blocksPlayback); // SmartTube plays embedding-disabled videos
  if (blocking.length) return fail(`metadata:${blocking.join('+')}`);

  const screen = store.titleScreen(row.video_id);
  const current = screen && screen.titleFingerprint === check.titleFingerprint && screen.version === SCREENING_VERSION;
  const titleScreen = current ? screen.status : 'unreviewed';
  if (titleScreen === 'flagged' && !o.collections.publishing.includeFlaggedTitles) return fail(`title_flagged:${screen!.reasons.join('+')}`, stale);
  if (titleScreen === 'unreviewed' && !o.collections.publishing.includeUnreviewedTitles) return fail('title_unreviewed', stale);

  return {
    ...base,
    stale,
    item: {
      eventId: event.id,
      sport: event.sport,
      competition: event.competition,
      neutralTitle: adapter.neutralTitle(event),
      subtitle: adapter.subtitle(event),
      eventStartTime: event.startTime,
      priority,
      video: { platform: 'youtube', videoId: row.video_id, durationSeconds: row.duration_seconds, publishedAt: new Date(row.published_at).toISOString() },
      source: { id: source.id, displayName: source.displayName, tier: source.tier },
      titleScreen,
    },
  };
}

const byStartDesc = (a: Candidate, b: Candidate) => b.event.startTime.localeCompare(a.event.startTime) || a.event.id.localeCompare(b.event.id);
/** Display order (user decision 2026-10-03): newest YouTube upload first. */
const byUploadDesc = (a: Candidate, b: Candidate) => b.item!.video.publishedAt.localeCompare(a.item!.video.publishedAt) || a.event.id.localeCompare(b.event.id);

function isMember(c: Candidate, col: Collection): boolean {
  if (col.kind === 'mixed') return !col.excludeSports.includes(c.event.sport);
  if (c.event.sport !== col.sport) return false;
  return col.kind === 'sport' || c.event.participants.some((p) => p.id === col.team);
}

const sportsOf = (col: Collection, active: string[]) => (col.kind === 'mixed' ? active.filter((s) => !col.excludeSports.includes(s)) : [col.sport]);

/**
 * Apply the collection's keep rule to its members. Returns the selected candidates (eligible only, so a match
 * without a watchable highlight never takes a slot), the members the rule considered, and the time cutoff used.
 */
function applyKeep(col: Collection, members: Candidate[], o: CatalogOptions): { selected: Candidate[]; considered: Candidate[]; cutoff?: string } {
  const keep = col.keep;
  const newest = [...members].sort(byStartDesc);
  if ('days' in keep) {
    const cutoff = new Date(Date.parse(o.now) - keep.days * DAY_MS).toISOString();
    const considered = newest.filter((c) => c.event.startTime >= cutoff);
    return { selected: considered.filter((c) => c.item), considered, cutoff };
  }
  if ('last' in keep) {
    const selected = newest.filter((c) => c.item).slice(0, keep.last);
    const oldest = selected.at(-1)?.event.startTime;
    // Report gaps only among events recent enough to have been in the list.
    const considered = selected.length === keep.last ? newest.filter((c) => c.event.startTime >= oldest!) : newest;
    return { selected, considered };
  }
  // Tournaments in progress or finished within D days (by their latest followed match), from a stage onward.
  const t = keep.tournaments;
  const cutoff = new Date(Date.parse(o.now) - t.finishedWithinDays * DAY_MS).toISOString();
  const adapters = new Map(ADAPTERS.map((a) => [a.sport, a]));
  const info = new Map(members.map((c) => [c, adapters.get(c.event.sport)?.tournament?.(c.event)]));
  const latest = new Map<string, string>();
  for (const [c, i] of info) if (i && (latest.get(i.id) ?? '') < c.event.startTime) latest.set(i.id, c.event.startTime);
  const considered = newest.filter((c) => {
    const i = info.get(c);
    if (!i || latest.get(i.id)! < cutoff || i.playersLeft === undefined) return false;
    return i.playersLeft <= STAGE_PLAYERS[i.major ? t.majorsFromStage : t.fromStage];
  });
  return { selected: considered.filter((c) => c.item), considered, cutoff };
}

/** Select by the collection's keep rule, then order newest upload first. */
function buildCollection(
  col: Collection,
  all: Candidate[],
  o: CatalogOptions,
  sportIssues: Map<string, string[]>,
  active: string[],
  refreshError: string | undefined,
  historyFrom: (sports: string[]) => string | null,
): CatalogCollection {
  const members = all.filter((c) => isMember(c, col));
  const { selected, considered, cutoff } = applyKeep(col, members, o);
  const exclusions: CatalogExclusion[] = considered.filter((c) => !c.item).map((c) => ({ eventId: c.event.id, ...(c.videoId ? { videoId: c.videoId } : {}), reason: c.reason! }));
  selected.sort(byUploadDesc);

  const sports = sportsOf(col, active);
  const issues: string[] = [];
  if (col.kind !== 'mixed' && !active.includes(col.sport)) issues.push(`sport ${col.sport} has no adapter or is not enabled in preferences`);
  for (const s of sports) issues.push(...(sportIssues.get(s) ?? []));
  const staleCount = selected.filter((c) => c.stale).length;
  if (staleCount) issues.push(`${staleCount} selected video(s) have metadata older than ${o.collections.publishing.maxMetadataAgeHours}h that could not be refreshed (${refreshError ?? 'not refreshed'})`);
  const start = cutoff ?? selected.reduce((min, c) => (c.event.startTime < min ? c.event.startTime : min), new Date(o.now).toISOString());

  return {
    id: col.id, title: col.title, kind: col.kind, publish: col.publish, rule: describeKeep(col.keep),
    status: issues.length ? 'incomplete' : 'complete', issues,
    window: { start: new Date(start).toISOString(), end: new Date(o.now).toISOString() },
    coverage: { storedHistoryFrom: historyFrom(sports) },
    items: selected.map((c) => c.item!),
    exclusions: exclusions.sort((a, b) => a.eventId.localeCompare(b.eventId)),
  };
}

/**
 * Build the catalog from stored state. `revalidation` reports which member videos could not be refreshed.
 * Each sport's completeness comes from its latest personal discovery run, so one sport's failure only
 * marks the collections that contain that sport incomplete.
 */
export function buildCatalog(store: Store, o: CatalogOptions, revalidation: RevalidationResult = { refreshed: [], stale: [] }): CatalogSnapshot {
  const staleIds = new Set(revalidation.stale);
  const candidates = followedRows(store, o).map((f) => evaluate(store, f, o, staleIds));
  const active = activeAdapters(o.prefs).map((a) => a.sport);

  const sourceRuns: CatalogSnapshot['sourceRuns'] = [];
  const sportIssues = new Map<string, string[]>();
  for (const sport of active) {
    const latest = store.db
      .prepare("SELECT id, status, started_at FROM runs WHERE sport = ? AND cohort = 'personal' ORDER BY started_at DESC, id DESC LIMIT 1")
      .get(sport) as { id: string; status: RunStatus | null; started_at: string } | undefined;
    const issues: string[] = [];
    if (!latest) issues.push(`${sport}: no personal discovery run recorded`);
    else {
      sourceRuns.push({ sport, runId: latest.id, status: latest.status, startedAt: latest.started_at });
      if (latest.status !== 'ok') issues.push(`${sport}: latest personal discovery run ${latest.id} is ${latest.status ?? 'unfinished'}`);
      else if (Date.parse(o.now) - Date.parse(latest.started_at) > o.collections.publishing.maxDiscoveryAgeHours * 3_600_000) {
        issues.push(`${sport}: latest personal discovery run ${latest.id} is older than ${o.collections.publishing.maxDiscoveryAgeHours}h (discovery may not be running)`);
      }
    }
    sportIssues.set(sport, issues);
  }
  const historyFrom = (sports: string[]) => {
    if (!sports.length) return null;
    const t = (store.db.prepare(`SELECT MIN(start_time) AS t FROM events WHERE sport IN (${sports.map(() => '?').join(',')})`).get(...sports) as { t: string | null }).t;
    return t && new Date(t).toISOString();
  };

  return CatalogSnapshot.parse({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: o.now,
    region: o.prefs.region,
    configRevision: o.configRevision,
    sourceRuns,
    titleOverrides: { includeFlaggedTitles: o.collections.publishing.includeFlaggedTitles, includeUnreviewedTitles: o.collections.publishing.includeUnreviewedTitles },
    collections: o.collections.collections.map((c) => buildCollection(c, candidates, o, sportIssues, active, revalidation.error, historyFrom)),
  });
}

/**
 * Build, refresh metadata older than the maximum age for every selected video (batched), and rebuild until the
 * selection is stable: a confirmed removal frees a slot whose replacement may need its own refresh.
 */
export async function generateCatalog(store: Store, youtube: YouTubeClient | undefined, o: CatalogOptions): Promise<{ catalog: CatalogSnapshot; revalidation: RevalidationResult }> {
  const rows = followedRows(store, o).filter((f) => f.row.video_id);
  const sportOf = new Map(rows.map((f) => [f.row.video_id!, f.row.sport]));
  const sportFor = (id: string) => sportOf.get(id) ?? 'unknown';
  // Rules changes re-screen locally (no API call) so they never hide items while waiting for a refresh.
  store.tx(() => rescreenOutdated(store, [...sportOf.keys()], sportFor, o.now));
  const total: RevalidationResult = { refreshed: [], stale: [] };
  let catalog = buildCatalog(store, o, total);
  for (let pass = 0; pass < 3; pass++) {
    const selected = [...new Set(catalog.collections.flatMap((c) => c.items.map((i) => i.video.videoId)))];
    const r = await revalidateVideos(store, youtube, selected, {
      region: o.prefs.region, sportOf: sportFor, now: o.now, maxAgeMs: o.collections.publishing.maxMetadataAgeHours * 3_600_000,
    });
    total.refreshed.push(...r.refreshed);
    total.stale = r.stale;
    if (r.error) total.error = r.error;
    catalog = buildCatalog(store, o, total);
    if (!r.refreshed.length) break;
  }
  return { catalog, revalidation: total };
}

/** Validate, then atomically replace the catalog file. */
export function writeCatalog(file: string, catalog: CatalogSnapshot): void {
  const valid = CatalogSnapshot.parse(catalog);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
