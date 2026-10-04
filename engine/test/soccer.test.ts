import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSoccerTitle, soccerAdapter } from '../src/adapters/soccer/index.ts';
import { loadSources, repoRoot, type Preferences } from '../src/config.ts';
import type { SportEvent } from '../src/domain.ts';
import { discover } from '../src/pipeline.ts';
import { screenTitle } from '../src/spoilers.ts';
import { Store } from '../src/store.ts';
import { YouTubeClient } from '../src/youtube/client.ts';
import { FIXTURES, fixtureTransport } from './helpers.ts';

const SEP = path.join(FIXTURES, 'soccer-2026-sep');
const prefs: Preferences = {
  region: 'US',
  sports: { soccer: { enabled: true, teams: [{ id: '359', name: 'Arsenal', priority: 'high' }, { id: '86', name: 'Real Madrid', priority: 'high' }] } },
};

const match = (over: Partial<SportEvent> = {}): SportEvent => ({
  id: 'soccer:espn:401879274', sport: 'soccer', competition: 'Premier League', competitionId: 'eng.1', provider: 'espn', providerEventId: '401879274',
  season: 2026, startTime: '2026-09-19T14:00:00.000Z', status: 'COMPLETED', providerStatus: 'STATUS_FULL_TIME', stage: null,
  participants: [
    { id: '331', name: 'Brighton & Hove Albion', shortName: 'Brighton', abbr: 'BHA', role: 'home' },
    { id: '359', name: 'Arsenal', shortName: 'Arsenal', abbr: 'ARS', role: 'away' },
  ],
  meta: {}, ...over,
});
const input = { videoId: 'v', title: 't', publishedAt: '2026-09-19T17:00:00Z', durationSeconds: 824 };
const NBC = 'Brighton v. Arsenal | PREMIER LEAGUE HIGHLIGHTS | 9/19/2026 | NBC Sports';

describe('soccer titles (observed 2026-10-03)', () => {
  it.each([
    [NBC, { left: 'Brighton', right: 'Arsenal', competitionId: 'eng.1', date: '9/19/2026' }],
    ['Elche vs. Real Madrid | LALIGA Highlights | ESPN FC', { left: 'Elche', right: 'Real Madrid', competitionId: 'esp.1' }],
    ['INTENSE MADRID DERBY 🍿 Atletico Madrid vs. Real Madrid | LALIGA Highlights | ESPN FC', { left: 'INTENSE MADRID DERBY 🍿 Atletico Madrid', right: 'Real Madrid', competitionId: 'esp.1' }],
  ])('parses %s', (title, parsed) => expect(parseSoccerTitle(title)).toEqual(parsed));

  it.each([
    'Pascal Gross fires Brighton into the lead over Arsenal | Premier League | NBC Sports',
    'Top 10 Premier League goals of September 2026 | NBC Sports',
    'Brighton soar past Arsenal; Spurs continue poor form | Premier League Update | NBC Sports',
    'AC Milan v. Lecce (En Español) | SERIE A HIGHLIGHTS | 9/20/26 | NBC Sports',
    'Real Madrid vs. Atlético Madrid EXTENDED HIGHLIGHTS [March 22, 2026] | ESPN FC',
    'Columbus Crew vs. Inter Miami | MLS Highlights | ESPN FC',
    'Wolves vs West Brom: Extended Highlights | EFL Championship | CBS Sports Golazo',
  ])('ignores non-highlight or out-of-scope uploads: %s', (title) => expect(parseSoccerTitle(title)).toBeUndefined());

  it('flags broadcaster hype that hints at results', () => {
    expect(screenTitle('LATE DRAMA 🤯 Real Betis vs. Real Madrid | LALIGA Highlights | ESPN FC', 'soccer').status).toBe('flagged');
    expect(screenTitle('LATE WINNER 👀 Columbus Crew vs. Inter Miami | MLS Highlights | ESPN FC', 'soccer').status).toBe('flagged');
    expect(screenTitle('2 GOALS FOR LAMINE YAMAL ⚽⚽ Levante vs. Barcelona | LALIGA Highlights | ESPN FC', 'soccer').status).toBe('flagged');
    expect(screenTitle(NBC, 'soccer').status).toBe('unflagged');
    expect(screenTitle('Elche vs. Real Madrid | LALIGA Highlights | ESPN FC', 'soccer').status).toBe('unflagged');
  });
});

