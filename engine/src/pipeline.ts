import type { SportAdapter } from './adapters/types.ts';
import { trustedSources, type Preferences, type Source } from './config.ts';
import type { Cohort, DiscoveryStatus, RunIssue, RunKind, RunStatus, SportEvent, Window } from './domain.ts';
import type { Transport } from './http.ts';
import { markQuotaExhausted } from './quota.ts';
import { recordMetadataChecks } from './revalidate.ts';
import type { Store } from './store.ts';
import { parseIsoDuration, QuotaExceededError, type UploadItem, type UploadScan, type VideoMetadata, YouTubeClient } from './youtube/client.ts';
import { blocksPlayback, screenVideo } from './youtube/screen.ts';

/** Initial hypothesis: stop normal discovery ~72h after estimated event end (docs/03). */
export const DISCOVERY_CUTOFF_MS = 72 * 3_600_000;

export interface DiscoverOptions {
  adapter: SportAdapter;
  store: Store;
  eventsTransport: Transport;
  youtube: YouTubeClient;
  sources: Source[];
  prefs: Preferences;
  window: Window;
  cohort: Cohort;
  kind: RunKind;
  runId: string;
  now: () => string;
  /** Uploads-scan page limit; backfills reaching weeks back on busy channels need more than the hourly default. */
  maxScanPages?: number;
}

export interface EventOutcome {
  event: SportEvent;
  discovery: DiscoveryStatus | 'NOT_TRACKED';
  primary?: { videoId: string; confidence: number; durationSeconds: number | null; publishedAt: string; flags: string[] };
  matchedCandidates: number;
  ineligibleReasons: string[];
  scanComplete: boolean;
}

export interface DiscoverResult {
  runId: string;
  sport: string;
  status: RunStatus;
  issues: RunIssue[];
  /** Informational (e.g. cached rankings used); does not affect status. */
  notes: string[];
  window: Window;
  scans: (Pick<UploadScan, 'pages' | 'complete' | 'stopReason' | 'error'> & { sourceId: string; since: string; items: number })[];
  outcomes: EventOutcome[];
  quota: { calls: Record<string, number>; estimatedUnits: number };
}

interface Pair {
  event: SportEvent;
  item: UploadItem;
  source: Source;
  parsed: unknown;
}

/**
 * One discovery run for one sport: events → preferences → per-event trusted sources → one uploads scan per
 * source → match, screen, persist. Sports run independently so one sport's failure never blocks another.
 */
