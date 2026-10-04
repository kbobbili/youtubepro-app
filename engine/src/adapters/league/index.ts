import { z } from 'zod';
import { PRIORITY_RANK, type Preferences } from '../../config.ts';
import type { EventStatus, Participant, SportEvent, Window } from '../../domain.ts';
import { getJson, type Transport } from '../../http.ts';
import { normalizeName, reject, scoreMatch, timingRejection } from '../common.ts';
import { easternDatesFor } from '../nfl/espn.ts';
import { NOT_FOLLOWED, type EventFetchResult, type SportAdapter } from '../types.ts';

/**
 * NBA and MLB team games from ESPN scoreboards; highlights from the official league channels.
 *
 * Observed 2026-10-03: `basketball/nba/scoreboard?dates=YYYYMMDD` and `baseball/mlb/scoreboard?dates=YYYYMMDD`
 * (one day per call; ranges return HTTP 400). `season.slug` is preseason / regular-season / post-season;
 * MLB postseason games carry `notes[0].headline` such as "NLWC - Game 2". Scores, series summaries and
 * status details ("Final/10") are never parsed.
 *
 * Official full-game highlight titles (away team first):
 *   NBA  "HEAT at RAPTORS | NBA PRESEASON FULL GAME HIGHLIGHTS | October 3, 2026"
 *        "#2 SPURS at #1 THUNDER | FULL GAME 7 HIGHLIGHTS | May 30, 2026"
 *        "#3 KNICKS at #2 SPURS | NBA FINALS GAME 5 HIGHLIGHTS | June 13, 2026"   (also "EXTENDED: …" copies)
 *   MLB  "DODGERS vs. GIANTS: Official Full Game Highlights (September 27) | 2026 MLB Season"
 *        "RED SOX vs. YANKEES: Wild Card Full Game 2 Highlights (September 30) | 2026 MLB Season"
 *        "BRAVES vs. DODGERS: NLDS Full Game 1 Highlights (October 3) | 2026 MLB | Shohei Ohtani"
 * Both channels also post clips whose titles carry results ("… to take a 1-0 series lead"); only the
 * full-game formats above match.
 */

type SeasonType = 'preseason' | 'regular' | 'postseason';

interface League {
  sport: 'nba' | 'mlb';
  label: string;
  path: string;
  competition: string;
  durationMs: number;
  typicalSeconds: [number, number];
}

const NBA: League = { sport: 'nba', label: 'NBA', path: 'basketball/nba', competition: 'NBA', durationMs: 150 * 60_000, typicalSeconds: [5 * 60, 25 * 60] };
const MLB: League = { sport: 'mlb', label: 'MLB', path: 'baseball/mlb', competition: 'MLB', durationMs: 180 * 60_000, typicalSeconds: [5 * 60, 20 * 60] };

const Team = z.object({ abbreviation: z.string(), displayName: z.string(), shortDisplayName: z.string().optional(), name: z.string().optional() });
const EspnEvent = z.object({
  id: z.string(),
  date: z.string(),
  season: z.object({ year: z.number().int(), slug: z.string().optional() }),
  competitions: z
    .array(
      z.object({
        status: z.object({ type: z.object({ name: z.string(), state: z.string(), completed: z.boolean() }) }),
        notes: z.array(z.object({ headline: z.string().optional() })).optional(),
        competitors: z.array(z.object({ homeAway: z.enum(['home', 'away']), team: Team })).length(2),
      }),
    )
    .min(1),
});

function mapStatus(name: string, state: string, completed: boolean): EventStatus {
  if (name === 'STATUS_POSTPONED') return 'POSTPONED';
  if (name === 'STATUS_CANCELED' || name === 'STATUS_CANCELLED') return 'CANCELLED';
  if (state === 'post' && completed) return 'COMPLETED';
  if (state === 'in') return 'IN_PROGRESS';
  if (state === 'pre') return 'SCHEDULED';
  return 'UNKNOWN';
}

const seasonType = (slug: string | undefined): SeasonType => (/pre/.test(slug ?? '') ? 'preseason' : /post|play/.test(slug ?? '') ? 'postseason' : 'regular');

export function normalizeTeamGame(raw: unknown, league: League): SportEvent {
  const e = EspnEvent.parse(raw);
  const c = e.competitions[0]!;
  const participant = (homeAway: 'home' | 'away'): Participant => {
    const t = c.competitors.find((x) => x.homeAway === homeAway)!.team;
    return { id: t.abbreviation, name: t.displayName, shortName: t.shortDisplayName ?? t.name ?? t.displayName, abbr: t.abbreviation, role: homeAway };
  };
  const type = seasonType(e.season.slug);
  const note = type === 'postseason' ? (c.notes?.[0]?.headline ?? null) : null;
  return {
    id: `${league.sport}:espn:${e.id}`,
    sport: league.sport,
    competition: league.competition,
    competitionId: league.competition,
    provider: 'espn',
    providerEventId: e.id,
    season: e.season.year,
    startTime: new Date(e.date).toISOString(),
    status: mapStatus(c.status.type.name, c.status.type.state, c.status.type.completed),
    providerStatus: c.status.type.name,
    stage: type === 'preseason' ? 'Preseason' : note,
    participants: [participant('home'), participant('away')],
    meta: { seasonType: type, gameNumber: Number(/Game (\d+)/i.exec(note ?? '')?.[1]) || null },
  };
}

