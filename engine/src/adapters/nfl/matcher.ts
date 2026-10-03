import type { SportEvent } from '../../domain.ts';
import { resolveNflTeam } from './teams.ts';

/**
 * NFL highlight title parsing and event matching.
 *
 * Observed official titles (NFL channel, 2026 Week 3–4):
 *   "Arizona Cardinals vs. San Francisco 49ers Game Highlights | NFL 2026 Season Week 3"
 *   "Los Angeles Rams vs Denver Broncos Game Highlights | 2026 NFL Season Week 3"
 *   "Baltimore Ravens vs Dallas Cowboys Game Highlights from Rio | 2026 NFL Season Week 3"
 * Order is away vs home. Postseason/preseason naming is not yet observed and is not parsed.
 */

const TITLE =
  /^(?<a>.+?)\s+(?:vs\.?|v\.?|at|@)\s+(?<b>.+?)\s+Game Highlights(?:\s+from\s+[^|]+?)?\s*\|\s*(?:(?<y1>\d{4})\s+NFL\s+Season|NFL\s+(?<y2>\d{4})\s+Season)\s+Week\s+(?<week>\d{1,2})\s*$/i;

const REJECT_TERMS = /\b(press conference|presser|preview|prediction|predictions|interview|reaction|mic'?d up|every play|all-22|film breakdown|fantasy)\b/i;

/** Shorts and clips are far shorter than a game highlight package. */
const MIN_DURATION_SECONDS = 120;

/** Initial scoring hypothesis for a typical game highlight package (not a hard filter). */
const TYPICAL_MIN_SECONDS = 8 * 60;
const TYPICAL_MAX_SECONDS = 20 * 60;

/** Initial hypothesis for event duration when the provider gives no end time. */
export const ESTIMATED_GAME_DURATION_MS = (3 * 60 + 15) * 60_000;

export interface ParsedNflTitle {
  /** ESPN abbreviations in title order (normally away, home). */
  first: string;
  second: string;
  season: number;
  week: number;
}

export type TitleParse = { ok: true; value: ParsedNflTitle } | { ok: false; reason: string };

export function parseNflHighlightTitle(title: string): TitleParse {
  if (REJECT_TERMS.test(title)) return { ok: false, reason: 'non_highlight_terms' };
  const m = TITLE.exec(title.trim());
  if (!m?.groups) return { ok: false, reason: 'unrecognized_title' };
  const first = resolveNflTeam(m.groups.a!);
  const second = resolveNflTeam(m.groups.b!);
  if (!first || !second) return { ok: false, reason: 'unknown_team' };
  if (first === second) return { ok: false, reason: 'same_team' };
  return {
    ok: true,
    value: { first, second, season: Number(m.groups.y1 ?? m.groups.y2), week: Number(m.groups.week) },
  };
}

export interface MatchInput {
  videoId: string;
  title: string;
  publishedAt: string;
  durationSeconds?: number;
}

export interface MatchResult {
  matched: boolean;
  confidence: number;
  flags: string[];
  rejectionReason?: string;
}

/**
 * Identity is required: both teams, season, regular-season week. Publish timing and duration
 * only adjust confidence. Returns matched=false with a reason when identity fails.
 */
export function matchNflCandidate(event: SportEvent, parsed: ParsedNflTitle, input: MatchInput): MatchResult {
  const flags: string[] = [];
  const teams = new Set([parsed.first, parsed.second]);
  if (!teams.has(event.home.abbr) || !teams.has(event.away.abbr)) return { matched: false, confidence: 0, flags, rejectionReason: 'teams_differ' };
  if (event.seasonType !== 2) return { matched: false, confidence: 0, flags, rejectionReason: 'season_type_not_supported' };
  if (parsed.season !== event.season) return { matched: false, confidence: 0, flags, rejectionReason: 'season_differs' };
  if (parsed.week !== event.week) return { matched: false, confidence: 0, flags, rejectionReason: 'week_differs' };
  if (input.publishedAt < event.startTime) return { matched: false, confidence: 0, flags, rejectionReason: 'published_before_event' };
  if (input.durationSeconds !== undefined && input.durationSeconds < MIN_DURATION_SECONDS) {
    return { matched: false, confidence: 0, flags, rejectionReason: 'too_short' };
  }

  let confidence = 0.7;
  if (parsed.first === event.away.abbr) confidence += 0.1;
  else flags.push('home_away_order_swapped');

  const estimatedEnd = Date.parse(event.startTime) + ESTIMATED_GAME_DURATION_MS;
  const delayHours = (Date.parse(input.publishedAt) - estimatedEnd) / 3_600_000;
  if (delayHours <= 24) confidence += 0.1;
  else flags.push('published_over_24h_after_estimated_end');

  if (input.durationSeconds === undefined) flags.push('duration_unknown');
  else if (input.durationSeconds >= TYPICAL_MIN_SECONDS && input.durationSeconds <= TYPICAL_MAX_SECONDS) confidence += 0.1;
  else flags.push('duration_atypical');

  return { matched: true, confidence: Math.round(confidence * 100) / 100, flags };
}
