import { CATALOG_SCHEMA_VERSION, type CatalogCollection, type CatalogSnapshot } from '@sportscenter/contracts';
import { describe, expect, it } from 'vitest';
import { loadCollections, repoRoot, type Collection, type CollectionsConfig } from '../src/config.ts';
import type { JsonResponse } from '../src/http.ts';
import { planSync, playlistMarker, quotaDay, retirePlaylist, syncPlaylists, type RemoteItem, type SyncOptions } from '../src/publish/youtube-playlists.ts';
import { Store } from '../src/store.ts';
import type { ApiRequest, ApiTransport } from '../src/youtube/oauth.ts';

const ME = 'UCme';
const NOW = '2026-10-10T12:00:00.000Z';

interface FakePlaylist {
  id: string;
  channelId: string;
  title: string;
  description: string;
  privacy: string;
  items: { id: string; videoId: string }[];
}

/** In-memory YouTube Data API: playlists, playlistItems, channels(mine). Positions behave as remove-then-insert. */
class FakeYouTube {
  playlists = new Map<string, FakePlaylist>();
  requests: ApiRequest[] = [];
  mutations = 0;
  pageSize = 50;
  seq = 0;
  /** Override the next matching request: return a response, optionally still applying the request first. */
  next?: { match: (r: ApiRequest) => boolean; status: number; apply: boolean };

  transport: ApiTransport = async (req) => {
    this.requests.push(req);
    const ep = req.url.pathname.split('/').pop()!;
    const fault = this.next?.match(req) ? this.next : undefined;
    if (fault) {
      this.next = undefined;
      if (fault.apply) this.handle(ep, req);
      return { status: fault.status, body: { error: { errors: [{ reason: 'backendError' }] } } };
    }
    return this.handle(ep, req);
  };

  add(channelId: string, title: string, description: string, videoIds: string[] = []): FakePlaylist {
    const p: FakePlaylist = { id: `PL${++this.seq}`, channelId, title, description, privacy: 'private', items: videoIds.map((v) => ({ id: `it${++this.seq}`, videoId: v })) };
    this.playlists.set(p.id, p);
    return p;
  }

  videos(playlistId: string) {
    return this.playlists.get(playlistId)!.items.map((i) => i.videoId);
  }

  private page<T>(all: T[], req: ApiRequest) {
    const start = Number(req.url.searchParams.get('pageToken') ?? 0);
    const end = start + this.pageSize;
    return { items: all.slice(start, end), ...(end < all.length ? { nextPageToken: String(end) } : {}) };
  }

  private handle(ep: string, req: ApiRequest): JsonResponse {
    const q = req.url.searchParams;
    const body = req.body as { id?: string; snippet: { playlistId: string; position: number; resourceId: { videoId: string }; title: string; description: string }; status?: { privacyStatus: string } };
    if (ep === 'channels') return { status: 200, body: { items: [{ id: ME }] } };
    if (ep === 'playlists' && req.method === 'GET' && q.get('id')) {
      const p = this.playlists.get(q.get('id')!);
      return { status: 200, body: { items: p ? [{ id: p.id, snippet: { channelId: p.channelId, title: p.title, description: p.description } }] : [] } };
    }
    if (ep === 'playlists' && req.method === 'DELETE') {
      this.mutations++;
      this.playlists.delete(q.get('id')!);
      return { status: 204, body: null };
    }
    if (ep === 'playlists' && req.method === 'GET') {
      const mine = [...this.playlists.values()].filter((p) => p.channelId === ME).map((p) => ({ id: p.id, snippet: { channelId: p.channelId, title: p.title, description: p.description } }));
      return { status: 200, body: this.page(mine, req) };
    }
    if (ep === 'playlists' && req.method === 'POST') {
      this.mutations++;
      const p = this.add(ME, body.snippet.title, body.snippet.description);
      p.privacy = body.status!.privacyStatus;
      return { status: 200, body: { id: p.id } };
    }
    if (ep === 'playlistItems') {
      if (req.method === 'GET') {
        const p = this.playlists.get(q.get('playlistId')!);
        if (!p) return { status: 404, body: { error: { errors: [{ reason: 'playlistNotFound' }] } } };
        return { status: 200, body: this.page(p.items.map((it, position) => ({ id: it.id, snippet: { position, resourceId: { videoId: it.videoId } } })), req) };
      }
      this.mutations++;
      if (req.method === 'DELETE') {
        for (const p of this.playlists.values()) p.items = p.items.filter((i) => i.id !== q.get('id'));
        return { status: 204, body: null };
      }
      const p = this.playlists.get(body.snippet.playlistId)!;
      let item = { id: `it${++this.seq}`, videoId: body.snippet.resourceId.videoId };
      if (req.method === 'PUT') {
        item = p.items.find((i) => i.id === body.id)!;
        p.items.splice(p.items.indexOf(item), 1);
      }
      const position = Math.min(body.snippet.position, p.items.length);
      p.items.splice(position, 0, item);
      return { status: 200, body: { id: item.id, snippet: { position } } };
    }
    return { status: 400, body: {} };
  }
}

