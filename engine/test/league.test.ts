import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mlbAdapter, nbaAdapter, parseMlbTitle, parseNbaTitle } from '../src/adapters/league/index.ts';
import { loadSources, repoRoot, type Preferences } from '../src/config.ts';
import type { SportEvent } from '../src/domain.ts';
import { discover } from '../src/pipeline.ts';
import { screenTitle } from '../src/spoilers.ts';
import { Store } from '../src/store.ts';
import { YouTubeClient } from '../src/youtube/client.ts';
import { FIXTURES, fixtureTransport } from './helpers.ts';

const team = (abbr: string, name: string, shortName: string, role: 'home' | 'away') => ({ id: abbr, name, shortName, abbr, role });
const game = (sport: 'nba' | 'mlb', over: Partial<SportEvent>, meta: SportEvent['meta']): SportEvent => ({
  id: `${sport}:espn:1`, sport, competition: sport.toUpperCase(), competitionId: sport.toUpperCase(), provider: 'espn', providerEventId: '1', season: 2026,
  startTime: '2026-10-01T00:00:00.000Z', status: 'COMPLETED', providerStatus: 'STATUS_FINAL', stage: null, participants: [], meta, ...over,
});

describe('MLB titles (observed 2026-10-03)', () => {
  it.each([
    ['DODGERS vs. GIANTS: Official Full Game Highlights (September 27) | 2026 MLB Season', { a: 'DODGERS', b: 'GIANTS', month: 8, day: 27, preseason: false, postseason: false, extended: false }],
    ['RED SOX vs. YANKEES: Wild Card Full Game 2 Highlights (September 30) | 2026 MLB Season', { a: 'RED SOX', b: 'YANKEES', month: 8, day: 30, gameNumber: 2, preseason: false, postseason: true, extended: false }],
    ['PHILLIES vs. BRAVES: Wild Card Game 1 Full Game Highlights (September 29) | 2026 MLB Season', { a: 'PHILLIES', b: 'BRAVES', month: 8, day: 29, gameNumber: 1, preseason: false, postseason: true, extended: false }],
    ['BRAVES vs. DODGERS: NLDS Full Game 1 Highlights (October 3) | 2026 MLB | Shohei Ohtani', { a: 'BRAVES', b: 'DODGERS', month: 9, day: 3, gameNumber: 1, preseason: false, postseason: true, extended: false }],
    ['ORIOLES vs. YANKEES: Official Full Game 2 Highlights (September 25) | 2026 MLB Season', { a: 'ORIOLES', b: 'YANKEES', month: 8, day: 25, gameNumber: 2, preseason: false, postseason: false, extended: false }],
  ])('parses %s', (title, parsed) => expect(parseMlbTitle(title)).toEqual(parsed));

  it.each([
    'Drew Rasmussen DOMINATES the Yankees to take a 1-0 series lead 🔥 (10 strikeouts!) | MLB Highlights',
    'Braves take Wild Card Series in 3 games! PHILLIES vs. BRAVES: Full 2026 Wild Card Series Highlights',
    'RED SOX vs. YANKEES: Full 2026 Wild Card Series Highlights | 2026 MLB Postseason',
    'Highlights from ALL Wild Card Game 2s! (White Sox, Yankees, Padres move on!)',
  ])('ignores clips and series recaps (often with results): %s', (title) => expect(parseMlbTitle(title)).toBeUndefined());

  it('full-game titles pass the spoiler screen', () => {
    expect(screenTitle('RED SOX vs. YANKEES: Wild Card Full Game 2 Highlights (September 30) | 2026 MLB Season', 'mlb').status).toBe('unflagged');
  });
});