async function fetchTeamGames(transport: Transport, window: Window, league: League): Promise<EventFetchResult> {
  const byId = new Map<string, SportEvent>();
  const issues: string[] = [];
  let requests = 0;
  for (const date of easternDatesFor(window)) {
    const url = new URL(`https://site.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard`);
    url.searchParams.set('dates', date);
    requests++;
    let body: unknown;
    try {
      body = await getJson(transport, url);
    } catch (err) {
      issues.push(`ESPN ${league.label} ${date}: ${(err as Error).message}`);
      continue;
    }
    const board = z.object({ events: z.array(z.unknown()) }).safeParse(body);
    if (!board.success) {
      issues.push(`ESPN ${league.label} ${date}: malformed scoreboard (no events array)`);
      continue;
    }
    for (const raw of board.data.events) {
      try {
        const ev = normalizeTeamGame(raw, league);
        if (ev.startTime >= window.start && ev.startTime < window.end) byId.set(ev.id, ev);
      } catch (err) {
        issues.push(`ESPN ${league.label} ${date}: malformed event ${String((raw as { id?: unknown })?.id ?? '?')}: ${(err as Error).message.slice(0, 160)}`);
      }
    }
  }
  const events = [...byId.values()].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
  numberDoubleheaders(events);
  return { events, complete: issues.length === 0, issues, requests };
}

/**
 * Same two teams on the same US Eastern day (a doubleheader): number the games by start time, so a title's
 * "Full Game 1/2 Highlights" must name the right game. Postseason games already carry ESPN's game number.
 */
