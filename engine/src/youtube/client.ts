import { z } from 'zod';
import { getJson, HttpError, type Transport } from '../http.ts';

/**
 * YouTube Data API v3, documented paths only:
 * channels.list(contentDetails) → relatedPlaylists.uploads → paginated playlistItems.list → batched videos.list.
 * Every call costs 1 quota unit (documented 2026-10-02); the ledger counts calls per endpoint.
 */

const API = 'https://www.googleapis.com/youtube/v3/';

export class QuotaExceededError extends Error {}

export class QuotaLedger {
  readonly calls: Record<string, number> = {};
  record(endpoint: string): void {
    this.calls[endpoint] = (this.calls[endpoint] ?? 0) + 1;
  }
  /** Estimated units: 1 per call for the endpoints this engine uses. */
  get units(): number {
    return Object.values(this.calls).reduce((a, b) => a + b, 0);
  }
}

const ChannelsResponse = z.object({
  items: z
    .array(z.object({ id: z.string(), contentDetails: z.object({ relatedPlaylists: z.object({ uploads: z.string() }) }) }))
    .optional(),
});

const PlaylistItemsResponse = z.object({
  nextPageToken: z.string().optional(),
  items: z.array(
    z.object({
      snippet: z.object({ title: z.string(), channelId: z.string() }),
      contentDetails: z.object({ videoId: z.string(), videoPublishedAt: z.string().optional() }),
    }),
  ),
});

const VideosResponse = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({
        title: z.string(),
        channelId: z.string(),
        publishedAt: z.string(),
        liveBroadcastContent: z.string().optional(),
      }),
      contentDetails: z
        .object({
          duration: z.string().optional(),
          regionRestriction: z.object({ allowed: z.array(z.string()).optional(), blocked: z.array(z.string()).optional() }).optional(),
          contentRating: z.object({ ytRating: z.string().optional() }).passthrough().optional(),
        })
        .optional(),
      status: z
        .object({ embeddable: z.boolean().optional(), privacyStatus: z.string().optional(), uploadStatus: z.string().optional() })
        .optional(),
    }),
  ),
});

export type VideoMetadata = z.infer<typeof VideosResponse>['items'][number];

export interface UploadItem {
  videoId: string;
  title: string;
  channelId: string;
  publishedAt: string;
}

export interface UploadScan {
  playlistId: string;
  items: UploadItem[];
  pages: number;
  /** True only when the scan provably reached content older than `since` or the end of the playlist. */
  complete: boolean;
  stopReason: 'reached_window_start' | 'end_of_playlist' | 'page_limit' | 'error';
  error?: string;
}

export class YouTubeClient {
  constructor(
    private readonly transport: Transport,
    private readonly apiKey: string,
    readonly ledger = new QuotaLedger(),
  ) {}

  private async call(endpoint: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(endpoint, API);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('key', this.apiKey);
    this.ledger.record(endpoint);
    try {
      return await getJson(this.transport, url);
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        const reason = (err.body as { error?: { errors?: { reason?: string }[] } })?.error?.errors?.[0]?.reason;
        if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') throw new QuotaExceededError(`YouTube quota exceeded (${endpoint})`);
        throw new Error(`YouTube ${endpoint} forbidden: ${reason ?? 'unknown reason'}`);
      }
      throw err;
    }
  }

  async uploadsPlaylistId(channelId: string): Promise<string> {
    const res = ChannelsResponse.parse(await this.call('channels', { part: 'contentDetails', id: channelId }));
    const item = res.items?.find((i) => i.id === channelId);
    if (!item) throw new Error(`Channel ${channelId} not found`);
    return item.contentDetails.relatedPlaylists.uploads;
  }

  /**
   * Page through the uploads playlist until a full page is older than `since`.
   * Requiring a whole page (not one item) tolerates small ordering irregularities,
   * since playlist order is not a documented guarantee.
   */
  async scanUploads(playlistId: string, since: string, maxPages = 20): Promise<UploadScan> {
    const items: UploadItem[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    try {
      while (pages < maxPages) {
        const params: Record<string, string> = { part: 'snippet,contentDetails', playlistId, maxResults: '50' };
        if (pageToken) params.pageToken = pageToken;
        const page = PlaylistItemsResponse.parse(await this.call('playlistItems', params));
        pages++;
        let pageAllOlder = page.items.length > 0;
        for (const it of page.items) {
          const publishedAt = it.contentDetails.videoPublishedAt;
          // Missing publish time (e.g. private/deleted entries): keep scanning, never treat as old.
          if (!publishedAt || publishedAt >= since) pageAllOlder = false;
          if (publishedAt && publishedAt >= since) {
            items.push({ videoId: it.contentDetails.videoId, title: it.snippet.title, channelId: it.snippet.channelId, publishedAt });
          }
        }
        if (pageAllOlder) return { playlistId, items, pages, complete: true, stopReason: 'reached_window_start' };
        if (!page.nextPageToken) return { playlistId, items, pages, complete: true, stopReason: 'end_of_playlist' };
        pageToken = page.nextPageToken;
      }
      return { playlistId, items, pages, complete: false, stopReason: 'page_limit' };
    } catch (err) {
      if (err instanceof QuotaExceededError) throw err;
      return { playlistId, items, pages, complete: false, stopReason: 'error', error: (err as Error).message };
    }
  }

  /** Batched videos.list (50 per call). IDs absent from the response are unavailable (deleted/private). */
  async videos(ids: string[]): Promise<Map<string, VideoMetadata>> {
    const out = new Map<string, VideoMetadata>();
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const res = VideosResponse.parse(await this.call('videos', { part: 'snippet,contentDetails,status', id: batch.join(',') }));
      for (const v of res.items) out.set(v.id, v);
    }
    return out;
  }
}

/** ISO 8601 duration (PT#H#M#S, optional days) → seconds. Undefined when unparseable. */
export function parseIsoDuration(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return undefined;
  const [, d, h, min, s] = m.map((x) => Number(x ?? 0));
  return d! * 86400 + h! * 3600 + min! * 60 + s!;
}