describe('MLB matching', () => {
  const yankees = (startTime: string, meta: SportEvent['meta']) =>
    game('mlb', { startTime, participants: [team('NYY', 'New York Yankees', 'Yankees', 'home'), team('BAL', 'Baltimore Orioles', 'Orioles', 'away')] }, meta);
  const input = (publishedAt: string) => ({ videoId: 'v', title: 't', publishedAt, durationSeconds: 700 });
  const g1 = parseMlbTitle('ORIOLES vs. YANKEES: Official Full Game 1 Highlights (September 25) | 2026 MLB Season')!;
  const g2 = parseMlbTitle('ORIOLES vs. YANKEES: Official Full Game 2 Highlights (September 25) | 2026 MLB Season')!;

  it('separates doubleheader games by the game number in the title', () => {
    const first = yankees('2026-09-25T20:05:00.000Z', { seasonType: 'regular', gameNumber: 1 });
    const second = yankees('2026-09-25T23:30:00.000Z', { seasonType: 'regular', gameNumber: 2 });
    expect(mlbAdapter.match(first, g1, input('2026-09-25T23:08:00Z')).matched).toBe(true);
    expect(mlbAdapter.match(first, g2, input('2026-09-26T02:48:00Z')).rejectionReason).toBe('game_number_differs');
    expect(mlbAdapter.match(second, g2, input('2026-09-26T02:48:00Z')).matched).toBe(true);
    const unnumbered = parseMlbTitle('ORIOLES vs. YANKEES: Official Full Game Highlights (September 25) | 2026 MLB Season')!;
    expect(mlbAdapter.match(second, unnumbered, input('2026-09-26T02:48:00Z')).rejectionReason).toBe('doubleheader_game_unspecified');
  });

  it('separates games of a series by date, and regular season from postseason', () => {
    const e = yankees('2026-09-25T23:05:00.000Z', { seasonType: 'regular', gameNumber: null });
    const nextDay = parseMlbTitle('ORIOLES vs. YANKEES: Official Full Game Highlights (September 27) | 2026 MLB Season')!;
    expect(mlbAdapter.match(e, nextDay, input('2026-09-28T02:00:00Z')).rejectionReason).toBe('date_differs');
    const playoff = parseMlbTitle('ORIOLES vs. YANKEES: Wild Card Full Game 1 Highlights (September 25) | 2026 MLB Season')!;
    expect(mlbAdapter.match(e, playoff, input('2026-09-26T02:00:00Z')).rejectionReason).toBe('season_type_differs');
  });

  it('accepts the "D-BACKS" nickname for the Diamondbacks', () => {
    const e = game('mlb', { startTime: '2026-09-19T01:40:00.000Z', participants: [team('ARI', 'Arizona Diamondbacks', 'Diamondbacks', 'home'), team('NYY', 'New York Yankees', 'Yankees', 'away')] }, { seasonType: 'regular', gameNumber: null });
    expect(mlbAdapter.match(e, parseMlbTitle('YANKEES vs. D-BACKS: Official Full Game Highlights (September 18) | 2026 MLB Season')!, input('2026-09-19T05:00:00Z')).matched).toBe(true);
  });
});

