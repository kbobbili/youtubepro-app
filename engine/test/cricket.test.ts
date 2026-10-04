import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cricketAdapter, parseCricketTitle } from '../src/adapters/cricket/index.ts';
import { loadSources, repoRoot, type Preferences } from '../src/config.ts';
import type { SportEvent } from '../src/domain.ts';
import { discover } from '../src/pipeline.ts';
import { screenTitle } from '../src/spoilers.ts';
import { Store } from '../src/store.ts';
import { YouTubeClient } from '../src/youtube/client.ts';
import { FIXTURES, fixtureTransport } from './helpers.ts';

const SEP = path.join(FIXTURES, 'cricket-2026-sep');
const team = (id: string, name: string, priority: 'must' | 'normal' = 'normal') => ({ id, name, priority });
const prefs: Preferences = {
  region: 'US',
  sports: {
    cricket: {
      enabled: true, formats: ['ODI', 'T20I'], includeIcc: true,
      teams: [team('6', 'India', 'must'), team('2', 'Australia'), team('1', 'England'), team('3', 'South Africa'), team('5', 'New Zealand'), team('7', 'Pakistan'), team('8', 'Sri Lanka'), team('4', 'West Indies')],
    },
  },
};

const odi = (over: Partial<SportEvent> = {}, meta: SportEvent['meta'] = {}): SportEvent => ({
  id: 'cricket:espn:1525656', sport: 'cricket', competition: 'Australia tour of South Africa 2026/27', competitionId: 'series:24203', provider: 'espn',
  providerEventId: '1525656', season: 2026, startTime: '2026-09-27T08:00:00.000Z', status: 'COMPLETED', providerStatus: 'Result', stage: '2nd ODI',
  participants: [{ id: '3', name: 'South Africa', shortName: 'SA', role: 'home' }, { id: '2', name: 'Australia', shortName: 'AUS', role: 'away' }],
  meta: { format: 'ODI', matchNumber: 2, seriesId: '24203', icc: false, ...meta }, ...over,
});
const input = { videoId: 'v', title: 't', publishedAt: '2026-09-27T20:00:00Z', durationSeconds: 353 };

describe('Willow titles (observed 2026-10-03)', () => {
  it.each([
    ['Highlights: 2nd ODI, South Africa vs Australia | SA vs AUS', 2, 'ODI'],
    ['Highlights : 3rd T20I, Afghanistan vs India | IND vs AFG', 3, 'T20I'],
    ['Highlights: 3rd T20I - England vs Sri Lanka | ENG vs SL', 3, 'T20I'],
    ['Highlights: 1st ODI India vs West Indies | 1st ODI -  IND vs WI', 1, 'ODI'],
    // Board formats (ECB): sponsor words between number and format; "IT20" = T20I.
    ['Thrilling Finish! | Highlights - England v Sri Lanka | 2nd Metro Bank ODI 2026', 2, 'ODI'],
    ['Buttler Leads The Way! | Highlights - England v Sri Lanka | 3rd Vitality IT20 2026', 3, 'T20I'],
    ['Highlights | West Indies v India | Final Ball Finish | 1st CG United ODI', 1, 'ODI'],
  ])('parses %s', (title, matchNumber, format) => expect(parseCricketTitle(title)).toMatchObject({ matchNumber, format }));

  it.each([
    'Day 4 Highlights: 3rd Test - England vs Pakistan | Day 4, 3rd Test - ENG vs PAK',
    'Highlights: 35th Match, Barbados Tridents vs Guyana Amazon Warriors',
    'Highlights: Final - Trinbago Knight Riders Women vs Guyana Amazon Warriors Women',
    'Japan run India close | Match Highlights',
    'Highlights: 3rd ODI, South Africa Women vs Australia Women',
  ])('ignores Tests, leagues, women\'s fixtures and other formats: %s', (title) => expect(parseCricketTitle(title)).toBeUndefined());

  it('flags result language (ICC-style) while Willow titles pass', () => {
    expect(screenTitle('Japan run India close | Match Highlights', 'cricket').status).toBe('flagged');
    expect(screenTitle('India seal series with 7-wicket win', 'cricket').status).toBe('flagged');
    expect(screenTitle('Highlights: 2nd ODI, South Africa vs Australia | SA vs AUS', 'cricket').status).toBe('unflagged');
  });
});

