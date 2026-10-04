import { PRIORITY_RANK, type Preferences } from '../../config.ts';
import { isNflEvent, type SportEvent } from '../../domain.ts';
import { reject } from '../common.ts';
import { NOT_FOLLOWED, type SportAdapter } from '../types.ts';
import { fetchNflEvents } from './espn.ts';
import { ESTIMATED_GAME_DURATION_MS, matchNflCandidate, parseNflHighlightTitle, type ParsedNflTitle } from './matcher.ts';

const teamsOf = (e: SportEvent) => ({
  home: e.participants.find((p) => p.role === 'home'),
  away: e.participants.find((p) => p.role === 'away'),
});

export const nflAdapter: SportAdapter<ParsedNflTitle> = {
  sport: 'nfl',
  label: 'NFL',
  fetchEvents: ({ transport, window }) => fetchNflEvents(transport, window),

  follow(e: SportEvent, prefs: Preferences) {
    const nfl = prefs.sports.nfl;
    if (!nfl?.enabled) return NOT_FOLLOWED;
    const ids = new Set(e.participants.map((p) => p.id));
    const hits = nfl.teams.filter((t) => ids.has(t.abbr));
    return hits.length ? { followed: true, priority: Math.max(...hits.map((t) => PRIORITY_RANK[t.priority])) } : NOT_FOLLOWED;
  },

  sourceCompetition: () => 'NFL',
  parseTitle: (title) => {
    const r = parseNflHighlightTitle(title);
    return r.ok ? r.value : undefined;
  },
  related(e, parsed) {
    const { home, away } = teamsOf(e);
    const teams = new Set([parsed.first, parsed.second]);
    return !!home && !!away && teams.has(home.id) && teams.has(away.id);
  },
  match: (e, parsed, input) => (isNflEvent(e) ? matchNflCandidate(e, parsed, input) : reject('not_an_nfl_event')),
  estimatedDurationMs: () => ESTIMATED_GAME_DURATION_MS,
  neutralTitle(e) {
    const { home, away } = teamsOf(e);
    return `${away?.name ?? '?'} at ${home?.name ?? '?'}`;
  },
  subtitle: (e) => `${e.competition} · ${e.stage ?? ''}`.trim(),
};
