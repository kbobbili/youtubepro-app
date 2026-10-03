import { describe, expect, it } from 'vitest';
import { getJson, sanitizeUrl, type JsonResponse, type Transport } from '../src/http.ts';
import { parseIsoDuration, QuotaExceededError, YouTubeClient } from '../src/youtube/client.ts';

const item = (id: string, publishedAt: string | undefined) => ({
  snippet: { title: id, channelId: 'UC' },
  contentDetails: { videoId: id, ...(publishedAt ? { videoPublishedAt: publishedAt } : {}) },
});

/** Fake playlist with pages of items; page N is addressed by pageToken "pN". */
function playlist(pages: ReturnType<typeof item>[][]): Transport {
  return async (url) => {
    const token = url.searchParams.get('pageToken');
    const idx = token ? Number(token.slice(1)) : 0;
    const items = pages[idx]!;
    return { status: 200, body: { items, ...(idx + 1 < pages.length ? { nextPageToken: `p${idx + 1}` } : {}) } };
  };
}

const SINCE = '2026-09-25T00:00:00Z';

describe('YouTubeClient.scanUploads', () => {
  it('stops only after a whole page is older than the window (tolerates out-of-order items)', async () => {
    const yt = new YouTubeClient(
      playlist([
        [item('a', '2026-09-28T00:00:00Z'), item('old-but-early', '2026-09-20T00:00:00Z')],
        [item('b', '2026-09-26T00:00:00Z'), item('c', '2026-09-24T00:00:00Z')],
        [item('d', '2026-09-23T00:00:00Z'), item('e', '2026-09-22T00:00:00Z')],
        [item('never', '2026-09-21T00:00:00Z')],
      ]),
      'k',
    );
    const scan = await yt.scanUploads('UU', SINCE);
    expect(scan).toMatchObject({ complete: true, stopReason: 'reached_window_start', pages: 3 });
    expect(scan.items.map((i) => i.videoId)).toEqual(['a', 'b']);
    expect(yt.ledger.calls).toEqual({ playlistItems: 3 });
  });

  it('never treats items without a publish time as old', async () => {
    const yt = new YouTubeClient(playlist([[item('x', undefined)], [item('y', '2026-09-01T00:00:00Z')]]), 'k');
    expect(await yt.scanUploads('UU', SINCE)).toMatchObject({ pages: 2, stopReason: 'reached_window_start' });
  });

  it('reports end of playlist as complete', async () => {
    const yt = new YouTubeClient(playlist([[item('a', '2026-09-28T00:00:00Z')]]), 'k');
    expect(await yt.scanUploads('UU', SINCE)).toMatchObject({ complete: true, stopReason: 'end_of_playlist' });
  });

  it('reports a page limit as INCOMPLETE, not missing content', async () => {
    const pages = Array.from({ length: 5 }, (_, i) => [item(`v${i}`, '2026-09-28T00:00:00Z')]);
    const yt = new YouTubeClient(playlist(pages), 'k');
    expect(await yt.scanUploads('UU', SINCE, 3)).toMatchObject({ complete: false, stopReason: 'page_limit', pages: 3 });
  });

  it('reports malformed pages as incomplete and propagates quota exhaustion', async () => {
    const malformed = new YouTubeClient(async () => ({ status: 200, body: { items: 'nope' } }), 'k');
    expect(await malformed.scanUploads('UU', SINCE)).toMatchObject({ complete: false, stopReason: 'error' });

    const quota: Transport = async () => ({ status: 403, body: { error: { errors: [{ reason: 'quotaExceeded' }] } } });
    await expect(new YouTubeClient(quota, 'k').scanUploads('UU', SINCE)).rejects.toBeInstanceOf(QuotaExceededError);
  });
});

describe('http', () => {
  it('retries transient failures a bounded number of times', async () => {
    const seen: number[] = [];
    const flaky: Transport = async () => {
      seen.push(1);
      return seen.length < 3 ? { status: 503, body: null } : { status: 200, body: { ok: true } };
    };
    await expect(getJson(flaky, new URL('https://x.test/a'), { backoffMs: 1 })).resolves.toEqual({ ok: true });
    expect(seen).toHaveLength(3);

    let calls = 0;
    const down: Transport = async (): Promise<JsonResponse> => {
      calls++;
      return { status: 500, body: null };
    };
    await expect(getJson(down, new URL('https://x.test/a'), { retries: 2, backoffMs: 1 })).rejects.toThrow(/HTTP 500/);
    expect(calls).toBe(3);
  });

  it('does not retry client errors and never leaks the API key', async () => {
    let calls = 0;
    const bad: Transport = async () => {
      calls++;
      return { status: 400, body: null };
    };
    const url = new URL('https://www.googleapis.com/youtube/v3/videos?id=a&key=SECRET123');
    await expect(getJson(bad, url, { backoffMs: 1 })).rejects.toThrow(/^HTTP 400 for (?!.*SECRET123)/);
    expect(calls).toBe(1);
    expect(sanitizeUrl(url)).not.toContain('SECRET123');

    const net: Transport = async () => {
      throw new TypeError(`fetch failed ${url}`);
    };
    await expect(getJson(net, url, { retries: 0 })).rejects.toThrow(/^(?!.*SECRET123)/);
  });
});

describe('parseIsoDuration', () => {
  it.each([
    ['PT15M19S', 919],
    ['PT1H2M3S', 3723],
    ['PT10S', 10],
    ['P1DT1S', 86401],
    ['bogus', undefined],
    [undefined, undefined],
  ])('%s → %s', (iso, secs) => expect(parseIsoDuration(iso)).toBe(secs));
});
