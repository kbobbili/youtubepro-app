import type { SportEvent } from '../domain.ts';
import type { MatchInput, MatchResult } from './types.ts';

/** Lowercase, strip diacritics, "&" → "and", punctuation → spaces, collapse whitespace. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Same words in any order ("Zhang Zhizhen" = "Zhizhen Zhang"). */
export function sameTokens(a: string, b: string): boolean {
  const ta = normalizeName(a).split(' ').sort().join(' ');
  return ta.length > 0 && ta === normalizeName(b).split(' ').sort().join(' ');
}

/**
 * A title's name refers to a full provider name: same words in any order, or (for shortened names such as
 * "Coleman Wong" for "Chak Lam Coleman Wong") at least two words that all appear in the full name.
 * A single word (a bare surname) is never enough, so shared surnames cannot match each other.
 */
export function nameRefersTo(titleName: string, fullName: string): boolean {
  if (sameTokens(titleName, fullName)) return true;
  const t = normalizeName(titleName).split(' ').filter(Boolean);
  const full = new Set(normalizeName(fullName).split(' '));
  return t.length >= 2 && t.every((w) => full.has(w));
}

/** Whole-word suffix: "intense madrid derby atletico madrid" ends with "atletico madrid". */
export function endsWithName(text: string, name: string): boolean {
  const t = normalizeName(text);
  const n = normalizeName(name);
  return n.length > 0 && (t === n || t.endsWith(` ${n}`));
}

/** Shorts and clips are far shorter than any highlight package. */
export const MIN_HIGHLIGHT_SECONDS = 120;

/**
 * Shared identity-independent checks: published after the event started, not a short clip, and within
 * `maxDelayHours` of estimated end. Returns a rejection, or undefined when the candidate may proceed.
 */
export function timingRejection(e: SportEvent, input: MatchInput, estimatedDurationMs: number, maxDelayHours = 72, minSeconds = MIN_HIGHLIGHT_SECONDS): string | undefined {
  if (input.publishedAt < e.startTime) return 'published_before_event';
  if (input.durationSeconds !== undefined && input.durationSeconds < minSeconds) return 'too_short';
  const delayHours = (Date.parse(input.publishedAt) - (Date.parse(e.startTime) + estimatedDurationMs)) / 3_600_000;
  if (delayHours > maxDelayHours) return 'published_too_late';
  return undefined;
}

/**
 * Confidence for an identity-matched candidate: base 0.7, +0.1 each for publication within 24h of estimated end,
 * typical duration, and an adapter-specific bonus. Flags explain anything atypical; nothing here rejects.
 */
export function scoreMatch(
  e: SportEvent,
  input: MatchInput,
  o: { estimatedDurationMs: number; typicalSeconds: [number, number]; bonus?: { ok: boolean; flag: string } },
): MatchResult {
  const flags: string[] = [];
  let confidence = 0.7;
  if (o.bonus) {
    if (o.bonus.ok) confidence += 0.1;
    else flags.push(o.bonus.flag);
  }
  const delayHours = (Date.parse(input.publishedAt) - (Date.parse(e.startTime) + o.estimatedDurationMs)) / 3_600_000;
  if (delayHours <= 24) confidence += 0.1;
  else flags.push('published_over_24h_after_estimated_end');
  if (input.durationSeconds === undefined) flags.push('duration_unknown');
  else if (input.durationSeconds >= o.typicalSeconds[0] && input.durationSeconds <= o.typicalSeconds[1]) confidence += 0.1;
  else flags.push('duration_atypical');
  return { matched: true, confidence: Math.round(confidence * 100) / 100, flags };
}

export const reject = (rejectionReason: string): MatchResult => ({ matched: false, confidence: 0, flags: [], rejectionReason });