function numberDoubleheaders(events: SportEvent[]): void {
  const groups = new Map<string, SportEvent[]>();
  for (const e of events) {
    if (e.meta.gameNumber !== null) continue;
    const key = `${e.participants.map((p) => p.id).sort().join('-')}|${easternDay(e.startTime).day}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  for (const g of groups.values()) if (g.length > 1) g.forEach((e, i) => (e.meta.gameNumber = i + 1));
}

export interface ParsedGameTitle {
  a: string;
  b: string;
  /** Days since epoch for the title's calendar date (year inferred for MLB titles, which omit it). */
  month: number;
  day: number;
  year?: number;
  gameNumber?: number;
  preseason: boolean;
  /** Title names a postseason round or game (playoff formats). */
  postseason: boolean;
  extended: boolean;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthIndex = (m: string) => MONTHS.indexOf(m.toLowerCase());

// Team names never contain "|" (or ":" for MLB), so extra segments such as "| LAS VEGAS SUMMER LEAGUE |" cannot
// be absorbed into a team name.
const NBA_TITLE = /^(?<ext>EXTENDED:\s*)?(?:#\d+\s+)?(?<a>[^|]+?)\s+(?:at|vs\.?)\s+(?:#\d+\s+)?(?<b>[^|]+?)\s*\|\s*(?<label>[^|]*HIGHLIGHTS[^|]*?)\s*\|\s*(?<month>[A-Za-z]+)\s+(?<day>\d{1,2}),\s*(?<year>\d{4})\s*$/i;
const MLB_TITLE = /^(?<a>[^|:]+?)\s+vs\.?\s+(?<b>[^|:]+?):\s*(?<label>[^|]*?)\bFull Game(?:\s+(?<num>\d+))?\s+Highlights\s*\((?<month>[A-Za-z]+)\s+(?<day>\d{1,2})(?:,\s*(?<year>\d{4}))?\)/i;
const GAME_NUMBER = /Game\s+(\d+)/i;

export function parseNbaTitle(title: string): ParsedGameTitle | undefined {
  const m = NBA_TITLE.exec(title.trim().replace(/\s+/g, ' '));
  if (!m?.groups) return undefined;
  const label = m.groups.label!;
  if (/SUMMER LEAGUE|ALL-?STAR/i.test(label)) return undefined;
  const month = monthIndex(m.groups.month!);
  if (month < 0) return undefined;
  const num = /GAME\s+(\d+)/i.exec(label)?.[1];
  return {
    a: m.groups.a!, b: m.groups.b!, month, day: Number(m.groups.day), year: Number(m.groups.year), ...(num ? { gameNumber: Number(num) } : {}),
    preseason: /PRESEASON/i.test(label), postseason: !!num || /FINALS|PLAY-?IN|ROUND/i.test(label), extended: !!m.groups.ext,
  };
}

export function parseMlbTitle(title: string): ParsedGameTitle | undefined {
  const m = MLB_TITLE.exec(title.trim().replace(/\s+/g, ' '));
  if (!m?.groups) return undefined;
  const month = monthIndex(m.groups.month!);
  if (month < 0) return undefined;
  const label = m.groups.label!.trim();
  return {
    a: m.groups.a!, b: m.groups.b!, month, day: Number(m.groups.day), ...(m.groups.year ? { year: Number(m.groups.year) } : {}),
    // "Wild Card Full Game 2 Highlights" or "Wild Card Game 1 Full Game Highlights".
    ...((m.groups.num ?? GAME_NUMBER.exec(label)?.[1]) ? { gameNumber: Number(m.groups.num ?? GAME_NUMBER.exec(label)![1]) } : {}),
    preseason: /spring/i.test(label), postseason: !/^official$/i.test(label) && label.length > 0, extended: false,
  };
}

/** Title nicknames that differ from ESPN's short names (normalized). */
const TEAM_ALIASES: Record<string, string[]> = { diamondbacks: ['d backs', 'dbacks'], athletics: ['a s'] };

/** Title team names are uppercase nicknames ("RED SOX", "76ERS", "D-BACKS"); accept ESPN display/short names and aliases. */
const isTeam = (text: string, p: Participant) => {
  const t = normalizeName(text);
  return [p.name, p.shortName].some((n) => normalizeName(n) === t || (TEAM_ALIASES[normalizeName(n)] ?? []).includes(t));
};
const sides = (e: SportEvent) => ({ home: e.participants.find((p) => p.role === 'home')!, away: e.participants.find((p) => p.role === 'away')! });

/** Kickoff calendar date in US Eastern time as days since epoch, and its year. */
function easternDay(iso: string): { day: number; year: number } {
  const [y, mo, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)).split('-').map(Number);
  return { day: Date.UTC(y!, mo! - 1, d!) / 86_400_000, year: y! };
}

function leagueAdapter(league: League, parse: (t: string) => ParsedGameTitle | undefined): SportAdapter<ParsedGameTitle> {
  const prefsOf = (prefs: Preferences) => prefs.sports[league.sport];
  return {
    sport: league.sport,
    label: league.label,
    fetchEvents: ({ transport, window }) => fetchTeamGames(transport, window, league),
    follow(e, prefs) {
      const p = prefsOf(prefs);
      if (!p?.enabled || !p.seasonTypes.includes(e.meta.seasonType as SeasonType)) return NOT_FOLLOWED;
      const ids = new Set(e.participants.map((x) => x.id));
      const hits = p.teams.filter((t) => ids.has(t.abbr));
      return hits.length ? { followed: true, priority: Math.max(...hits.map((t) => PRIORITY_RANK[t.priority])) } : NOT_FOLLOWED;
    },
    sourceCompetition: () => league.competition,
    parseTitle: parse,
    related(e, t) {
      const { home, away } = sides(e);
      return (isTeam(t.a, away) && isTeam(t.b, home)) || (isTeam(t.a, home) && isTeam(t.b, away));
    },
    match(e, t, input) {
      const { home, away } = sides(e);
      const awayFirst = isTeam(t.a, away) && isTeam(t.b, home);
      if (!awayFirst && !(isTeam(t.a, home) && isTeam(t.b, away))) return reject('teams_differ');
      // The title date separates games of a series; ±1 day tolerates late games crossing midnight.
      const kick = easternDay(e.startTime);
      const titleDay = Date.UTC(t.year ?? kick.year, t.month, t.day) / 86_400_000;
      if (Math.abs(titleDay - kick.day) > 1) return reject('date_differs');
      const type = e.meta.seasonType as SeasonType;
      if (t.preseason !== (type === 'preseason')) return reject('season_type_differs');
      if (t.postseason !== (type === 'postseason')) return reject('season_type_differs');
      // A numbered title must name this game; an unnumbered one cannot pick between doubleheader games.
      if (t.gameNumber !== undefined && e.meta.gameNumber !== null && t.gameNumber !== e.meta.gameNumber) return reject('game_number_differs');
      if (t.gameNumber === undefined && e.meta.gameNumber !== null && type !== 'postseason') return reject('doubleheader_game_unspecified');
      const timing = timingRejection(e, input, league.durationMs);
      if (timing) return reject(timing);
      const r = scoreMatch(e, input, { estimatedDurationMs: league.durationMs, typicalSeconds: league.typicalSeconds, bonus: { ok: awayFirst, flag: 'home_away_order_swapped' } });
      if (t.extended) r.flags.push('extended_cut');
      return r;
    },
    estimatedDurationMs: () => league.durationMs,
    neutralTitle(e) {
      const { home, away } = sides(e);
      return `${away.name} at ${home.name}`;
    },
    subtitle: (e) => (e.stage ? `${league.label} · ${e.stage}` : league.label),
  };
}

export const nbaAdapter = leagueAdapter(NBA, parseNbaTitle);
export const mlbAdapter = leagueAdapter(MLB, parseMlbTitle);
