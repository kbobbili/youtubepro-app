import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { f1Adapter, gpName, parseF1Title } from '../src/adapters/f1/index.ts';
import { loadSources, repoRoot, type Preferences } from '../src/config.ts';
import type { SportEvent } from '../src/domain.ts';
import { discover } from '../src/pipeline.ts';
import { screenTitle } from '../src/spoilers.ts';
import { Store } from '../src/store.ts';
import { YouTubeClient } from '../src/youtube/client.ts';
import { FIXTURES, fixtureTransport } from './helpers.ts';

const SEP = path.join(FIXTURES, 'f1-2026-sep');
const prefs: Preferences = { region: 'US', sports: { f1: { enabled: true, sessions: ['race'], priority: 'normal' } } };

const race = (over: Partial<SportEvent> = {}): SportEvent => ({
  id: 'f1:espn:401839112', sport: 'f1', competition: 'Formula 1', competitionId: 'F1', provider: 'espn', providerEventId: '401839112',
  season: 2026, startTime: '2026-09-26T11:00:00.000Z', status: 'COMPLETED', providerStatus: 'STATUS_FINAL', stage: 'Race', participants: [],
  meta: { gp: 'Azerbaijan Grand Prix', espnName: 'Qatar Airways Azerbaijan Grand Prix' }, ...over,
});
const input = { videoId: 'v', title: 't', publishedAt: '2026-09-26T13:30:09Z', durationSeconds: 487 };

describe('F1 names and titles (observed 2026-10-03)', () => {
  it.each([
    ['Pirelli Italian Grand Prix', 'Italian Grand Prix'],
    ['Tag Heuer Spanish Grand Prix', 'Spanish Grand Prix'],
    ['Qatar Airways Azerbaijan Grand Prix', 'Azerbaijan Grand Prix'],
    ['Gulf Air Bahrain Grand Prix in Malaysia', 'Bahrain Grand Prix in Malaysia'],
    ['Singapore Airlines Singapore Grand Prix', 'Singapore Grand Prix'],
    ['Formula 1 Crypto.com Miami Grand Prix', 'Miami Grand Prix'],
  ])('strips sponsors: %s → %s', (espn, neutral) => expect(gpName(espn)).toBe(neutral));

  it.each([
    ['Race Highlights | 2026 Azerbaijan Grand Prix', { year: 2026, gp: 'Azerbaijan Grand Prix' }],
    ['Race Highlights | Bahrain Grand Prix In Malaysia', { gp: 'Bahrain Grand Prix In Malaysia' }],
  ])('parses real race titles: %s', (title, parsed) => expect(parseF1Title(title)).toEqual(parsed));

  it.each([
    'F2 Feature Race 2 Highlights | 2026 Azerbaijan Grand Prix',
    'A Champion CROWNED! F3 Feature Race 2 Highlights | 2026 Spanish Grand Prix',
    'Qualifying Highlights | 2026 Azerbaijan Grand Prix',
    'FP1 Highlights | 2026 Bahrain Grand Prix In Malaysia',
    'Sprint Highlights | 2026 Dutch Grand Prix',
    'Extended Highlights | 2012 Malaysian Grand Prix',
  ])('rejects non-race uploads: %s', (title) => expect(parseF1Title(title)).toBeUndefined());

  it('race titles pass the spoiler screen; result-style titles do not', () => {
    expect(screenTitle('Race Highlights | 2026 Azerbaijan Grand Prix', 'f1').status).toBe('unflagged');
    expect(screenTitle('Verstappen WINS in Baku! | 2026 Azerbaijan Grand Prix', 'f1').status).toBe('flagged');
  });
});

describe('F1 matching', () => {
  const parsed = parseF1Title('Race Highlights | 2026 Azerbaijan Grand Prix')!;
  it('matches the right Grand Prix with full confidence', () => {
    expect(f1Adapter.match(race(), parsed, input)).toEqual({ matched: true, confidence: 1, flags: [] });
  });
  it.each([
    ['another Grand Prix', race({ meta: { gp: 'Spanish Grand Prix' } }), input, 'grand_prix_differs'],
    ['another season', race({ season: 2025 }), input, 'season_differs'],
    ['published before the race', race(), { ...input, publishedAt: '2026-09-26T10:00:00Z' }, 'published_before_event'],
    ['a short clip', race(), { ...input, durationSeconds: 59 }, 'too_short'],
    ['an upload days later (archive)', race(), { ...input, publishedAt: '2026-10-02T00:00:00Z' }, 'published_too_late'],
  ])('rejects %s', (_l, e, i, reason) => expect(f1Adapter.match(e, parsed, i).rejectionReason).toBe(reason));
  it('a missing year still matches, flagged', () => {
    const r = f1Adapter.match(race({ meta: { gp: 'Bahrain Grand Prix in Malaysia' } }), parseF1Title('Race Highlights | Bahrain Grand Prix In Malaysia')!, input);
    expect(r).toMatchObject({ matched: true, flags: ['year_missing_in_title'] });
  });
  it('follows races only when F1 is enabled', () => {
    expect(f1Adapter.follow(race(), prefs).followed).toBe(true);
    expect(f1Adapter.follow(race(), { region: 'US', sports: {} }).followed).toBe(false);
  });
});

describe('F1 discovery (recorded September 2026 fixtures)', () => {
  it('finds all three race highlights from the official channel and nothing else', async () => {
    const store = new Store(':memory:');
    const t = fixtureTransport(SEP);
    const r = await discover({
      adapter: f1Adapter, store, eventsTransport: t, youtube: new YouTubeClient(t, 'test'), sources: loadSources(repoRoot()), prefs,
      window: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' }, cohort: 'personal', kind: 'backfill', runId: 'f1', now: () => '2026-10-04T00:48:00.000Z',
    });
    expect(r.status).toBe('ok');
    expect(r.outcomes.map((o) => [f1Adapter.neutralTitle(o.event), o.discovery, o.primary?.videoId])).toEqual([
      ['Italian Grand Prix', 'FOUND', 'uptj3to1l7o'],
      ['Spanish Grand Prix', 'FOUND', 'NK7AfP_wi8M'],
      ['Azerbaijan Grand Prix', 'FOUND', 'I9oahfzac0I'],
    ]);
    expect(JSON.stringify(r.outcomes.map((o) => o.event))).not.toMatch(/position|winner|score/i);
  });
});
