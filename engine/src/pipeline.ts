import { fetchNflEvents } from './adapters/nfl/espn.ts';
import { ESTIMATED_GAME_DURATION_MS, matchNflCandidate, parseNflHighlightTitle } from './adapters/nfl/matcher.ts';
import { trustedSources, type Preferences, type Source } from './config.ts';
import type { Cohort, DiscoveryStatus, RunIssue, RunKind, RunStatus, SportEvent, Window } from './domain.ts';
import type { Transport } from './http.ts';
import type { Store } from './store.ts';
import { parseIsoDuration, QuotaExceededError, type UploadItem, type UploadScan, type VideoMetadata, YouTubeClient } from './youtube/client.ts';
import { screenVideo } from './youtube/screen.ts';

/** Initial hypothesis: stop normal discovery ~72h after estimated event end (docs/03). */
export const DISCOVERY_CUTOFF_MS = 72 * 3_600_000;

export interface DiscoverOptions {
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
  status: RunStatus;
  issues: RunIssue[];
  window: Window;
  scans: (Pick<UploadScan, 'pages' | 'complete' | 'stopReason' | 'error'> & { sourceId: string; since: string; items: number })[];
  outcomes: EventOutcome[];
  quota: { calls: Record<string, number>; estimatedUnits: number };
}

export function followedNflTeams(prefs: Preferences): Set<string> {
  const nfl = prefs.sports.nfl;
  return new Set(nfl?.enabled ? nfl.teams.map((t) => t.abbr) : []);
}

export function isFollowed(event: SportEvent, followed: Set<string>): boolean {
  return followed.has(event.home.abbr) || followed.has(event.away.abbr);
}

/** Spoiler-free label generated from event data, never from publisher metadata. */
export function neutralTitle(event: SportEvent): string {
  return `${event.away.name} at ${event.home.name}`;
}