describe('soccer matching', () => {
  const nbc = parseSoccerTitle(NBC)!;
  it('matches home-first with the short name and the title date', () => {
    expect(soccerAdapter.match(match(), nbc, input)).toEqual({ matched: true, confidence: 1, flags: [] });
  });
  it('accepts a hype prefix before the home team', () => {
    const derby = match({
      competitionId: 'esp.1', startTime: '2026-09-20T14:15:00.000Z',
      participants: [{ id: '1068', name: 'Atlético Madrid', shortName: 'Atlético', role: 'home' }, { id: '86', name: 'Real Madrid', shortName: 'Real Madrid', role: 'away' }],
    });
    const p = parseSoccerTitle('INTENSE MADRID DERBY 🍿 Atletico Madrid vs. Real Madrid | LALIGA Highlights | ESPN FC')!;
    expect(soccerAdapter.match(derby, p, { ...input, publishedAt: '2026-09-20T16:56:00Z' }).matched).toBe(true);
  });
  it.each([
    ['another competition', match({ competitionId: 'esp.1' }), nbc, 'competition_differs'],
    ['another opponent', match({ participants: [{ id: '363', name: 'Chelsea', shortName: 'Chelsea', role: 'home' }, { id: '359', name: 'Arsenal', shortName: 'Arsenal', role: 'away' }] }), nbc, 'teams_differ'],
    ['a different title date (repeat fixture)', match(), parseSoccerTitle('Brighton v. Arsenal | PREMIER LEAGUE HIGHLIGHTS | 2/21/2027 | NBC Sports')!, 'date_differs'],
  ])('rejects %s', (_l, e, p, reason) => expect(soccerAdapter.match(e, p, input).rejectionReason).toBe(reason));
  it('swapped order still matches, flagged', () => {
    const r = soccerAdapter.match(match(), parseSoccerTitle('Arsenal v. Brighton | PREMIER LEAGUE HIGHLIGHTS | 9/19/2026 | NBC Sports')!, input);
    expect(r).toMatchObject({ matched: true, flags: ['home_away_order_swapped'] });
  });
  it('follows matches of followed clubs by ESPN team ID', () => {
    expect(soccerAdapter.follow(match(), prefs)).toEqual({ followed: true, priority: 2 });
    expect(soccerAdapter.follow(match({ participants: [{ id: '1', name: 'A', shortName: 'A', role: 'home' }, { id: '2', name: 'B', shortName: 'B', role: 'away' }] }), prefs).followed).toBe(false);
  });
});

describe('soccer discovery (recorded September 2026 fixtures)', () => {
  it('finds every match with a trusted source and reports the rest as unavailable, not missing', async () => {
    const store = new Store(':memory:');
    const t = fixtureTransport(SEP);
    const r = await discover({
      adapter: soccerAdapter, store, eventsTransport: t, youtube: new YouTubeClient(t, 'test'), sources: loadSources(repoRoot()), prefs,
      window: { start: '2026-09-04T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' }, cohort: 'personal', kind: 'backfill', runId: 'soc', now: () => '2026-10-04T00:53:00.000Z',
    });
    expect(r.status).toBe('ok');
    expect(r.outcomes.map((o) => [soccerAdapter.neutralTitle(o.event), o.discovery, o.primary?.videoId ?? o.ineligibleReasons.join()])).toEqual([
      ['Real Betis vs Real Madrid', 'FOUND', 'Ls7lgDXcZp8'],
      ['Arsenal vs Chelsea', 'FOUND', '9UhwBF261BU'],
      ['Real Madrid vs Internazionale', 'UNAVAILABLE', 'no_trusted_source:uefa.champions'],
      ['Napoli vs Arsenal', 'UNAVAILABLE', 'no_trusted_source:uefa.champions'],
      ['Sunderland vs Arsenal', 'FOUND', 'vH9PRdWxf3Q'],
      ['Real Madrid vs Rayo Vallecano', 'FOUND', 'GtscnZUGLe4'],
      ['Ipswich Town vs Arsenal', 'UNAVAILABLE', 'no_trusted_source:eng.league_cup'],
      ['Elche vs Real Madrid', 'FOUND', '3EhCO20HrB4'],
      ['Brighton & Hove Albion vs Arsenal', 'FOUND', '_dfxDY74ChQ'],
      ['Atlético Madrid vs Real Madrid', 'FOUND', 'bLzrK9H8XLc'],
    ]);
    expect(store.titleScreen('Ls7lgDXcZp8')).toMatchObject({ status: 'flagged' });
  });
});