const baseConfig = loadCollections(repoRoot());
const NFL: Collection = { id: 'nfl', title: 'SportsCenter · NFL', kind: 'sport', sport: 'nfl', keep: { last: 50 }, publish: true };
const BILLS: Collection = { id: 'bills', title: 'SportsCenter · Bills', kind: 'team', sport: 'nfl', team: 'BUF', keep: { last: 7 }, publish: true };
function config(over: Partial<CollectionsConfig['publishing']> = {}, collections: Collection[] = [NFL]): CollectionsConfig {
  return { publishing: { ...baseConfig.publishing, writesPerCollectionPerRun: 100, ...over }, collections };
}

/** Catalog item for video `v` starting `n` hours after a fixed base time (display order = n). */
const item = (v: string, n: number) => ({
  eventId: `nfl:espn:${v}`, sport: 'nfl', competition: 'NFL', neutralTitle: `Game ${v}`, subtitle: 'NFL · Week 3',
  eventStartTime: new Date(Date.parse('2026-10-01T00:00:00Z') + n * 3_600_000).toISOString(), priority: 2,
  video: { platform: 'youtube' as const, videoId: v, durationSeconds: 900, publishedAt: '2026-10-01T05:00:00.000Z' },
  source: { id: 'nfl-youtube', displayName: 'NFL', tier: 1 }, titleScreen: 'unflagged' as const,
});

function catalog(videos: string[], over: Partial<CatalogCollection> = {}, generatedAt = NOW, id = 'nfl'): CatalogSnapshot {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION, generatedAt, region: 'US', configRevision: 't', sourceRuns: [],
    titleOverrides: { includeFlaggedTitles: false, includeUnreviewedTitles: false },
    collections: [
      {
        id, title: 'SportsCenter · NFL', kind: 'sport', publish: true, rule: 'last 50 events', status: 'complete', issues: [],
        window: { start: '2026-09-10T12:00:00.000Z', end: NOW }, coverage: { storedHistoryFrom: null },
        items: videos.map((v, i) => item(v, i)), exclusions: [], ...over,
      },
    ],
  };
}

let runSeq = 0;
function sync(store: Store, yt: FakeYouTube, cat: CatalogSnapshot, { now = NOW, ...o }: Partial<Omit<SyncOptions, 'now'>> & { now?: string } = {}) {
  return syncPlaylists({ store, transport: yt.transport, catalog: cat, config: config(), apply: true, runId: `pub-${++runSeq}`, now: () => now, newInstallId: () => 'inst-1', ...o });
}

const tracked = (store: Store) => store.publishPlaylist('nfl');

describe('planSync', () => {
  const remote = (vs: string[]): RemoteItem[] => vs.map((v, position) => ({ itemId: `i-${v}-${position}`, videoId: v, position }));
  /** Apply ops with remove-then-insert position semantics. */
  const simulate = (start: RemoteItem[], ops: ReturnType<typeof planSync>) => {
    const list = start.map((r) => ({ itemId: r.itemId, videoId: r.videoId }));
    for (const op of ops) {
      if (op.kind === 'delete') list.splice(list.findIndex((i) => i.itemId === op.itemId), 1);
      else if (op.kind === 'move') {
        const it = list.splice(list.findIndex((i) => i.itemId === op.itemId), 1)[0]!;
        list.splice(op.position, 0, it);
      } else list.splice(op.position, 0, { itemId: 'new', videoId: op.videoId });
    }
    return list.map((i) => i.videoId);
  };

  it('converges any remote state to the desired order', () => {
    let s = 7;
    const rand = () => ((s = (s * 48271) % 2147483647) / 2147483647);
    for (let t = 0; t < 300; t++) {
      const universe = 'abcdefghij'.split('');
      const desired = universe.filter(() => rand() < 0.6);
      const r = universe.filter(() => rand() < 0.6).sort(() => rand() - 0.5);
      if (rand() < 0.3 && r.length) r.push(r[0]!); // duplicate
      expect(simulate(remote(r), planSync(desired, remote(r)))).toEqual(desired);
    }
  });

  it('a late match lands mid-list with one insert and no drift moves', () => {
    expect(planSync(['a', 'b', 'c'], remote(['a', 'c']))).toEqual([{ kind: 'insert', videoId: 'b', position: 1 }]);
  });

  it('only genuinely reordered items are moved', () => {
    const ops = planSync(['a', 'b', 'c', 'd'], remote(['a', 'c', 'b', 'd']));
    expect(ops.filter((o) => o.kind === 'move')).toHaveLength(1);
    expect(planSync(['a', 'b'], remote(['a', 'b']))).toEqual([]);
  });
});

