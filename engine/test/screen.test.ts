import { describe, expect, it } from 'vitest';
import type { VideoMetadata } from '../src/youtube/client.ts';
import { screenVideo } from '../src/youtube/screen.ts';

const video = (over: { contentDetails?: VideoMetadata['contentDetails']; status?: VideoMetadata['status']; live?: string } = {}): VideoMetadata => ({
  id: 'abc',
  snippet: { title: 't', channelId: 'UCDVYQ4Zhbm3S2dlz7P1GBDg', publishedAt: '2026-09-27T20:35:35Z', liveBroadcastContent: over.live ?? 'none' },
  contentDetails: over.contentDetails ?? { duration: 'PT15M19S', contentRating: {} },
  status: 'status' in over ? over.status : { embeddable: true, privacyStatus: 'public', uploadStatus: 'processed' },
});

describe('screenVideo (metadata only, never playback proof)', () => {
  it('passes a public, embeddable, unrestricted video', () => {
    expect(screenVideo(video(), 'US')).toEqual({ eligible: true, reasons: [] });
  });

  it.each([
    ['missing video', undefined, ['video_unavailable']],
    ['embedding disabled', video({ status: { embeddable: false, privacyStatus: 'public' } }), ['embedding_disabled']],
    ['embeddable unknown', video({ status: { privacyStatus: 'public' } }), ['embeddable_unknown']],
    ['status unknown', video({ status: undefined }), ['status_unknown']],
    ['private', video({ status: { embeddable: true, privacyStatus: 'private' } }), ['not_public:private']],
    ['allowed list without US', video({ contentDetails: { regionRestriction: { allowed: ['GB', 'CA'] } } }), ['region_not_allowed:US']],
    ['empty allowed list (blocked everywhere)', video({ contentDetails: { regionRestriction: { allowed: [] } } }), ['region_not_allowed:US']],
    ['blocked in US', video({ contentDetails: { regionRestriction: { blocked: ['US'] } } }), ['region_blocked:US']],
    ['age restricted', video({ contentDetails: { contentRating: { ytRating: 'ytAgeRestricted' } } }), ['age_restricted']],
    ['live broadcast', video({ live: 'live' }), ['live:live']],
    ['upcoming broadcast', video({ live: 'upcoming' }), ['live:upcoming']],
  ])('fails closed: %s', (_label, v, reasons) => {
    expect(screenVideo(v as VideoMetadata | undefined, 'US')).toEqual({ eligible: false, reasons });
  });

  it('passes allowed lists containing US and blocked lists without it (including empty)', () => {
    expect(screenVideo(video({ contentDetails: { regionRestriction: { allowed: ['US'] } } }), 'US').eligible).toBe(true);
    expect(screenVideo(video({ contentDetails: { regionRestriction: { blocked: [] } } }), 'US').eligible).toBe(true);
    expect(screenVideo(video({ contentDetails: { regionRestriction: { blocked: ['DE'] } } }), 'US').eligible).toBe(true);
  });
});