describe('NBA titles and matching (observed 2026-10-03)', () => {
  it.each([
    ['HEAT at RAPTORS | NBA PRESEASON FULL GAME HIGHLIGHTS | October 3, 2026', { a: 'HEAT', b: 'RAPTORS', month: 9, day: 3, year: 2026, preseason: true, postseason: false, extended: false }],
    ['#2 SPURS at #1 THUNDER | FULL GAME 7 HIGHLIGHTS | May 30, 2026', { a: 'SPURS', b: 'THUNDER', month: 4, day: 30, year: 2026, gameNumber: 7, preseason: false, postseason: true, extended: false }],
    ['EXTENDED: #3 KNICKS at #2 SPURS | NBA FINALS GAME 5 HIGHLIGHTS | June 13, 2026', { a: 'KNICKS', b: 'SPURS', month: 5, day: 13, year: 2026, gameNumber: 5, preseason: false, postseason: true, extended: true }],
  ])('parses %s', (title, parsed) => expect(parseNbaTitle(title)).toEqual(parsed));

  it.each([
    'WARRIORS vs GRIZZLIES | LAS VEGAS SUMMER LEAGUE CHAMPIONSHIP | FULL GAME HIGHLIGHTS | July 19, 2026',
    'The ICONIC Cavaliers vs. Warriors Game 7 🤯 (10 Years Later) | FULL GAME HIGHLIGHTS',
    "JALEN BRUNSON'S FINALS-SEALING PUSH IN GAME 5 WAS ICONIC 🏆",
  ])('ignores Summer League, throwbacks and clips: %s', (title) => expect(parseNbaTitle(title)).toBeUndefined());

  it('matches a regular-season game by teams and date, but not a preseason title', () => {
    const e = game('nba', { startTime: '2026-10-20T23:30:00.000Z', participants: [team('NY', 'New York Knicks', 'Knicks', 'home'), team('PHI', 'Philadelphia 76ers', '76ers', 'away')] }, { seasonType: 'regular', gameNumber: null });
    const input = { videoId: 'v', title: 't', publishedAt: '2026-10-21T03:00:00Z', durationSeconds: 600 };
    expect(nbaAdapter.match(e, parseNbaTitle('76ERS at KNICKS | FULL GAME HIGHLIGHTS | October 20, 2026')!, input).matched).toBe(true);
    expect(nbaAdapter.match(e, parseNbaTitle('76ERS at KNICKS | NBA PRESEASON FULL GAME HIGHLIGHTS | October 20, 2026')!, input).rejectionReason).toBe('season_type_differs');
  });

  it('follows only the configured season phases', () => {
    const e = game('nba', { participants: [team('NY', 'New York Knicks', 'Knicks', 'home'), team('PHI', 'Philadelphia 76ers', '76ers', 'away')] }, { seasonType: 'preseason', gameNumber: null });
    const prefs = (seasonTypes: ('preseason' | 'regular' | 'postseason')[]): Preferences => ({ region: 'US', sports: { nba: { enabled: true, seasonTypes, teams: [{ abbr: 'NY', name: 'Knicks', priority: 'high' }] } } });
    expect(nbaAdapter.follow(e, prefs(['regular', 'postseason'])).followed).toBe(false);
    expect(nbaAdapter.follow(e, prefs(['preseason'])).followed).toBe(true);
  });
});

describe('league discovery (recorded fixtures)', () => {
  const run = (adapter: typeof mlbAdapter, dir: string, prefs: Preferences, window: { start: string; end: string }) => {
    const t = fixtureTransport(path.join(FIXTURES, dir));
    return discover({ adapter, store: new Store(':memory:'), eventsTransport: t, youtube: new YouTubeClient(t, 'test'), sources: loadSources(repoRoot()), prefs, window, cohort: 'personal', kind: 'backfill', runId: dir, now: () => '2026-10-04T03:00:00.000Z' });
  };

  it('MLB Sep 15–Oct 3: every Yankees, Dodgers and Braves game found, doubleheaders included', async () => {
    const prefs: Preferences = { region: 'US', sports: { mlb: { enabled: true, seasonTypes: ['regular', 'postseason'], teams: [{ abbr: 'NYY', name: 'Yankees', priority: 'high' }, { abbr: 'LAD', name: 'Dodgers', priority: 'high' }, { abbr: 'ATL', name: 'Braves', priority: 'high' }] } } };
    const r = await run(mlbAdapter, 'mlb-2026-sep', prefs, { start: '2026-09-15T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' });
    expect(r.status).toBe('ok');
    expect(r.outcomes).toHaveLength(41);
    expect(r.outcomes.every((o) => o.discovery === 'FOUND')).toBe(true);
    const dh = r.outcomes.filter((o) => o.event.startTime.startsWith('2026-09-25') && o.event.participants.some((p) => p.id === 'BAL'));
    expect(dh.map((o) => o.primary?.videoId)).toEqual(['biODOYSD8Xk', '1zMRqkDtsxg']); // Game 1, Game 2
  });

  it('NBA preseason (recorded with preseason enabled): Heat at Raptors found', async () => {
    const prefs: Preferences = { region: 'US', sports: { nba: { enabled: true, seasonTypes: ['preseason'], teams: [{ abbr: 'MIA', name: 'Heat', priority: 'high' }] } } };
    const r = await run(nbaAdapter, 'nba-2026-pre', prefs, { start: '2026-10-03T00:00:00.000Z', end: '2026-10-04T03:00:00.000Z' });
    expect(r.outcomes.map((o) => [nbaAdapter.neutralTitle(o.event), o.discovery, o.primary?.videoId])).toEqual([['Miami Heat at Toronto Raptors', 'FOUND', 'y8js21UYKz4']]);
  });
});