describe('syncPlaylists', () => {
  it('dry run reads but never mutates, and does not create playlists', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    const r = await sync(store, yt, catalog(['a', 'b']), { apply: false });
    expect(yt.mutations).toBe(0);
    expect(yt.playlists.size).toBe(0);
    expect(r.collections[0]).toMatchObject({ outcome: 'would_create', planned: { inserts: 2 } });
    expect(tracked(store)).toBeUndefined();
    expect(r.units).toBe(1); // channels.list
  });

  it('creates a private, marked playlist, inserts in chronological order, and a second apply changes nothing', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    const r = await sync(store, yt, catalog(['a', 'b', 'c']));
    expect(r.status).toBe('ok');
    const t = tracked(store)!;
    expect(t).toMatchObject({ state: 'active', channelId: ME, installId: 'inst-1' });
    const p = yt.playlists.get(t.playlistId!)!;
    expect(p.privacy).toBe('private');
    expect(p.description).toContain(playlistMarker('inst-1', 'nfl'));
    expect(yt.videos(p.id)).toEqual(['a', 'b', 'c']);

    const before = yt.mutations;
    const again = await sync(store, yt, catalog(['a', 'b', 'c']));
    expect(yt.mutations).toBe(before);
    expect(again.collections[0]!.outcome).toBe('in_sync');
  });

  it('inserts late matches mid-list, removes aged-out and duplicate items, and repairs drift', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    await sync(store, yt, catalog(['a', 'c', 'e']));
    const id = tracked(store)!.playlistId!;
    let r = await sync(store, yt, catalog(['a', 'b', 'c', 'e']));
    expect(r.collections[0]!.planned).toEqual({ deletes: 0, moves: 0, inserts: 1 });
    expect(yt.videos(id)).toEqual(['a', 'b', 'c', 'e']);

    const p = yt.playlists.get(id)!;
    p.items.reverse(); // manual reorder on the device
    p.items.push({ id: 'dup', videoId: 'b' });
    r = await sync(store, yt, catalog(['b', 'c', 'e']));
    expect(yt.videos(id)).toEqual(['b', 'c', 'e']);
    expect(r.collections[0]!.planned.moves).toBeGreaterThan(0);
  });

  it('fully paginates remote items before diffing', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    yt.pageSize = 2;
    const all = ['a', 'b', 'c', 'd', 'e'];
    await sync(store, yt, catalog(all));
    const r = await sync(store, yt, catalog(all));
    expect(r.collections[0]!.outcome).toBe('in_sync');
    expect(r.calls['playlistItems.list']).toBe(3);
  });

  it('incomplete or stale catalog input preserves remote content; a complete empty list removes it', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    await sync(store, yt, catalog(['a', 'b']));
    const id = tracked(store)!.playlistId!;
    let r = await sync(store, yt, catalog([], { status: 'incomplete', issues: ['nfl: discovery incomplete'] }));
    expect(r.collections[0]!.outcome).toBe('skipped_incomplete_catalog');
    expect(r.status).toBe('incomplete');
    r = await sync(store, yt, catalog([], {}, '2026-10-08T00:00:00.000Z'));
    expect(r.collections[0]!.outcome).toBe('skipped_incomplete_catalog');
    expect(yt.videos(id)).toEqual(['a', 'b']);
    await sync(store, yt, catalog([]));
    expect(yt.videos(id)).toEqual([]);
  });

  it('never adopts by title or touches untracked playlists, and isolates accounts', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    const lookalike = yt.add(ME, 'SportsCenter · NFL', 'my own list', ['x']);
    await sync(store, yt, catalog(['a']));
    expect(tracked(store)!.playlistId).not.toBe(lookalike.id);
    expect(yt.videos(lookalike.id)).toEqual(['x']);

    store.setPublishPlaylist({ ...tracked(store)!, channelId: 'UCsomeoneelse' }, NOW);
    const before = yt.mutations;
    const r = await sync(store, yt, catalog(['a', 'b']));
    expect(r.collections[0]!.outcome).toBe('skipped_account_mismatch');
    expect(yt.mutations).toBe(before);
  });

  it('recovers an uncertain creation by its install marker', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    yt.next = { match: (r) => r.method === 'POST' && r.url.pathname.endsWith('/playlists'), status: 503, apply: true };
    let r = await sync(store, yt, catalog(['a']));
    expect(r.collections[0]!.outcome).toBe('creation_pending');
    expect(tracked(store)!.state).toBe('creating');
    r = await sync(store, yt, catalog(['a']));
    expect(r.collections[0]!.notes[0]).toMatch(/recovered playlist/);
    expect(yt.playlists.size).toBe(1); // no second create
    expect(yt.videos(tracked(store)!.playlistId!)).toEqual(['a']);
  });

  it('fails closed on duplicate markers and on unresolved creation until the user allows a retry', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    yt.next = { match: (r) => r.method === 'POST' && r.url.pathname.endsWith('/playlists'), status: 503, apply: false };
    await sync(store, yt, catalog(['a']));
    let r = await sync(store, yt, catalog(['a']));
    expect(r.collections[0]!.outcome).toBe('creation_unresolved');
    r = await sync(store, yt, catalog(['a']));
    expect(r.collections[0]!.outcome).toBe('creation_unresolved');
    expect(yt.playlists.size).toBe(0);
    r = await sync(store, yt, catalog(['a']), { retryCreate: ['nfl'] });
    expect(r.collections[0]!.outcome).toBe('applied');
    expect(yt.playlists.size).toBe(1);

    const store2 = new Store(':memory:');
    store2.installId(() => 'inst-1');
    store2.setPublishPlaylist({ collectionId: 'nfl', channelId: ME, installId: 'inst-1', state: 'creating' }, NOW);
    const yt2 = new FakeYouTube();
    yt2.add(ME, 'a', `x ${playlistMarker('inst-1', 'nfl')}`);
    yt2.add(ME, 'b', `y ${playlistMarker('inst-1', 'nfl')}`);
    r = await sync(store2, yt2, catalog(['a']));
    expect(r.collections[0]!.outcome).toBe('conflict_duplicate_markers');
    expect(tracked(store2)!.state).toBe('conflict');
    expect(yt2.mutations).toBe(0);
  });

  it('a just-created playlist that YouTube is not serving yet is filled on the next run; a deleted one is reported missing', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    // Observed 2026-10-03: playlistItems.list returns 404 playlistNotFound right after playlists.insert.
    yt.next = { match: (r) => r.method === 'GET' && r.url.pathname.endsWith('/playlistItems'), status: 404, apply: false };
    let r = await sync(store, yt, catalog(['a', 'b']));
    expect(r.collections[0]).toMatchObject({ outcome: 'partial', backlog: 2, applied: { creates: 1 } });
    expect(r.status).toBe('ok');
    r = await sync(store, yt, catalog(['a', 'b']));
    expect(r.collections[0]!.outcome).toBe('applied');
    expect(yt.playlists.size).toBe(1);
    expect(yt.videos(tracked(store)!.playlistId!)).toEqual(['a', 'b']);

    yt.playlists.clear(); // user deleted it on YouTube
    r = await sync(store, yt, catalog(['a', 'b']));
    expect(r.collections[0]!.outcome).toBe('playlist_missing');
    expect(yt.playlists.size).toBe(0); // never recreated automatically
  });

  it('a definitely rejected creation is not tracked', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    yt.next = { match: (r) => r.method === 'POST', status: 400, apply: false };
    const r = await sync(store, yt, catalog(['a']));
    expect(r.collections[0]!.outcome).toBe('failed');
    expect(tracked(store)).toBeUndefined();
  });

  it('enforces the daily budget including reads, counts attempted calls, and resets on the Pacific day', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    const cfg = config({ dailyBudgetUnits: 160 });
    // channels 1 + create 50 + list 1 + insert 50 + insert 50 = 152; a third insert (50) would exceed 160.
    let r = await sync(store, yt, catalog(['a', 'b', 'c']), { config: cfg });
    expect(r.status).toBe('budget_limited');
    expect(r.units).toBe(152);
    expect(r.budget.remainingWrites).toBe(0);
    expect(yt.videos(tracked(store)!.playlistId!)).toEqual(['a', 'b']);

    // Still 2026-10-10 in Pacific time: the earlier run's units count, and reads are checked against the budget too.
    r = await sync(store, yt, catalog(['a', 'b', 'c']), { config: cfg, now: '2026-10-11T06:59:00.000Z' });
    expect(r.budget.usedBefore).toBe(152);
    expect(r.units).toBe(2);
    expect(r.status).toBe('budget_limited');
    expect(quotaDay('2026-10-11T06:59:00.000Z')).toBe('2026-10-10');
    expect(quotaDay('2026-10-11T07:00:00.000Z')).toBe('2026-10-11');

    r = await sync(store, yt, catalog(['a', 'b', 'c']), { config: config({ dailyBudgetUnits: 3000 }), now: '2026-10-11T07:00:00.000Z' });
    expect(r.budget.usedBefore).toBe(0);
    expect(yt.videos(tracked(store)!.playlistId!)).toEqual(['a', 'b', 'c']);
  });

  it('counts failed writes toward the day and stops the collection to re-plan next run', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    await sync(store, yt, catalog(['a']));
    yt.next = { match: (r) => r.method === 'POST' && r.url.pathname.endsWith('/playlistItems'), status: 500, apply: false };
    const r = await sync(store, yt, catalog(['a', 'b', 'c']));
    expect(r.collections[0]).toMatchObject({ outcome: 'failed', backlog: 2 });
    expect(r.calls['playlistItems.insert']).toBe(1);
    expect(store.publishUnitsOn('2026-10-10')).toBe(r.units + 1 + 50 + 1 + 50); // includes the first run
    await sync(store, yt, catalog(['a', 'b', 'c']));
    expect(yt.videos(tracked(store)!.playlistId!)).toEqual(['a', 'b', 'c']);
  });

  it('caps writes per collection per run, in configured collection order', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    const two = [NFL, BILLS];
    const cat = catalog(['a', 'b', 'c']);
    cat.collections.push({ ...cat.collections[0]!, id: 'bills', title: 'SportsCenter · Bills' });
    const cfg = config({ writesPerCollectionPerRun: 2 }, two);
    let r = await sync(store, yt, cat, { config: cfg });
    expect(r.collections.map((c) => [c.collectionId, c.outcome, c.applied.creates + c.applied.inserts, c.backlog])).toEqual([
      ['nfl', 'partial', 2, 2],
      ['bills', 'partial', 2, 2],
    ]);
    r = await sync(store, yt, cat, { config: cfg });
    r = await sync(store, yt, cat, { config: cfg });
    expect(r.collections.every((c) => c.outcome === 'in_sync')).toBe(true);
  });

  it('retires an engine-owned playlist on request, and refuses anything it did not create', async () => {
    const store = new Store(':memory:');
    const yt = new FakeYouTube();
    await sync(store, yt, catalog(['a']));
    const id = tracked(store)!.playlistId!;
    const own = yt.add(ME, 'SportsCenter · NFL', 'my own list without a marker', ['x']);

    // A tracked ID that points at a playlist without this install's marker is refused.
    store.setPublishPlaylist({ ...tracked(store)!, playlistId: own.id }, NOW);
    let r = await retirePlaylist({ store, transport: yt.transport, config: config(), collectionId: 'nfl', runId: 'ret-1', now: () => NOW });
    expect(r.outcome).toBe('refused');
    expect(yt.playlists.has(own.id)).toBe(true);

    store.setPublishPlaylist({ ...tracked(store)!, playlistId: id }, NOW);
    r = await retirePlaylist({ store, transport: yt.transport, config: config(), collectionId: 'nfl', runId: 'ret-2', now: () => NOW });
    expect(r).toMatchObject({ outcome: 'deleted', playlistId: id });
    expect(yt.playlists.has(id)).toBe(false);
    expect(tracked(store)).toBeUndefined();
    expect(yt.playlists.has(own.id)).toBe(true);
    expect((await retirePlaylist({ store, transport: yt.transport, config: config(), collectionId: 'nfl', runId: 'ret-3', now: () => NOW })).outcome).toBe('refused');
  });
});
