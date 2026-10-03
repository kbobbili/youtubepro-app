import { describe, expect, it } from 'vitest';
import { SCREENING_VERSION, screenTitle, titleFingerprint } from '../src/spoilers.ts';

describe('screenTitle (heuristic; unflagged is not proof of spoiler safety)', () => {
  it.each([
    'Arizona Cardinals vs. San Francisco 49ers Game Highlights | NFL 2026 Season Week 3',
    'Los Angeles Rams vs Denver Broncos Game Highlights | 2026 NFL Season Week 3',
    'Baltimore Ravens vs Dallas Cowboys Game Highlights from Rio | 2026 NFL Season Week 3',
    // Dates, years, season spans, match numbers and kickoff times are not scores.
    'Bills vs Chargers Highlights 2026-10-03',
    'Arsenal v. Chelsea | PREMIER LEAGUE HIGHLIGHTS | 9/27/2026',
    'Season Review 2025-26 | Week 18',
    'Highlights: 2nd ODI, India vs Australia | Kickoff 8:20 PM ET',
    'Race Highlights | 2026 Singapore Grand Prix',
    'Top 10 Plays | Week 3',
  ])('unflagged: %s', (title) => {
    expect(screenTitle(title, 'nfl')).toEqual({ status: 'unflagged', reasons: [], version: SCREENING_VERSION });
  });

  it.each([
    ['Bills Beat Chargers in Week 3 Thriller', ['result_term:beat', 'result_term:thriller']],
    ['49ers Rally Past Cardinals', ['result_term:rally']],
    ['Chiefs 27-24 Dolphins | Game Highlights', ['score_like:27-24']],
    ['Lions win 31 to 17', ['result_term:win', 'score_like:31 to 17']],
    ['Bills improve to (3-0) after Week 3', ['score_like:3-0']],
    ['Game-winning drive! Seahawks vs Commanders', ['result_term:winning', 'result_term:game-winning']],
    ['Broncos survive in OT', ['result_term:survive', 'result_term:in ot']],
    ['Undefeated Bills stay hot', ['result_term:undefeated']],
  ])('flagged: %s', (title, reasons) => {
    const r = screenTitle(title, 'nfl');
    expect(r.status).toBe('flagged');
    expect(r.reasons).toEqual(reasons);
  });

  it('a missing title is unreviewed, never unflagged', () => {
    expect(screenTitle('', 'nfl').status).toBe('unreviewed');
    expect(screenTitle(undefined, 'nfl').status).toBe('unreviewed');
  });

  it('fingerprints change when the publisher edits a title', () => {
    expect(titleFingerprint('A vs B Highlights')).toBe(titleFingerprint(' A vs B Highlights '));
    expect(titleFingerprint('A vs B Highlights')).not.toBe(titleFingerprint('A beats B Highlights'));
  });
});
