import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeRound, parseTennisTitle, tennisAdapter } from '../src/adapters/tennis/index.ts';
import { buildCatalog } from '../src/catalog.ts';
import { loadCollections, loadSources, repoRoot, type Collection, type Preferences } from '../src/config.ts';
import type { SportEvent } from '../src/domain.ts';
import type { Transport } from '../src/http.ts';
import { discover } from '../src/pipeline.ts';
import { SCREENING_VERSION, screenTitle, titleFingerprint } from '../src/spoilers.ts';
import { Store } from '../src/store.ts';
import { YouTubeClient } from '../src/youtube/client.ts';
import { FIXTURES, fixtureTransport, overriding } from './helpers.ts';

const OCT = path.join(FIXTURES, 'tennis-2026-oct');
const prefs: Preferences = { region: 'US', sports: { tennis: { enabled: true, tour: 'atp', rankThreshold: 30, maxRankingAgeDays: 10, priority: 'normal' } } };

const m = (over: Partial<SportEvent> = {}, meta: SportEvent['meta'] = {}): SportEvent => ({
  id: 'tennis:espn:183373', sport: 'tennis', competition: 'ATP Hangzhou', competitionId: 'atp', provider: 'espn', providerEventId: '183373',
  season: 2026, startTime: '2026-09-27T09:00:00.000Z', status: 'COMPLETED', providerStatus: 'STATUS_FINAL', stage: 'Quarterfinal',
  participants: [
    { id: '2383', name: 'Daniil Medvedev', shortName: 'D. Medvedev', role: 'competitor' },
    { id: '11000', name: 'Chak Lam Coleman Wong', shortName: 'C. Wong', role: 'competitor' },
  ],
  meta: { city: 'Hangzhou', major: false, rankingStatus: 'ok', rankingSnapshot: 's', rankA: 6, rankB: null, ...meta }, ...over,
});
const input = { videoId: 'v', title: 't', publishedAt: '2026-09-27T15:21:00Z', durationSeconds: 137 };

describe('ATP Tour titles (observed 2026-10-03)', () => {
  it.each([
    ['Carlos Alcaraz vs Matteo Arnaldi Highlights | Tokyo 2026 Round 2', { a: 'Carlos Alcaraz', b: 'Matteo Arnaldi', city: 'Tokyo', year: 2026, round: 'round 2' }],
    ['Novak Djokovic vs Yunchaokete Bu  Highlights | Beijing Round 2', { a: 'Novak Djokovic', b: 'Yunchaokete Bu', city: 'Beijing', round: 'round 2' }],
    ['Daniil Medvedev vs Coleman Wong Highlights | Hangzhou Open 2026 QF', { a: 'Daniil Medvedev', b: 'Coleman Wong', city: 'Hangzhou Open', year: 2026, round: 'qf' }],
    ['Hugo Gaston vs Andrey Rublev Highlights | Hangzhou 2026 Quarter-Final', { a: 'Hugo Gaston', b: 'Andrey Rublev', city: 'Hangzhou', year: 2026, round: 'qf' }],
    ['Hubert Hurkacz vs Alejandro Davidovich Fokina Highlights | Chengdu 2026 Final', { a: 'Hubert Hurkacz', b: 'Alejandro Davidovich Fokina', city: 'Chengdu', year: 2026, round: 'f' }],
  ])('parses %s', (title, parsed) => expect(parseTennisTitle(title)).toEqual(parsed));

  it.each([
    'Djokovic vs Borges Beijing R1 Highlights 🤩 #ChinaOpen',
    'Jakub Mensik vs Brandon Nakashima Highlights | Laver Cup 2026 Day 1',
    'Sinner Continues Title Defence In Beijing | Highlights',
  ])('ignores non-match formats: %s', (title) => expect(parseTennisTitle(title)).toBeUndefined());

  it('normalizes ESPN and title round names to one form', () => {
    expect(['Quarterfinal', 'Quarter-Final', 'QF'].map(normalizeRound)).toEqual(['qf', 'qf', 'qf']);
    expect(['Round 2', 'R2'].map(normalizeRound)).toEqual(['round 2', 'round 2']);
  });

  it('flags result language; plain titles pass (name order is a separate, undetectable leak)', () => {
    expect(screenTitle('Sinner Continues Title Defence In Beijing', 'tennis').status).toBe('flagged');
    expect(screenTitle('Alcaraz saves match points to reach the final', 'tennis').status).toBe('flagged');
    expect(screenTitle('Carlos Alcaraz vs Matteo Arnaldi Highlights | Tokyo 2026 Round 2', 'tennis').status).toBe('unflagged');
  });
});

