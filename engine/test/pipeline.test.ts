import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPreferences, loadSources, repoRoot, type Preferences, type Source } from '../src/config.ts';
import type { Cohort, RunKind, Window } from '../src/domain.ts';
import type { Transport } from '../src/http.ts';
import { nflAdapter } from '../src/adapters/nfl/index.ts';
import type { NflEvent } from '../src/domain.ts';
import { discover, type EventOutcome } from '../src/pipeline.ts';
import { buildReport } from '../src/report.ts';
import { buildSnapshot } from '../src/snapshot.ts';
import { quotaExhausted } from '../src/quota.ts';
import { Store } from '../src/store.ts';
import { YouTubeClient } from '../src/youtube/client.ts';
import { fixtureTransport, overriding, W3, w3Transport } from './helpers.ts';

const root = repoRoot();
const WEEK3: Window = { start: '2026-09-24T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' };
const AFTER_CUTOFF = '2026-10-03T02:30:00.000Z';
const prefs: Preferences = { region: 'US', sports: { nfl: { enabled: true, teams: [{ abbr: 'SF', name: 'San Francisco 49ers', priority: 'high' }, { abbr: 'BUF', name: 'Buffalo Bills', priority: 'high' }] } } };
const sources = loadSources(root);

let runSeq = 0;
function run(store: Store, o: { cohort?: Cohort; kind?: RunKind; now?: string; transport?: Transport; sources?: Source[]; prefs?: Preferences } = {}) {
  const transport = o.transport ?? w3Transport();
  const now = o.now ?? AFTER_CUTOFF;
  return discover({
    adapter: nflAdapter, store, eventsTransport: transport, youtube: new YouTubeClient(transport, 'test'), sources: o.sources ?? sources, prefs: o.prefs ?? prefs,
    window: WEEK3, cohort: o.cohort ?? 'personal', kind: o.kind ?? 'backfill', runId: `run-${++runSeq}`, now: () => now,
  });
}

const nfl = (o: EventOutcome) => o.event as NflEvent;

