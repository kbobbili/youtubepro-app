import type { VideoMetadata } from './client.ts';

/**
 * Metadata screening: can this video plausibly be embedded for a viewer in `region`?
 * Passing is NOT playback evidence; it only means the API reports nothing disqualifying.
 * Missing or unknown fields fail closed.
 */
export interface ScreenResult {
  eligible: boolean;
  reasons: string[];
}

/**
 * Reasons that only matter to an embedded player (the planned RN TV client). SmartTube plays these videos,
 * so discovery and the catalog ignore them (user decision 2026-10-03); the v1 library export still excludes them.
 */
export const EMBED_ONLY_REASONS: ReadonlySet<string> = new Set(['embedding_disabled', 'embeddable_unknown']);

export const blocksPlayback = (reason: string) => !EMBED_ONLY_REASONS.has(reason);

export function screenVideo(video: VideoMetadata | undefined, region: string): ScreenResult {
  if (!video) return { eligible: false, reasons: ['video_unavailable'] };
  const reasons: string[] = [];
  const status = video.status;
  if (!status) reasons.push('status_unknown');
  else {
    if (status.privacyStatus !== 'public') reasons.push(`not_public:${status.privacyStatus ?? 'unknown'}`);
    if (status.embeddable !== true) reasons.push(status.embeddable === false ? 'embedding_disabled' : 'embeddable_unknown');
    if (status.uploadStatus !== undefined && status.uploadStatus !== 'processed') reasons.push(`upload_status:${status.uploadStatus}`);
  }
  const rr = video.contentDetails?.regionRestriction;
  if (rr?.allowed !== undefined && !rr.allowed.includes(region)) reasons.push(`region_not_allowed:${region}`);
  if (rr?.blocked?.includes(region)) reasons.push(`region_blocked:${region}`);
  if (video.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted') reasons.push('age_restricted');
  const live = video.snippet.liveBroadcastContent;
  if (live !== undefined && live !== 'none') reasons.push(`live:${live}`);
  return { eligible: reasons.length === 0, reasons };
}