describe('cricket matching', () => {
  const p = parseCricketTitle('Highlights: 2nd ODI, South Africa vs Australia | SA vs AUS')!;
  it('matches board titles with hype and sponsor words around the teams', () => {
    const eng = odi({ participants: [{ id: '1', name: 'England', shortName: 'ENG', abbr: 'ENG', role: 'home' }, { id: '8', name: 'Sri Lanka', shortName: 'SL', abbr: 'SL', role: 'away' }] });
    expect(cricketAdapter.match(eng, parseCricketTitle('Thrilling Finish! | Highlights - England v Sri Lanka | 2nd Metro Bank ODI 2026')!, input).matched).toBe(true);
    expect(cricketAdapter.sourceCompetition({ ...eng, meta: { ...eng.meta, country: 'England' } })).toEqual(['series:24203', 'host:England', 'team:1', 'team:8']);
  });

  it('matches format, match number and both nations in either order', () => {
    // No order bonus: Willow lists India's home series as "Afghanistan vs India", so title order is not evidence.
    expect(cricketAdapter.match(odi(), p, input)).toEqual({ matched: true, confidence: 0.9, flags: [] });
    expect(cricketAdapter.match(odi(), parseCricketTitle('Highlights: 2nd ODI, Australia vs South Africa')!, input).matched).toBe(true);
  });
  it.each([
    ['another match in the series', odi({}, { matchNumber: 3 }), p, 'match_number_differs'],
    ['another format', odi({}, { format: 'T20I' }), p, 'format_differs'],
    ['the A teams', odi(), parseCricketTitle('Highlights: 2nd ODI, South Africa A vs Australia A')!, 'teams_differ'],
  ])('rejects %s', (_l, e, parsed, reason) => expect(cricketAdapter.match(e, parsed, input).rejectionReason).toBe(reason));
  it('follows men\'s ODI/T20I of followed nations, and respects the ICC switch', () => {
    expect(cricketAdapter.follow(odi(), prefs)).toEqual({ followed: true, priority: 1 });
    expect(cricketAdapter.follow(odi({ participants: [{ id: '6', name: 'India', shortName: 'IND', role: 'home' }, { id: '4', name: 'West Indies', shortName: 'WI', role: 'away' }] }), prefs).priority).toBe(3);
    const icc = odi({}, { icc: true });
    expect(cricketAdapter.follow(icc, { ...prefs, sports: { cricket: { ...prefs.sports.cricket!, includeIcc: false } } }).followed).toBe(false);
  });
});

describe('cricket discovery (recorded Sep 10–Oct 3 fixtures)', () => {
  it('finds Willow highlights for covered series and reports uncovered series as unavailable', async () => {
    const store = new Store(':memory:');
    const t = fixtureTransport(SEP);
    const r = await discover({
      adapter: cricketAdapter, store, eventsTransport: t, youtube: new YouTubeClient(t, 'test'), sources: loadSources(repoRoot()), prefs,
      window: { start: '2026-09-10T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' }, cohort: 'personal', kind: 'backfill', runId: 'cr', now: () => '2026-10-04T13:14:00.000Z',
    });
    expect(r.status).toBe('ok');
    const found = r.outcomes.filter((o) => o.discovery === 'FOUND').map((o) => `${o.event.stage} ${cricketAdapter.neutralTitle(o.event)}`);
    expect(found).toEqual([
      '1st T20I India vs Afghanistan', '2nd T20I India vs Afghanistan', '1st T20I England vs Sri Lanka', '3rd T20I India vs Afghanistan',
      '2nd T20I England vs Sri Lanka', '3rd T20I England vs Sri Lanka', '1st ODI England vs Sri Lanka', '1st ODI South Africa vs Australia',
      '2nd ODI England vs Sri Lanka', '2nd ODI South Africa vs Australia', '1st ODI India vs West Indies', '3rd ODI England vs Sri Lanka',
      '2nd ODI India vs West Indies',
    ]);
    // The home board (ECB, ~15 min) is preferred over Willow (~5.5 min) and also covers matches Willow skipped.
    const england = r.outcomes.filter((o) => o.event.meta.country === 'England' && o.primary);
    expect(england).toHaveLength(6);
    expect(england.every((o) => store.db.prepare('SELECT source_id FROM highlights WHERE event_id = ?').get(o.event.id)!.source_id === 'ecb-youtube')).toBe(true);
    const uncovered = r.outcomes.filter((o) => o.ineligibleReasons.some((x) => x.startsWith('no_trusted_source:series:')));
    expect(uncovered.map((o) => o.event.competition)).toContain('Australia tour of Zimbabwe 2026');
    expect(r.outcomes.every((o) => o.event.meta.format === 'ODI' || o.event.meta.format === 'T20I')).toBe(true);
  });
});