const count = (store: Store, table: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** One video disappears (deleted/private): gone from videos.list and from the uploads playlist. */
const withoutVideo = (videoId: string): Transport =>
  overriding(fixtureTransport(W3, (v) => (v.id === videoId ? undefined : v)), async (u) => {
    if (!u.pathname.endsWith('/playlistItems')) return undefined;
    const res = await w3Transport()(u);
    const body = structuredClone(res.body) as { items: { contentDetails: { videoId: string } }[] };
    body.items = body.items.filter((i) => i.contentDetails.videoId !== videoId);
    return { status: 200, body };
  });

describe('NFL discovery pipeline (recorded Week 3 fixtures)', () => {
  it('diagnostic cohort: all 16 completed games match their official highlight', async () => {
    const store = new Store(':memory:');
    const r = await run(store, { cohort: 'diagnostic' });
    expect(r.status).toBe('ok');
    expect(r.scans[0]).toMatchObject({ sourceId: 'nfl-youtube', complete: true, stopReason: 'reached_window_start' });
    expect(r.outcomes).toHaveLength(16);
    expect(r.outcomes.every((o) => o.discovery === 'FOUND')).toBe(true);
    expect(r.quota.estimatedUnits).toBeLessThanOrEqual(15);
  });

  it('personal cohort: only 49ers and Bills games, matched to the right videos', async () => {
    const store = new Store(':memory:');
    const r = await run(store);
    expect(r.status).toBe('ok');
    const found = Object.fromEntries(r.outcomes.map((o) => [`${nfl(o).away.abbr}@${nfl(o).home.abbr}`, o.primary?.videoId]));
    expect(found).toEqual({ 'LAC@BUF': 'v__pg6qIYL4', 'ARI@SF': '7ngu-tT0PQs' });
  });

  it('reruns are idempotent and keep first observations', async () => {
    const store = new Store(':memory:');
    await run(store, { kind: 'prospective', now: '2026-10-01T00:00:00.000Z' });
    const first = store.db.prepare("SELECT first_seen_at, first_observed_final_at FROM events WHERE id = 'nfl:espn:401872953'").get();
    const before = { candidates: count(store, 'candidates'), highlights: count(store, 'highlights'), events: count(store, 'events') };
    await run(store, { kind: 'prospective', now: '2026-10-02T00:00:00.000Z' });
    expect({ candidates: count(store, 'candidates'), highlights: count(store, 'highlights'), events: count(store, 'events') }).toEqual(before);
    expect(store.db.prepare("SELECT first_seen_at, first_observed_final_at FROM events WHERE id = 'nfl:espn:401872953'").get()).toEqual(first);
    const report = buildReport(store, 'personal');
    expect(report.eligibleEvents).toBe(2); // distinct events, not per-run rows
    expect(report.runs.total).toBe(2);
  });

  it('prospective coverage excludes games that were already final when observation began', async () => {
    const store = new Store(':memory:');
    await run(store, { kind: 'prospective' });
    const r = buildReport(store, 'personal', 'prospective');
    expect(r.eligibleEvents).toBe(0);
    expect(r.latency.medianMinutesPublishToDiscovery).toBeUndefined();
    expect(buildReport(store, 'personal', 'all').eligibleEvents).toBe(2);
  });

  it('backfills never claim an observed completion time', async () => {
    const store = new Store(':memory:');
    await run(store, { kind: 'backfill' });
    const row = store.db.prepare("SELECT first_observed_final_at FROM events WHERE id = 'nfl:espn:401872953'").get() as { first_observed_final_at: string | null };
    expect(row.first_observed_final_at).toBeNull();
  });

  it('diagnostic events never leak into the personalized snapshot', async () => {
    const store = new Store(':memory:');
    await run(store, { cohort: 'diagnostic' });
    const snap = buildSnapshot(store, prefs, sources, AFTER_CUTOFF);
    expect(snap.items.map((i) => i.neutralTitle).sort()).toEqual(['Arizona Cardinals at San Francisco 49ers', 'Los Angeles Chargers at Buffalo Bills']);
    expect(buildReport(store, 'personal').eligibleEvents).toBe(0);
  });

  it('snapshot carries no raw titles, scores, or thumbnails, and never claims TV playback', async () => {
    const store = new Store(':memory:');
    await run(store);
    const snap = buildSnapshot(store, prefs, sources, AFTER_CUTOFF);
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/Game Highlights|thumbnail|score/i);
    expect(snap.items.every((i) => i.targetDevicePlayback === 'NOT_TESTED' && i.metadataEligible)).toBe(true);
    store.recordPlayback({ videoId: 'v__pg6qIYL4', at: AFTER_CUTOFF, environment: 'browser', region: 'US', status: 'VERIFIED' });
    expect(buildSnapshot(store, prefs, sources, AFTER_CUTOFF).items.every((i) => i.targetDevicePlayback === 'NOT_TESTED')).toBe(true);
  });

  it('an incomplete scan (quota exhausted) never marks events UNAVAILABLE', async () => {
    const store = new Store(':memory:');
    const quota = overriding(w3Transport(), (u) => (u.hostname === 'www.googleapis.com' ? { status: 403, body: { error: { errors: [{ reason: 'quotaExceeded' }] } } } : undefined));
    const r = await run(store, { transport: quota });
    expect(r.status).toBe('incomplete');
    expect(r.outcomes.map((o) => o.discovery)).toEqual(['SEARCHING', 'SEARCHING']);
    expect(buildReport(store, 'personal').incompleteOnly).toBe(2);
    expect(quotaExhausted(store, AFTER_CUTOFF)).toMatchObject({ source: 'discover:nfl' }); // the rest of the day skips YouTube work
  });

  it('a failed ESPN fetch is a failed run, not a zero-event success', async () => {
    const store = new Store(':memory:');
    const down = overriding(w3Transport(), (u) => (u.hostname.includes('espn') ? { status: 400, body: {} } : undefined));
    const r = await run(store, { transport: down });
    expect(r.status).toBe('failed');
    expect(buildReport(store, 'personal').runs.failed).toBe(1);
  });

  it('no trusted source leaves events pending rather than unavailable', async () => {
    const store = new Store(':memory:');
    const r = await run(store, { sources: sources.map((s) => ({ ...s, enabled: false })) });
    expect(r.status).toBe('incomplete');
    expect(r.outcomes.every((o) => o.discovery === 'SEARCHING')).toBe(true);
  });

  it('a complete scan with no match after the cutoff is UNAVAILABLE; a removed primary drops out', async () => {
    const store = new Store(':memory:');
    await run(store);
    const r = await run(store, { transport: withoutVideo('v__pg6qIYL4') });
    const buf = r.outcomes.find((o) => nfl(o).home.abbr === 'BUF')!;
    expect(buf.discovery).toBe('UNAVAILABLE');
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM highlights WHERE event_id = 'nfl:espn:401872953'").get()).toEqual({ n: 0 });
    expect(buildSnapshot(store, prefs, sources, AFTER_CUTOFF).items.map((i) => i.video.videoId)).toEqual(['7ngu-tT0PQs']);
  });

  it('before the cutoff, a missing highlight stays SEARCHING', async () => {
    const store = new Store(':memory:');
    const r = await run(store, { transport: withoutVideo('v__pg6qIYL4'), now: '2026-09-28T12:00:00.000Z' });
    expect(r.outcomes.find((o) => nfl(o).home.abbr === 'BUF')!.discovery).toBe('SEARCHING');
  });

  it('rejects videos from an unregistered channel even when titles match', async () => {
    const store = new Store(':memory:');
    const impostor = fixtureTransport(W3, (v) => (v.id === '7ngu-tT0PQs' ? { ...v, snippet: { ...v.snippet, channelId: 'UCimpostorimpostorimpos' } } : v));
    const r = await run(store, { transport: impostor });
    const sf = r.outcomes.find((o) => nfl(o).home.abbr === 'SF')!;
    expect(sf.discovery).not.toBe('FOUND');
    expect(sf.ineligibleReasons).toContain('channel_mismatch');
  });
});

it('loads the committed config files', () => {
  expect(loadPreferences(root).sports.nfl?.teams.map((t) => t.abbr)).toEqual(['SF', 'BUF']);
  expect(sources.filter((s) => s.enabled).map((s) => s.id)).toEqual(['nfl-youtube', 'f1-youtube', 'nbcsports-youtube', 'espnfc-youtube', 'atptour-youtube', 'willow-youtube']);
  expect(sources.filter((s) => s.enabled).every((s) => s.verification.status === 'verified')).toBe(true);
  expect(path.basename(root)).toBeTruthy();
});
