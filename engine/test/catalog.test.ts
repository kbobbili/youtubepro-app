import { CatalogSnapshot } from '@sportscenter/contracts';
import { describe, expect, it } from 'vitest';
import { buildCatalog, generateCatalog, type CatalogOptions } from '../src/catalog.ts';
import { loadCollections, loadSources, repoRoot, type CollectionsConfig, type Preferences } from '../src/config.ts';
import { nflAdapter } from '../src/adapters/nfl/index.ts';
import type { NflEvent } from '../src/domain.ts';
import { discover } from '../src/pipeline.ts';
import { recordMetadataChecks } from '../src/revalidate.ts';
import { Store } from '../src/store.ts';
import type { VideoMetadata } from '../src/youtube/client.ts';
import { YouTubeClient } from '../src/youtube/client.ts';
import { buildSnapshot } from '../src/snapshot.ts';
import { fixtureTransport, W3, w3Transport } from './helpers.ts';

const root = repoRoot();
const sources = loadSources(root);
const NFL_CHANNEL = 'UCDVYQ4Zhbm3S2dlz7P1GBDg';
const NOW = '2026-10-10T12:00:00.000Z';
const daysAgo = (d: number, h = 0) => new Date(Date.parse(NOW) - d * 86_400_000 - h * 3_600_000).toISOString();

const prefs: Preferences = {
  region: 'US',
  sports: { nfl: { enabled: true, teams: [{ abbr: 'SF', name: 'San Francisco 49ers', priority: 'high' }, { abbr: 'BUF', name: 'Buffalo Bills', priority: 'high' }] } },
};
const team = (abbr: string) => ({ abbr, name: `${abbr} Team`, shortName: abbr });

function meta(id: string, title: string, over: Partial<VideoMetadata['status']> = {}): VideoMetadata {
  return {
    id,
    snippet: { title, channelId: NFL_CHANNEL, publishedAt: '2026-09-01T00:00:00Z', liveBroadcastContent: 'none' },
    contentDetails: { duration: 'PT15M', contentRating: {} },
    status: { embeddable: true, privacyStatus: 'public', uploadStatus: 'processed', ...over },
  };
}

let seq = 0;
/** Seed one completed NFL event with a FOUND primary highlight and a metadata check at `checkedAt`. */
function seed(store: Store, o: { start: string; home: string; away: string; title?: string; checkedAt?: string; status?: Partial<VideoMetadata['status']> }): { eventId: string; videoId: string } {
  const n = ++seq;
  const eventId = `nfl:espn:${n}`;
  const videoId = `vid${n}`;
  const event: NflEvent = {
    id: eventId, sport: 'nfl', competition: 'NFL', competitionId: 'NFL', provider: 'espn', providerEventId: String(n), season: 2026, seasonType: 2, week: 3,
    startTime: o.start, status: 'COMPLETED', providerStatus: 'STATUS_FINAL', home: team(o.home), away: team(o.away), stage: 'Week 3',
    participants: [{ ...team(o.home), id: o.home, role: 'home' }, { ...team(o.away), id: o.away, role: 'away' }], meta: { seasonType: 2, week: 3 },
  };
  store.upsertEvent(event, o.start, false);
  store.setDiscovery(eventId, 'FOUND', o.start);
  store.upsertCandidate(
    { eventId, videoId, sourceId: 'nfl-youtube', channelId: NFL_CHANNEL, rawTitle: o.title ?? `${o.away} vs ${o.home} Game Highlights`, publishedAt: o.start, durationSeconds: 900, confidence: 1, flags: [], metadataEligible: true, metadataReasons: [] },
    o.start,
  );
  store.selectPrimary(eventId, o.start);
  recordMetadataChecks(store, [videoId], new Map([[videoId, meta(videoId, o.title ?? `${o.away} vs ${o.home} Game Highlights`, o.status)]]), 'US', () => 'nfl', o.checkedAt ?? NOW);
  return { eventId, videoId };
}

function okRun(store: Store, status: 'ok' | 'incomplete' = 'ok') {
  const id = `run-${++seq}`;
  store.startRun({ id, sport: 'nfl', cohort: 'personal', kind: 'prospective', startedAt: NOW, window: { start: daysAgo(7), end: NOW }, config: {} });
  store.finishRun(id, NOW, status, [], {});
}

