import { describe, expect, it } from 'vitest';
import { matchNflCandidate, parseNflHighlightTitle } from '../src/adapters/nfl/matcher.ts';
import type { SportEvent } from '../src/domain.ts';

// Real titles from the official NFL channel, 2026 Week 3–4 (observed 2026-10-02).
const REAL_GAME_TITLES: [string, string, string, number][] = [
  ['Pittsburgh Steelers vs Cleveland Browns Game Highlights | 2026 NFL Season Week 4', 'PIT', 'CLE', 4],
  ['Philadelphia Eagles vs. Chicago Bears Game Highlights | 2026 NFL Season Week 3', 'PHI', 'CHI', 3],
  ['Los Angeles Rams vs Denver Broncos Game Highlights | 2026 NFL Season Week 3', 'LAR', 'DEN', 3],
  ['Baltimore Ravens vs Dallas Cowboys Game Highlights from Rio | 2026 NFL Season Week 3', 'BAL', 'DAL', 3],
  ['Las Vegas Raiders vs. New Orleans Saints Game Highlights | NFL 2026 Season Week 3', 'LV', 'NO', 3],
  ['Minnesota Vikings vs Tampa Bay Buccaneers Game Highlights | 2026 NFL Season Week 3', 'MIN', 'TB', 3],
  ['Arizona Cardinals vs. San Francisco 49ers Game Highlights | NFL 2026 Season Week 3', 'ARI', 'SF', 3],
  ['Houston Texans vs Indianapolis Colts Game Highlights | 2026 NFL Season Week 3', 'HOU', 'IND', 3],
  ['Seattle Seahawks vs Washington Commanders Game Highlights | 2026 NFL Season Week 3', 'SEA', 'WSH', 3],
  ['New England Patriots vs Jacksonville Jaguars Game Highlights | 2026 NFL Season Week 3', 'NE', 'JAX', 3],
  ['Cincinnati Bengals vs. Pittsburgh Steelers Game Highlights | NFL 2026 Season Week 3', 'CIN', 'PIT', 3],
  ['Carolina Panthers vs. Cleveland Browns Game Highlights | NFL 2026 Season Week 3', 'CAR', 'CLE', 3],
  ['Los Angeles Chargers vs. Buffalo Bills Game Highlights | NFL 2026 Season Week 3', 'LAC', 'BUF', 3],
  ['Kansas City Chiefs vs. Miami Dolphins Game Highlights | NFL 2026 Season Week 3', 'KC', 'MIA', 3],
  ['New York Jets vs. Detroit Lions Game Highlights | NFL 2026 Season Week 3', 'NYJ', 'DET', 3],
  ['Tennessee Titans vs. New York Giants Game Highlights | NFL 2026 Season Week 3', 'TEN', 'NYG', 3],
  ['Atlanta Falcons vs Green Bay Packers Game Highlights | 2026 NFL Season Week 3', 'ATL', 'GB', 3],
];

const event = (over: Partial<SportEvent> = {}): SportEvent => ({
  id: 'nfl:espn:401872953', sport: 'nfl', competition: 'NFL', provider: 'espn', providerEventId: '401872953',
  season: 2026, seasonType: 2, week: 3, startTime: '2026-09-27T17:00:00.000Z', status: 'COMPLETED', providerStatus: 'STATUS_FINAL',
  home: { abbr: 'BUF', name: 'Buffalo Bills', shortName: 'Bills' },
  away: { abbr: 'LAC', name: 'Los Angeles Chargers', shortName: 'Chargers' },
  ...over,
});

const parse = (title: string) => {
  const r = parseNflHighlightTitle(title);
  if (!r.ok) throw new Error(`expected parse: ${title} (${r.reason})`);
  return r.value;
};

describe('parseNflHighlightTitle', () => {
  it.each(REAL_GAME_TITLES)('parses real title %s', (title, first, second, week) => {
    expect(parse(title)).toEqual({ first, second, season: 2026, week });
  });

  it.each([
    ['add it to Devonta Smith’s highlight reel 🙌', 'unrecognized_title'],
    ['Zach Ertz PHILLY Highlights in 2026 🦅🤯', 'unrecognized_title'],
    ['Bills vs. Chargers Week 3 Preview | Game Highlights | 2026 NFL Season Week 3', 'non_highlight_terms'],
    ['Sean McDermott Press Conference | Bills vs Chargers Game Highlights | 2026 NFL Season Week 3', 'non_highlight_terms'],
    ['Every Play: Chargers vs. Bills Game Highlights | 2026 NFL Season Week 3', 'non_highlight_terms'],
    ['Springfield Atoms vs. Buffalo Bills Game Highlights | 2026 NFL Season Week 3', 'unknown_team'],
    ['Buffalo Bills vs. Buffalo Bills Game Highlights | 2026 NFL Season Week 3', 'same_team'],
  ])('rejects %s', (title, reason) => {
    expect(parseNflHighlightTitle(title)).toEqual({ ok: false, reason });
  });

  it('accepts nicknames and aliases', () => {
    expect(parse('Chargers vs Niners Game Highlights | 2026 NFL Season Week 9')).toMatchObject({ first: 'LAC', second: 'SF' });
  });
});

describe('matchNflCandidate', () => {
  const title = 'Los Angeles Chargers vs. Buffalo Bills Game Highlights | NFL 2026 Season Week 3';
  const base = { videoId: 'v__pg6qIYL4', title, publishedAt: '2026-09-27T20:35:35Z', durationSeconds: 919 };

  it('matches the real Week 3 LAC @ BUF highlight with full confidence', () => {
    expect(matchNflCandidate(event(), parse(title), base)).toEqual({ matched: true, confidence: 1, flags: [] });
  });

  it.each([
    ['wrong team', event({ away: { abbr: 'MIA', name: 'Miami Dolphins', shortName: 'Dolphins' } }), base, 'teams_differ'],
    ['wrong week', event({ week: 4 }), base, 'week_differs'],
    ['wrong season', event({ season: 2025 }), base, 'season_differs'],
    ['postseason not yet supported', event({ seasonType: 3 }), base, 'season_type_not_supported'],
    ['published before kickoff', event(), { ...base, publishedAt: '2026-09-27T16:00:00Z' }, 'published_before_event'],
    ['Shorts-length clip', event(), { ...base, durationSeconds: 45 }, 'too_short'],
  ])('rejects %s', (_label, ev, input, reason) => {
    expect(matchNflCandidate(ev, parse(title), input)).toMatchObject({ matched: false, rejectionReason: reason });
  });

  it('keeps atypical durations as matches with lower confidence (23:42 real example)', () => {
    expect(matchNflCandidate(event(), parse(title), { ...base, durationSeconds: 1422 })).toEqual({ matched: true, confidence: 0.9, flags: ['duration_atypical'] });
  });

  it('flags swapped home/away order and late publication without rejecting', () => {
    const swapped = parse('Buffalo Bills vs. Los Angeles Chargers Game Highlights | NFL 2026 Season Week 3');
    const r = matchNflCandidate(event(), swapped, { ...base, publishedAt: '2026-09-29T12:00:00Z' });
    expect(r.matched).toBe(true);
    expect(r.flags).toEqual(['home_away_order_swapped', 'published_over_24h_after_estimated_end']);
    expect(r.confidence).toBeCloseTo(0.8);
  });
});