describe('tennis identity matching', () => {
  const p = parseTennisTitle('Daniil Medvedev vs Coleman Wong Highlights | Hangzhou Open 2026 QF')!;
  it('resolves a shortened name, a tournament-style city and an abbreviated round', () => {
    expect(tennisAdapter.match(m(), p, input)).toEqual({ matched: true, confidence: 1, flags: [] });
  });
  it.each([
    ['a shared surname with another player', parseTennisTitle('Daniil Medvedev vs Juan Manuel Wong Highlights | Hangzhou 2026 QF')!, 'players_differ'],
    ['a surname-only reference', parseTennisTitle('Medvedev vs Wong Highlights | Hangzhou 2026 QF')!, 'players_differ'],
    ['the same matchup at another tournament', parseTennisTitle('Daniil Medvedev vs Coleman Wong Highlights | Beijing 2026 QF')!, 'tournament_differs'],
    ['the same matchup in another round', parseTennisTitle('Daniil Medvedev vs Coleman Wong Highlights | Hangzhou 2026 Final')!, 'round_differs'],
    ['another season', parseTennisTitle('Daniil Medvedev vs Coleman Wong Highlights | Hangzhou 2025 QF')!, 'season_differs'],
  ])('rejects %s', (_l, parsed, reason) => expect(tennisAdapter.match(m(), parsed, input).rejectionReason).toBe(reason));
  it('accepts ~2-minute ATP packages but not sub-minute clips', () => {
    expect(tennisAdapter.match(m(), p, { ...input, durationSeconds: 101 }).matched).toBe(true);
    expect(tennisAdapter.match(m(), p, { ...input, durationSeconds: 45 }).rejectionReason).toBe('too_short');
  });
});

describe('tennis eligibility (rankings policy)', () => {
  it('follows when either player is within the threshold; one confirmed Top-30 player is enough', () => {
    expect(tennisAdapter.follow(m(), prefs)).toMatchObject({ followed: true, priority: 1 });
  });
  it('a known rank outside the threshold is not followed (not unknown)', () => {
    expect(tennisAdapter.follow(m({}, { rankA: 45, rankB: null }), prefs)).toMatchObject({ followed: false });
    expect(tennisAdapter.follow(m({}, { rankA: 45, rankB: null }), prefs).unknown).toBeUndefined();
  });
  it('a missing or stale snapshot is unknown, and TBD participants are pending', () => {
    expect(tennisAdapter.follow(m({}, { rankingStatus: 'unknown' }), prefs)).toMatchObject({ followed: false, unknown: true });
    const tbd = m({ participants: [{ id: 'TBD', name: 'TBD', shortName: 'TBD', role: 'competitor' }, { id: '2383', name: 'Daniil Medvedev', shortName: 'D. Medvedev', role: 'competitor' }] });
    expect(tennisAdapter.follow(tbd, prefs)).toMatchObject({ followed: false, pending: true });
  });
});