// NFL-only preferences here, so only the NFL and mixed collections are in scope (other sports would report "not enabled").
const loaded = loadCollections(root);
const baseConfig = { ...loaded, collections: loaded.collections.filter((c) => c.kind === 'mixed' || c.sport === 'nfl') };
function options(over: { prefs?: Preferences; collections?: Partial<CollectionsConfig>; publishing?: Partial<CollectionsConfig['publishing']>; sources?: typeof sources } = {}): CatalogOptions {
  return {
    prefs: over.prefs ?? prefs,
    sources: over.sources ?? sources,
    collections: { ...baseConfig, ...over.collections, publishing: { ...baseConfig.publishing, ...over.publishing } },
    now: NOW,
    configRevision: 'test',
  };
}

const col = (c: CatalogSnapshot, id: string) => c.collections.find((x) => x.id === id)!;
const vids = (c: CatalogSnapshot, id: string) => col(c, id).items.map((i) => i.video.videoId);

describe('catalog', () => {
  it('orders every collection by event start (oldest first) and applies sport/team membership', () => {
    const store = new Store(':memory:');
    okRun(store);
    const b = seed(store, { start: daysAgo(2), home: 'BUF', away: 'LAC' });
    const s = seed(store, { start: daysAgo(3), home: 'SF', away: 'ARI' });
    seed(store, { start: daysAgo(1), home: 'KC', away: 'MIA' }); // not followed
    const c = buildCatalog(store, options());
    expect(vids(c, 'nfl')).toEqual([s.videoId, b.videoId]);
    expect(vids(c, 'this-week')).toEqual([s.videoId, b.videoId]);
    expect(vids(c, 'bills')).toEqual([b.videoId]);
    expect(vids(c, '49ers')).toEqual([s.videoId]);
    expect(c.collections.every((x) => x.status === 'complete')).toBe(true);
    expect(col(c, 'nfl').items[0]).toMatchObject({ neutralTitle: 'ARI Team at SF Team', subtitle: 'NFL · Week 3', titleScreen: 'unflagged' });
  });

  it('rolling retention: >7 days leaves this-week but stays in 30-day lists; >30 days leaves all', () => {
    const store = new Store(':memory:');
    okRun(store);
    const recent = seed(store, { start: daysAgo(2), home: 'BUF', away: 'LAC' });
    const older = seed(store, { start: daysAgo(8), home: 'BUF', away: 'NYJ' });
    seed(store, { start: daysAgo(31), home: 'BUF', away: 'MIA' });
    const c = buildCatalog(store, options());
    expect(vids(c, 'this-week')).toEqual([recent.videoId]);
    expect(vids(c, 'nfl')).toEqual([older.videoId, recent.videoId]);
    expect(vids(c, 'bills')).toEqual([older.videoId, recent.videoId]);
    expect(col(c, 'nfl').window.start).toBe(daysAgo(30));
    expect(col(c, 'nfl').coverage.storedHistoryFrom).toBe(daysAgo(31));
    // Records stay stored; aging out only removes collection membership.
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM highlights').get()).toEqual({ n: 3 });
  });

  it('selects capped membership first (newest), then displays oldest first', () => {
    const store = new Store(':memory:');
    okRun(store);
    const [a, b, d] = [4, 3, 2].map((n) => seed(store, { start: daysAgo(n), home: 'BUF', away: 'LAC' }));
    const c = buildCatalog(store, options({ collections: { collections: baseConfig.collections.map((x) => (x.id === 'nfl' ? { ...x, cap: 2 } : x)) } }));
    expect(vids(c, 'nfl')).toEqual([b!.videoId, d!.videoId]);
    expect(col(c, 'nfl').exclusions).toContainEqual({ eventId: a!.eventId, videoId: a!.videoId, reason: 'over_cap' });
  });

  it('mixed collections rank by priority before recency, under total and per-sport caps', () => {
    const store = new Store(':memory:');
    okRun(store);
    const bills = seed(store, { start: daysAgo(5), home: 'BUF', away: 'LAC' });
    seed(store, { start: daysAgo(1), home: 'SF', away: 'ARI' });
    const p: Preferences = { ...prefs, sports: { nfl: { enabled: true, teams: [{ abbr: 'SF', name: 'SF', priority: 'low' }, { abbr: 'BUF', name: 'BUF', priority: 'must' }] } } };
    const cfg = baseConfig.collections.map((x) => (x.id === 'this-week' ? { ...x, cap: 1 } : x));
    expect(vids(buildCatalog(store, options({ prefs: p, collections: { collections: cfg } })), 'this-week')).toEqual([bills.videoId]);
    const perSport = baseConfig.collections.map((x) => (x.kind === 'mixed' ? { ...x, perSportCaps: { nfl: 1 } } : x));
    expect(vids(buildCatalog(store, options({ prefs: p, collections: { collections: perSport } })), 'this-week')).toEqual([bills.videoId]);
  });

  it('excludes flagged titles by default; an explicit override includes them and is recorded', () => {
    const store = new Store(':memory:');
    okRun(store);
    const v = seed(store, { start: daysAgo(2), home: 'BUF', away: 'LAC', title: 'Bills beat Chargers 27-24' });
    const c = buildCatalog(store, options());
    expect(vids(c, 'nfl')).toEqual([]);
    expect(col(c, 'nfl').exclusions[0]!.reason).toMatch(/^title_flagged:/);
    const o = buildCatalog(store, options({ publishing: { includeFlaggedTitles: true } }));
    expect(o.titleOverrides.includeFlaggedTitles).toBe(true);
    expect(col(o, 'nfl').items[0]).toMatchObject({ titleScreen: 'flagged', video: { videoId: v.videoId } });
  });

  it('re-screens when the publisher changes a title', () => {
    const store = new Store(':memory:');
    okRun(store);
    const v = seed(store, { start: daysAgo(2), home: 'BUF', away: 'LAC' });
    expect(vids(buildCatalog(store, options()), 'nfl')).toEqual([v.videoId]);
    recordMetadataChecks(store, [v.videoId], new Map([[v.videoId, meta(v.videoId, 'Bills stun Chargers in OT')]]), 'US', () => 'nfl', NOW);
    expect(vids(buildCatalog(store, options()), 'nfl')).toEqual([]);
  });

  it('a stale check that cannot be refreshed keeps the item but marks the collection incomplete', async () => {
    const store = new Store(':memory:');
    okRun(store);
    const v = seed(store, { start: daysAgo(10), home: 'BUF', away: 'LAC', checkedAt: daysAgo(2) });
    const { catalog, revalidation } = await generateCatalog(store, undefined, options());
    expect(revalidation.stale).toEqual([v.videoId]);
    expect(col(catalog, 'nfl')).toMatchObject({ status: 'incomplete' });
    expect(vids(catalog, 'nfl')).toEqual([v.videoId]);
    expect(col(catalog, 'this-week').status).toBe('complete'); // the stale video is not a member there
  });

  it('refreshes retained videos outside the discovery window; confirmed removal is an exclusion, not staleness', async () => {
    const store = new Store(':memory:');
    okRun(store);
    const gone = seed(store, { start: daysAgo(20), home: 'BUF', away: 'LAC', checkedAt: daysAgo(3) });
    const kept = seed(store, { start: daysAgo(15), home: 'SF', away: 'ARI', checkedAt: daysAgo(3) });
    const requested: string[] = [];
    const yt = new YouTubeClient(async (url) => {
      requested.push(...(url.searchParams.get('id') ?? '').split(','));
      return { status: 200, body: { items: [meta(kept.videoId, 'ARI vs SF Game Highlights')] } };
    }, 'k');
    const { catalog } = await generateCatalog(store, yt, options());
    expect(requested.sort()).toEqual([gone.videoId, kept.videoId].sort());
    expect(yt.ledger.calls).toEqual({ videos: 1 }); // batched
    expect(col(catalog, 'nfl')).toMatchObject({ status: 'complete' });
    expect(vids(catalog, 'nfl')).toEqual([kept.videoId]);
    expect(col(catalog, 'nfl').exclusions).toContainEqual({ eventId: gone.eventId, videoId: gone.videoId, reason: 'video_unavailable' });
    expect(store.videoCheck(kept.videoId)!.checkedAt).toBe(NOW);
  });

  it('re-evaluates source trust and preferences locally on every build', () => {
    const store = new Store(':memory:');
    okRun(store);
    seed(store, { start: daysAgo(2), home: 'BUF', away: 'LAC' });
    const untrusted = buildCatalog(store, options({ sources: sources.map((s) => ({ ...s, enabled: false })) }));
    expect(col(untrusted, 'nfl').exclusions.map((e) => e.reason)).toEqual(['untrusted_source']);
    const unfollowed = buildCatalog(store, options({ prefs: { ...prefs, sports: { nfl: { enabled: true, teams: [{ abbr: 'SF', name: 'SF', priority: 'high' }] } } } }));
    expect(vids(unfollowed, 'nfl')).toEqual([]);
  });

  it('includes embedding-disabled videos (SmartTube plays them) but still excludes private ones', () => {
    const store = new Store(':memory:');
    okRun(store);
    const v = seed(store, { start: daysAgo(2), home: 'BUF', away: 'LAC', status: { embeddable: false } });
    const p = seed(store, { start: daysAgo(3), home: 'SF', away: 'ARI', status: { privacyStatus: 'private' } });
    const c = col(buildCatalog(store, options()), 'nfl');
    expect(c.items.map((i) => i.video.videoId)).toEqual([v.videoId]);
    expect(c.exclusions).toEqual([{ eventId: p.eventId, videoId: p.videoId, reason: 'metadata:not_public:private' }]);
  });

  it('end to end: an embedding-disabled highlight is FOUND and catalogued, but stays out of the TV library export', async () => {
    const store = new Store(':memory:');
    const t = fixtureTransport(W3, (v) => (v.id === 'v__pg6qIYL4' ? { ...v, status: { ...(v as unknown as { status: object }).status, embeddable: false } } : v));
    const r = await discover({ adapter: nflAdapter,
      store, eventsTransport: t, youtube: new YouTubeClient(t, 'test'), sources, prefs, window: { start: '2026-09-24T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
      cohort: 'personal', kind: 'backfill', runId: 'w3-embed', now: () => '2026-10-03T02:30:00.000Z',
    });
    expect(r.outcomes.map((o) => o.discovery)).toEqual(['FOUND', 'FOUND']);
    expect(vids(buildCatalog(store, { ...options(), now: '2026-10-03T02:30:00.000Z' }), 'nfl')).toEqual(['v__pg6qIYL4', '7ngu-tT0PQs']);
    expect(buildSnapshot(store, prefs, sources, '2026-10-03T02:30:00.000Z').items.map((i) => i.video.videoId)).toEqual(['7ngu-tT0PQs']);
  });

  it('distinguishes a complete empty collection from incomplete input', () => {
    const store = new Store(':memory:');
    expect(buildCatalog(store, options()).collections.every((c) => c.status === 'incomplete' && c.items.length === 0)).toBe(true);
    okRun(store);
    expect(buildCatalog(store, options()).collections.every((c) => c.status === 'complete' && c.items.length === 0)).toBe(true);
    okRun(store, 'incomplete');
    expect(col(buildCatalog(store, options()), 'nfl').issues[0]).toMatch(/latest personal discovery run .* is incomplete/);
  });

  it('a sport whose discovery stopped running is incomplete, so its playlists keep last-known-good', () => {
    const store = new Store(':memory:');
    store.startRun({ id: 'old', sport: 'nfl', cohort: 'personal', kind: 'prospective', startedAt: daysAgo(0, 7), window: { start: daysAgo(7), end: NOW }, config: {} });
    store.finishRun('old', daysAgo(0, 7), 'ok', [], {});
    expect(col(buildCatalog(store, options()), 'nfl')).toMatchObject({ status: 'incomplete', issues: [expect.stringMatching(/older than 6h/)] });
    expect(col(buildCatalog(store, options({ publishing: { maxDiscoveryAgeHours: 8 } })), 'nfl').status).toBe('complete');
  });

  it('end to end from recorded Week 3 discovery: screened, neutral, no publisher titles', async () => {
    const store = new Store(':memory:');
    const t = w3Transport();
    await discover({ adapter: nflAdapter,
      store, eventsTransport: t, youtube: new YouTubeClient(t, 'test'), sources, prefs, window: { start: '2026-09-24T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
      cohort: 'personal', kind: 'backfill', runId: 'w3', now: () => '2026-10-03T02:30:00.000Z',
    });
    expect(store.titleScreen('v__pg6qIYL4')).toMatchObject({ status: 'unflagged' });
    const c = buildCatalog(store, { ...options(), now: '2026-10-03T02:30:00.000Z' });
    expect(vids(c, 'nfl')).toEqual(['v__pg6qIYL4', '7ngu-tT0PQs']); // LAC@BUF 17:00Z before ARI@SF 20:05Z
    expect(JSON.stringify(c)).not.toMatch(/Game Highlights|score/i);
    expect(() => CatalogSnapshot.parse(c)).not.toThrow();
  });
});
