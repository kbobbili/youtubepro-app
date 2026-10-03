import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayTransport, type JsonResponse, type Transport } from '../src/http.ts';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const W3 = path.join(FIXTURES, 'nfl-2026-w3');

type Video = { id: string; snippet: { channelId: string } };

/** All recorded videos.list items, so any ID subset can be answered regardless of request batching. */
function recordedVideos(dir: string): Map<string, Video> {
  const out = new Map<string, Video>();
  for (const f of fs.readdirSync(dir)) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { url: string; body: { items?: Video[] } };
    if (new URL(rec.url).pathname.endsWith('/videos')) for (const v of rec.body.items ?? []) out.set(v.id, v);
  }
  return out;
}

/**
 * Replay recorded fixtures. videos.list is answered from the recorded metadata pool;
 * `mutateVideo` can drop (return undefined) or alter individual videos.
 */
export function fixtureTransport(dir = W3, mutateVideo: (v: Video) => Video | undefined = (v) => v): Transport {
  const replay = replayTransport(dir);
  const pool = recordedVideos(dir);
  return async (url) => {
    if (url.pathname.endsWith('/videos')) {
      const items = (url.searchParams.get('id') ?? '').split(',').flatMap((id) => {
        const v = pool.get(id);
        const m = v && mutateVideo(structuredClone(v));
        return m ? [m] : [];
      });
      return { status: 200, body: { items } };
    }
    return replay(url);
  };
}

export const w3Transport = () => fixtureTransport();

/** Wrap a transport, letting a test override specific URLs. */
export function overriding(base: Transport, override: (url: URL) => JsonResponse | undefined | Promise<JsonResponse | undefined>): Transport {
  return async (url) => (await override(url)) ?? base(url);
}
