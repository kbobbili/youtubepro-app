import { createHash } from 'node:crypto';

/**
 * Title spoiler heuristic for publishing raw YouTube titles to an external player (SmartTube experiment).
 *
 * 'unflagged' means the heuristic found no warning, NOT that the title is proven spoiler-safe.
 * Thumbnails, durations and indirect result language are out of reach of this check.
 * The neutral library export never carries publisher titles and does not depend on this check.
 *
 * Bump SCREENING_VERSION whenever rules change: stored screens of an older version are re-run.
 */
export const SCREENING_VERSION = 2;

export type TitleScreenStatus = 'flagged' | 'unflagged' | 'unreviewed';

export interface TitleScreen {
  status: TitleScreenStatus;
  reasons: string[];
  version: number;
}

/** Stable fingerprint of a title's content, so a changed publisher title is re-screened. */
export function titleFingerprint(title: string): string {
  return createHash('sha256').update(title.normalize('NFC').trim()).digest('hex').slice(0, 16);
}

/** Result language common to all sports (whole words, case-insensitive). */
const RESULT_TERMS =
  /\b(beat|beats|beaten|defeats?|defeated|wins?|won|winning|victory|victories|triumphs?|upsets?|upset win|routs?|routed|crush(?:es|ed)?|edges|edged|stuns?|stunned|comebacks?|come-from-behind|rall(?:y|ies|ied)|survives?|survived|dominates?|dominated|thrash(?:es|ed)?|hammer(?:s|ed)|blowout|shut ?out|eliminat(?:e|es|ed|ion)|knocks? out|knocked out|holds? off|held off|seals?|sealed|clinch(?:es|ed)?|streak|loses|lost|loss|losses|falls to|fell to|tied|thriller)\b/i;

/**
 * Sport-specific result language, keyed by adapter sport. Examples are real titles observed 2026-10-03:
 * soccer hype prefixes ("LATE WINNER 👀", "2 GOALS FOR LAMINE YAMAL"), tennis ("Continues Title Defence").
 */
const SPORT_TERMS: Record<string, RegExp> = {
  nfl: /\b(game[- ]winn(?:ing|er)|walk-?off|in (?:ot|overtime)|overtime (?:win|thriller)|undefeated|winless|perfect season|first (?:win|loss))\b/i,
  f1: /\b(pole|podium|p1|crash(?:es|ed)?|dnf|retire(?:s|d)?|champion(?:ship)? (?:lead|decided|clinched)|crowned|first win|maiden win)\b/i,
  soccer: /\b(winner|late (?:goal|show|drama)|equali[sz]er|hat-?trick|brace|own goal|red card|sent off|clean sheet|\d+ goals? for|scores? (?:twice|again)|dismantl\w*|batter\w*|soar\w*|controversy|stoppage[- ]time|comeback|thrash\w*)\b/i,
  tennis: /\b(def\.?|ousts?|saves? match points?|title|champion|crowned|retire(?:s|d)?|retirement|walkover|straight sets|advances?|reaches|into (?:the )?(?:final|semis?|semifinals?|quarters?|quarterfinals?)|title defen[cs]e|bagel|breadstick)\b/i,
  cricket: /\b(by \d+ (?:runs?|wickets?)|century|centuries|ton|fifer|five-for|hat-?trick|seal(?:s|ed)? (?:the )?series|clean sweep|whitewash|super over|chase|chases|chased|collapse|run .* close|level(?:s|led)? (?:the )?series)\b/i,
};

/** Harmless numeric forms removed before score detection: dates, season spans, clock times. */
const HARMLESS_NUMERIC: RegExp[] = [
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g, // 2026-10-03
  /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, // 9/27/2026, 27.09.26
  /\b(?:19|20)\d{2}\s*[-–/]\s*(?:19|20)?\d{2}\b/g, // 2025-26, 2025/2026
  /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?|ET|PT|CT|MT|GMT|BST|IST|AEST|CET)\b/gi, // 8:20 PM ET
];

/** Score-like expressions: 27-24, 3–1, (3-0), 2:1, "27 to 24". */
const SCORE_LIKE = [/\b\d{1,3}\s*[-–—:]\s*\d{1,3}\b/, /\b\d{1,3}\s+to\s+\d{1,3}\b/i];

export function screenTitle(title: string | null | undefined, sport: string): TitleScreen {
  if (!title?.trim()) return { status: 'unreviewed', reasons: ['title_missing'], version: SCREENING_VERSION };
  const reasons: string[] = [];
  for (const re of [RESULT_TERMS, SPORT_TERMS[sport]]) {
    const m = re && new RegExp(re.source, 'gi');
    for (const hit of m ? title.matchAll(m) : []) reasons.push(`result_term:${hit[0].toLowerCase()}`);
  }
  let numeric = title;
  for (const re of HARMLESS_NUMERIC) numeric = numeric.replace(re, ' ');
  for (const re of SCORE_LIKE) {
    const hit = re.exec(numeric);
    if (hit) reasons.push(`score_like:${hit[0]}`);
  }
  return { status: reasons.length ? 'flagged' : 'unflagged', reasons: [...new Set(reasons)], version: SCREENING_VERSION };
}
