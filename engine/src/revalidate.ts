import { screenTitle, titleFingerprint } from './spoilers.ts';
import type { Store } from './store.ts';
import type { VideoMetadata, YouTubeClient } from './youtube/client.ts';
import { screenVideo } from './youtube/screen.ts';

/**
 * Record the result of one successful videos.list lookup: a video check per requested ID (absent IDs are
 * confirmed unavailable) and a title screen whenever the title fingerprint or screening version changed.
 * Callers must only pass lookups that succeeded; a failed fetch is stale evidence, not a removal.
 */
export function recordMetadataChecks(store: Store, ids: string[], metadata: Map<string, VideoMetadata>, region: string, sportOf: (videoId: string) => string, at: string): void {
  for (const videoId of ids) {
    const meta = metadata.get(videoId);
    const title = meta?.snippet.title;
    const fingerprint = title === undefined ? undefined : titleFingerprint(title);
    store.recordVideoCheck({
      videoId, checkedAt: at, available: meta !== undefined, channelId: meta?.snippet.channelId, title, titleFingerprint: fingerprint,
      screenReasons: screenVideo(meta, region).reasons,
    });
    if (title === undefined || fingerprint === undefined) continue;
    const screen = screenTitle(title, sportOf(videoId));
    const prev = store.titleScreen(videoId);
    if (prev?.titleFingerprint === fingerprint && prev.version === screen.version) continue;
    store.recordTitleScreen({ videoId, titleFingerprint: fingerprint, version: screen.version, status: screen.status, reasons: screen.reasons, at });
  }
}

export interface RevalidationResult {
  /** IDs refreshed by this call. */
  refreshed: string[];
  /** IDs whose check is still older than the maximum age (fetch failed or quota exhausted). */
  stale: string[];
  error?: string;
}

/**
 * Refresh metadata for videos considered for publishing whose last check is older than `maxAgeMs`,
 * including videos outside the normal discovery window. Deduplicated and batched (50 per call).
 */
export async function revalidateVideos(
  store: Store,
  youtube: YouTubeClient | undefined,
  videoIds: string[],
  o: { region: string; sportOf: (videoId: string) => string; now: string; maxAgeMs: number },
): Promise<RevalidationResult> {
  const cutoff = Date.parse(o.now) - o.maxAgeMs;
  const due = [...new Set(videoIds)].filter((id) => {
    const c = store.videoCheck(id);
    return !c || Date.parse(c.checkedAt) < cutoff;
  });
  if (!due.length) return { refreshed: [], stale: [] };
  if (!youtube) return { refreshed: [], stale: due, error: 'offline: metadata refresh skipped' };
  try {
    const metadata = await youtube.videos(due);
    store.tx(() => recordMetadataChecks(store, due, metadata, o.region, o.sportOf, o.now));
    return { refreshed: due, stale: [] };
  } catch (err) {
    return { refreshed: [], stale: due, error: (err as Error).message };
  }
}