export async function discoverNfl(o: DiscoverOptions): Promise<DiscoverResult> {
  const { store, youtube, window, cohort } = o;
  const issues: RunIssue[] = [];
  const startedAt = o.now();
  const followed = followedNflTeams(o.prefs);

  store.startRun({
    id: o.runId, sport: 'nfl', cohort, kind: o.kind, startedAt, window,
    config: { region: o.prefs.region, followed: [...followed].sort(), cutoffHours: DISCOVERY_CUTOFF_MS / 3_600_000 },
  });

  // 1. What happened?
  const fetched = await fetchNflEvents(o.eventsTransport, window);
  for (const msg of fetched.issues) issues.push({ stage: 'events', message: msg });

  // 2. Do I care? Diagnostic runs consider every game but never change preferences.
  const tracked = fetched.events.filter((e) => e.status !== 'POSTPONED' && e.status !== 'CANCELLED' && (cohort === 'diagnostic' || isFollowed(e, followed)));
  store.tx(() => {
    for (const e of fetched.events) {
      store.upsertEvent(e, startedAt, o.kind === 'prospective');
      store.recordRunEvent(o.runId, e.id, tracked.includes(e));
    }
    for (const e of tracked) if (e.status !== 'COMPLETED') store.setDiscovery(e.id, 'WAITING_FOR_EVENT_END', startedAt);
  });
  const completed = tracked.filter((e) => e.status === 'COMPLETED');

  // 3. Where is the trusted highlight?
  const scans: DiscoverResult['scans'] = [];
  const scanByEvent = new Map<string, boolean>();
  const pairs: { event: SportEvent; item: UploadItem; source: Source }[] = [];
  const sources = trustedSources(o.sources, 'nfl', 'NFL', o.prefs.region);
  if (completed.length && !sources.length) issues.push({ stage: 'sources', message: 'No enabled, verified NFL source for region' });

  let quotaExhausted = false;
  if (completed.length) {
    const since = completed.reduce((min, e) => (e.startTime < min ? e.startTime : min), completed[0]!.startTime);
    for (const source of sources) {
      let scan: UploadScan;
      try {
        const playlistId = await youtube.uploadsPlaylistId(source.channelId);
        scan = await youtube.scanUploads(playlistId, since);
      } catch (err) {
        quotaExhausted ||= err instanceof QuotaExceededError;
        scan = { playlistId: '?', items: [], pages: 0, complete: false, stopReason: 'error', error: (err as Error).message };
      }
      if (!scan.complete) issues.push({ stage: 'youtube', message: `${source.id}: uploads scan incomplete (${scan.stopReason}${scan.error ? `: ${scan.error}` : ''})` });
      scans.push({ sourceId: source.id, since, pages: scan.pages, complete: scan.complete, stopReason: scan.stopReason, error: scan.error, items: scan.items.length });
      for (const e of completed) scanByEvent.set(e.id, (scanByEvent.get(e.id) ?? true) && scan.complete);

      for (const item of scan.items) {
        const parsed = parseNflHighlightTitle(item.title);
        if (!parsed.ok) continue;
        const teams = new Set([parsed.value.first, parsed.value.second]);
        for (const e of completed) if (teams.has(e.home.abbr) && teams.has(e.away.abbr)) pairs.push({ event: e, item, source });
      }
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
      issues.push({ stage: 'youtube', message: `videos.list failed: ${(err as Error).message}` });
    }
  } else if (ids.length) metadataOk = false;

  // 4. Match, screen, persist, and advance discovery state.
  const now = o.now();
  const outcomes: EventOutcome[] = [];
  store.tx(() => {
    for (const e of tracked) {
      if (e.status !== 'COMPLETED') {
        outcomes.push({ event: e, discovery: 'WAITING_FOR_EVENT_END', matchedCandidates: 0, ineligibleReasons: [], scanComplete: true });
        continue;
      }
      const scanComplete = (scanByEvent.get(e.id) ?? false) && metadataOk && sources.length > 0;
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
        const parsed = parseNflHighlightTitle(meta?.snippet.title ?? cand.title);
        if (!parsed.ok) continue;
        const durationSeconds = parseIsoDuration(meta?.contentDetails?.duration);
        const match = matchNflCandidate(e, parsed.value, { videoId: cand.videoId, title: cand.title, publishedAt: cand.publishedAt, durationSeconds });
        const screen = screenVideo(meta, o.prefs.region);
        const reasons = [...screen.reasons];
        // Trust is re-checked per video: the channel must be the registered one.
        if (meta && meta.snippet.channelId !== cand.source.channelId) reasons.push('channel_mismatch');
        if (!match.matched) reasons.push(`no_match:${match.rejectionReason}`);
        const eligible = match.matched && reasons.length === 0;
        if (match.matched) matchedCount++;
        if (match.matched && !eligible) reasons.forEach((r) => ineligible.add(r));
        store.upsertCandidate(
          {
            eventId: e.id, videoId: cand.videoId, sourceId: cand.source.id, channelId: meta?.snippet.channelId ?? cand.source.channelId,
            rawTitle: meta?.snippet.title ?? cand.title, publishedAt: meta?.snippet.publishedAt ?? cand.publishedAt,
            durationSeconds: durationSeconds ?? null, confidence: match.confidence, flags: match.flags,
            metadataEligible: eligible, metadataReasons: reasons,
          },
          now,
        );
      }

      const previous = store.getDiscovery(e.id)?.status;
      let status: DiscoveryStatus;
      const primary = metadataOk ? store.selectPrimary(e.id, now) : undefined;
      if (primary) status = 'FOUND';
      else if (!scanComplete) status = previous && previous !== 'WAITING_FOR_EVENT_END' ? previous : 'SEARCHING'; // incomplete ≠ missing
      else if (Date.parse(now) > Date.parse(e.startTime) + ESTIMATED_GAME_DURATION_MS + DISCOVERY_CUTOFF_MS) status = 'UNAVAILABLE';
      else status = 'SEARCHING';
      store.setDiscovery(e.id, status, now);

      for (const source of sources) {
        store.recordAttempt({
          runId: o.runId, eventId: e.id, sourceId: source.id, at: now, method: 'uploads_playlist', scanComplete,
          outcome: primary ? 'found' : matchedCount ? 'matched_not_eligible' : scanComplete ? 'not_found' : 'incomplete',
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
        event: e, discovery: status, matchedCandidates: matchedCount, ineligibleReasons: [...ineligible], scanComplete,
        primary: row && { videoId: row.video_id, confidence: row.confidence, durationSeconds: row.duration_seconds, publishedAt: row.published_at, flags: JSON.parse(row.match_flags_json) },
      });
    }
  });

  const status: RunStatus = !fetched.complete && fetched.events.length === 0 ? 'failed' : issues.length ? 'incomplete' : 'ok';
  const quota = { calls: { ...youtube.ledger.calls, espnScoreboard: fetched.requests }, estimatedUnits: youtube.ledger.units };
  store.finishRun(o.runId, o.now(), status, issues, quota);
  return { runId: o.runId, status, issues, window, scans, outcomes, quota };
}