describe('tennis discovery (recorded Sep 26–Oct 3 fixtures)', () => {
  const run = (store: Store, t: Transport, now = '2026-10-04T00:58:00.000Z') =>
    discover({
      adapter: tennisAdapter, store, eventsTransport: t, youtube: new YouTubeClient(t, 'test'), sources: loadSources(repoRoot()), prefs,
      window: { start: '2026-09-26T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' }, cohort: 'personal', kind: 'backfill', runId: `t-${now}`, now: () => now,
    });

  it('tracks Top-30 matches and finds their ATP Tour highlights', async () => {
    const store = new Store(':memory:');
    const r = await run(store, fixtureTransport(OCT));
    expect(r.status).toBe('ok');
    const by = (s: string) => r.outcomes.filter((o) => o.discovery === s).length;
    expect({ tracked: r.outcomes.length, found: by('FOUND'), unavailable: by('UNAVAILABLE'), searching: by('SEARCHING') }).toEqual({ tracked: 45, found: 35, unavailable: 1, searching: 9 });
    const wong = r.outcomes.find((o) => o.event.providerEventId === '183373')!;
    expect(wong.primary?.videoId).toBe('QstPIQhG8Zc');
    expect(store.latestRankingSnapshot('atp')?.complete).toBe(true);
    // Per-run eligibility decisions are recorded with the ranks they used.
    expect(store.db.prepare("SELECT reason FROM run_events WHERE event_id = 'tennis:espn:183373'").get()).toEqual({ reason: expect.stringMatching(/^ranks \d+\//) });
  });

  it('a stale rankings snapshot makes eligibility unknown and the run incomplete, never zero matches', async () => {
    const store = new Store(':memory:');
    const stale = overriding(fixtureTransport(OCT), async (u) => {
      if (!u.pathname.includes('/weeks/')) return undefined;
      const res = await fixtureTransport(OCT)(u);
      return { status: 200, body: { ...(res.body as object), lastUpdated: '2026-08-01T07:00Z' } };
    });
    const r = await run(store, stale);
    expect(r.status).toBe('incomplete');
    expect(r.outcomes).toHaveLength(0);
    expect(r.issues.map((i) => i.stage)).toContain('eligibility');
  });

  it('a rankings outage falls back to a stored snapshot only while it is still fresh, and says so', async () => {
    const store = new Store(':memory:');
    await run(store, fixtureTransport(OCT));
    const down = overriding(fixtureTransport(OCT), (u) => (u.hostname === 'sports.core.api.espn.com' ? { status: 503, body: null } : undefined));
    const ok = await run(store, down, '2026-10-04T02:00:00.000Z');
    expect(ok.status).toBe('ok');
    expect(ok.notes[0]).toMatch(/using cached snapshot/);
    const later = await run(store, down, '2026-10-20T02:00:00.000Z');
    expect(later.status).toBe('incomplete');
  });
});

describe('tennis playlist rule: current tournaments, later rounds', () => {
  const NOW = '2026-10-10T12:00:00.000Z';
  const ago = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();
  let n = 0;
  function seed(store: Store, o: { tournament: string; major?: boolean; stage: string; start: string }) {
    const id = `tennis:espn:${++n}`;
    const videoId = `t${n}`;
    store.upsertEvent(
      m({ id, providerEventId: String(n), startTime: o.start, stage: o.stage, competition: `ATP ${o.tournament}` }, { tournamentId: o.tournament, city: o.tournament, major: !!o.major }),
      o.start, false,
    );
    store.setDiscovery(id, 'FOUND', o.start);
    store.upsertCandidate({ eventId: id, videoId, sourceId: 'atptour-youtube', channelId: 'UCY_5h5zaSwN7Or4kIJDYNXA', rawTitle: 'A vs B Highlights | X 2026 QF', publishedAt: o.start, durationSeconds: 140, confidence: 1, flags: [], metadataEligible: true, metadataReasons: [] }, o.start);
    store.selectPrimary(id, o.start);
    store.recordVideoCheck({ videoId, checkedAt: NOW, available: true, channelId: 'UCY_5h5zaSwN7Or4kIJDYNXA', title: 'A vs B Highlights | X 2026 QF', titleFingerprint: titleFingerprint('A vs B Highlights | X 2026 QF'), screenReasons: [] });
    store.recordTitleScreen({ videoId, titleFingerprint: titleFingerprint('A vs B Highlights | X 2026 QF'), version: SCREENING_VERSION, status: 'unflagged', reasons: [], at: NOW });
    return videoId;
  }

  it('keeps QF onward of tournaments active in the last 7 days, and R16 onward at Grand Slams', () => {
    const store = new Store(':memory:');
    store.startRun({ id: 'r', sport: 'tennis', cohort: 'personal', kind: 'prospective', startedAt: NOW, window: { start: ago(7), end: NOW }, config: {} });
    store.finishRun('r', NOW, 'ok', [], {});
    const recentR2 = seed(store, { tournament: 'Tokyo', stage: 'Round 2', start: ago(6) });
    const recentQf = seed(store, { tournament: 'Tokyo', stage: 'Quarterfinal', start: ago(5) });
    const recentF = seed(store, { tournament: 'Tokyo', stage: 'Final', start: ago(3) });
    seed(store, { tournament: 'Chengdu', stage: 'Final', start: ago(10) }); // finished 10 days ago
    const slamR4 = seed(store, { tournament: 'US Open', major: true, stage: 'Round 4', start: ago(1) });
    const slamR3 = seed(store, { tournament: 'US Open', major: true, stage: 'Round 3', start: ago(2) });
    const tennisCol: Collection = { id: 'tennis', title: 'Tennis', kind: 'sport', sport: 'tennis', keep: { tournaments: { finishedWithinDays: 7, fromStage: 'qf', majorsFromStage: 'r16' } }, publish: true };
    const c = buildCatalog(store, { prefs, sources: loadSources(repoRoot()), collections: { publishing: loadCollections(repoRoot()).publishing, collections: [tennisCol] }, now: NOW, configRevision: 't' });
    const items = c.collections[0]!.items.map((i) => i.video.videoId);
    expect(items).toEqual([slamR4, recentF, recentQf]); // newest upload first
    expect(items).not.toContain(recentR2);
    expect(items).not.toContain(slamR3);
  });
});