export async function discover(o: DiscoverOptions): Promise<DiscoverResult> {
  const { adapter, store, youtube, window, cohort } = o;
  const sport = adapter.sport;
  const issues: RunIssue[] = [];
  const startedAt = o.now();

  store.startRun({
    id: o.runId, sport, cohort, kind: o.kind, startedAt, window,
    config: { region: o.prefs.region, prefs: o.prefs.sports[sport as keyof Preferences['sports']] ?? null, cutoffHours: DISCOVERY_CUTOFF_MS / 3_600_000 },
  });

  // 1. What happened?
  const fetched = await adapter.fetchEvents({ transport: o.eventsTransport, window, prefs: o.prefs, store, now: startedAt });
  for (const msg of fetched.issues) issues.push({ stage: 'events', message: msg });

  // 2. Do I care? Diagnostic runs consider every event but never change preferences.
  const decisions = new Map(fetched.events.map((e) => [e.id, adapter.follow(e, o.prefs)]));
  const playable = (e: SportEvent) => e.status !== 'POSTPONED' && e.status !== 'CANCELLED';
  const tracked = fetched.events.filter((e) => playable(e) && (cohort === 'diagnostic' || decisions.get(e.id)!.followed));
  const unknown = fetched.events.filter((e) => playable(e) && decisions.get(e.id)!.unknown);
  if (unknown.length) issues.push({ stage: 'eligibility', message: `${unknown.length} event(s) with unknown eligibility (${decisions.get(unknown[0]!.id)!.reason ?? 'unknown'})` });
  store.tx(() => {
    for (const e of fetched.events) {
      store.upsertEvent(e, startedAt, o.kind === 'prospective');
      const d = decisions.get(e.id)!;
      store.recordRunEvent(o.runId, e.id, tracked.includes(e), d.reason ?? (d.unknown ? 'eligibility_unknown' : undefined));
    }
    for (const e of tracked) if (e.status !== 'COMPLETED') store.setDiscovery(e.id, 'WAITING_FOR_EVENT_END', startedAt);
  });
  const completed = tracked.filter((e) => e.status === 'COMPLETED');

  // 3. Where is the trusted highlight? Sources resolve per event (competition and region).
  const sourcesFor = new Map(completed.map((e) => [e.id, trustedSources(o.sources, sport, adapter.sourceCompetition(e), o.prefs.region)]));
  const anySource = o.sources.some((s) => s.sport === sport && s.enabled && s.verification.status === 'verified' && s.regions.includes(o.prefs.region));
  if (completed.length && !anySource) issues.push({ stage: 'sources', message: `No enabled, verified ${sport} source for region` });

  const usedSources = new Map<string, Source>();
  for (const list of sourcesFor.values()) for (const s of list) usedSources.set(s.id, s);
  const scans: DiscoverResult['scans'] = [];
  const scanComplete = new Map<string, boolean>();
  const pairs: Pair[] = [];
  let quotaExhausted = false;
  for (const source of usedSources.values()) {
    const events = completed.filter((e) => sourcesFor.get(e.id)!.some((s) => s.id === source.id));
    const since = events.reduce((min, e) => (e.startTime < min ? e.startTime : min), events[0]!.startTime);
    let scan: UploadScan;
    try {
      if (quotaExhausted) throw new QuotaExceededError('YouTube quota exceeded earlier in this run');
      scan = await youtube.scanUploads(await youtube.uploadsPlaylistId(source.channelId), since, o.maxScanPages);
    } catch (err) {
      quotaExhausted ||= err instanceof QuotaExceededError;
      scan = { playlistId: '?', items: [], pages: 0, complete: false, stopReason: 'error', error: (err as Error).message };
    }
    if (!scan.complete) issues.push({ stage: 'youtube', message: `${source.id}: uploads scan incomplete (${scan.stopReason}${scan.error ? `: ${scan.error}` : ''})` });
    scans.push({ sourceId: source.id, since, pages: scan.pages, complete: scan.complete, stopReason: scan.stopReason, error: scan.error, items: scan.items.length });
    for (const e of events) scanComplete.set(e.id, (scanComplete.get(e.id) ?? true) && scan.complete);
    for (const item of scan.items) {
      const parsed = adapter.parseTitle(item.title);
      if (parsed === undefined) continue;
      for (const e of events) if (adapter.related(e, parsed)) pairs.push({ event: e, item, source, parsed });
    }
  }

  // Metadata for new pairs plus previously stored candidates (re-screen so removed videos drop out).
  const existing = completed.length
    ? (store.db
        .prepare(`SELECT event_id, video_id, source_id, raw_title, published_at FROM candidates WHERE event_id IN (${completed.map(() => '?').join(',')})`)
        .all(...completed.map((e) => e.id)) as { event_id: string; video_id: string; source_id: string; raw_title: string; published_at: string }[])
    : [];
  const ids = [...new Set([...pairs.map((p) => p.item.videoId), ...existing.map((c) => c.video_id)])];
  let metadata = new Map<string, VideoMetadata>();
  let metadataOk = true;
  if (ids.length && !quotaExhausted) {
    try {
      metadata = await youtube.videos(ids);
    } catch (err) {
      metadataOk = false;
      quotaExhausted ||= err instanceof QuotaExceededError;
      issues.push({ stage: 'youtube', message: `videos.list failed: ${(err as Error).message}` });
    }
  } else if (ids.length) metadataOk = false;
  if (quotaExhausted) markQuotaExhausted(store, o.now(), `discover:${sport}`);

  // 4. Match, screen, persist, and advance discovery state.
  const now = o.now();
  // Preferred sources first (lower tier), e.g. Tennis TV before ATP Tour, a home board before Willow.
  const sourceRank = (sourceId: string) => o.sources.find((s) => s.id === sourceId)?.tier ?? 9;
  const outcomes: EventOutcome[] = [];
  store.tx(() => {
    // Every looked-up candidate gets a metadata check and title screen, so 'unreviewed' exists only transiently.
    if (metadataOk && ids.length) recordMetadataChecks(store, ids, metadata, o.prefs.region, () => sport, now);
    for (const e of tracked) {
      if (e.status !== 'COMPLETED') {
        outcomes.push({ event: e, discovery: 'WAITING_FOR_EVENT_END', matchedCandidates: 0, ineligibleReasons: [], scanComplete: true });
        continue;
      }
      const eventSources = sourcesFor.get(e.id)!;
      // No trusted source for this competition is a known gap ("highlight unavailable"), not an incomplete scan.
      const noSourceForCompetition = anySource && eventSources.length === 0;
      const complete = noSourceForCompetition || ((scanComplete.get(e.id) ?? false) && metadataOk && eventSources.length > 0);
      const eventPairs = pairs.filter((p) => p.event.id === e.id);
      const seen = new Set(eventPairs.map((p) => p.item.videoId));
      const toEvaluate = [
        ...eventPairs.map((p) => ({ videoId: p.item.videoId, title: p.item.title, publishedAt: p.item.publishedAt, source: p.source })),
        ...existing
          .filter((c) => c.event_id === e.id && !seen.has(c.video_id))
          .flatMap((c) => {
            const source = o.sources.find((s) => s.id === c.source_id);
            return source ? [{ videoId: c.video_id, title: c.raw_title, publishedAt: c.published_at, source }] : [];
          }),
      ];

      let matchedCount = 0;
      const ineligible = new Set<string>();
      for (const cand of toEvaluate) {
        if (!metadataOk) break; // Without metadata we cannot screen; keep prior state.
        const meta = metadata.get(cand.videoId);
        const title = meta?.snippet.title ?? cand.title;
        const parsed = adapter.parseTitle(title);
        if (parsed === undefined) continue;
        const durationSeconds = parseIsoDuration(meta?.contentDetails?.duration);
        const match = adapter.match(e, parsed, { videoId: cand.videoId, title: cand.title, publishedAt: cand.publishedAt, durationSeconds });
        const reasons = [...screenVideo(meta, o.prefs.region).reasons];
        // Trust is re-checked per video: the channel must be the registered one.
        if (meta && meta.snippet.channelId !== cand.source.channelId) reasons.push('channel_mismatch');
        if (!match.matched) reasons.push(`no_match:${match.rejectionReason}`);
        // Embed-only reasons stay recorded (the library export filters on them) but do not block SmartTube playback.
        const eligible = match.matched && !reasons.some(blocksPlayback);
        if (match.matched) matchedCount++;
        if (match.matched && !eligible) reasons.filter(blocksPlayback).forEach((r) => ineligible.add(r));
        store.upsertCandidate(
          {
            eventId: e.id, videoId: cand.videoId, sourceId: cand.source.id, channelId: meta?.snippet.channelId ?? cand.source.channelId,
            rawTitle: title, publishedAt: meta?.snippet.publishedAt ?? cand.publishedAt,
            durationSeconds: durationSeconds ?? null, confidence: match.confidence, flags: match.flags,
            metadataEligible: eligible, metadataReasons: reasons,
          },
          now,
        );
      }

      const previous = store.getDiscovery(e.id)?.status;
      let status: DiscoveryStatus;
      const primary = metadataOk ? store.selectPrimary(e.id, now, sourceRank) : undefined;
      if (primary) status = 'FOUND';
      else if (noSourceForCompetition) {
        status = 'UNAVAILABLE';
        ineligible.add(`no_trusted_source:${[adapter.sourceCompetition(e)].flat()[0]}`);
      } else if (!complete) status = previous && previous !== 'WAITING_FOR_EVENT_END' ? previous : 'SEARCHING'; // incomplete ≠ missing
      else if (Date.parse(now) > Date.parse(e.startTime) + adapter.estimatedDurationMs(e) + DISCOVERY_CUTOFF_MS) status = 'UNAVAILABLE';
      else status = 'SEARCHING';
      store.setDiscovery(e.id, status, now);

      for (const source of eventSources) {
        store.recordAttempt({
          runId: o.runId, eventId: e.id, sourceId: source.id, at: now, method: 'uploads_playlist', scanComplete: complete,
          outcome: primary ? 'found' : matchedCount ? 'matched_not_eligible' : complete ? 'not_found' : 'incomplete',
          diagnostics: { matchedCandidates: matchedCount, ineligibleReasons: [...ineligible] },
        });
      }

      const row = store.db
        .prepare(
          `SELECT c.video_id, c.confidence, c.duration_seconds, c.published_at, c.match_flags_json FROM highlights h
           JOIN candidates c ON c.event_id = h.event_id AND c.video_id = h.video_id WHERE h.event_id = ?`,
        )
        .get(e.id) as { video_id: string; confidence: number; duration_seconds: number | null; published_at: string; match_flags_json: string } | undefined;
      outcomes.push({
        event: e, discovery: status, matchedCandidates: matchedCount, ineligibleReasons: [...ineligible], scanComplete: complete,
        primary: row && { videoId: row.video_id, confidence: row.confidence, durationSeconds: row.duration_seconds, publishedAt: row.published_at, flags: JSON.parse(row.match_flags_json) },
      });
    }
  });

  const status: RunStatus = !fetched.complete && fetched.events.length === 0 ? 'failed' : issues.length ? 'incomplete' : 'ok';
  const quota = { calls: { ...youtube.ledger.calls, espn: fetched.requests }, estimatedUnits: youtube.ledger.units };
  store.finishRun(o.runId, o.now(), status, issues, quota);
  return { runId: o.runId, sport, status, issues, notes: fetched.notes ?? [], window, scans, outcomes, quota };
}
