import { z } from 'zod';
import { PRIORITY_RANK } from '../../config.ts';
import type { EventStatus, Participant, SportEvent, Window } from '../../domain.ts';
import { getJson, type Transport } from '../../http.ts';
import { endsWithName, normalizeName, reject, scoreMatch, timingRejection } from '../common.ts';
import { NOT_FOLLOWED, type EventFetchResult, type SportAdapter } from '../types.ts';

/**
 * Soccer for followed clubs, across competitions, from ESPN team schedules.
 *
 * Observed 2026-10-03: `soccer/all/teams/{id}/schedule` returns completed matches in every competition
 * (league, cups, Europe, friendlies) and `?fixture=true` returns upcoming ones; `events[].league.slug`
 * identifies the competition (eng.1, esp.1, uefa.champions, eng.league_cup, club.friendly…).
 * League scoreboards reject date ranges (HTTP 400). Scores in the payload are never parsed.
 *
 * Sources resolve per competition via config/sources.yaml (eng.1 → NBC Sports, esp.1 → ESPN FC).
 * Competitions without a verified US source (Champions League, cups, friendlies) are reported, not guessed.
 *
 * Titles (home team first):
 *   NBC Sports: "Brighton v. Arsenal | PREMIER LEAGUE HIGHLIGHTS | 9/19/2026 | NBC Sports"
 *   ESPN FC:    "Elche vs. Real Madrid | LALIGA Highlights | ESPN FC"
 *               "INTENSE MADRID DERBY 🍿 Atletico Madrid vs. Real Madrid | LALIGA Highlights | ESPN FC" (hype prefix)
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams';

/** Initial hypothesis: 90 minutes plus half-time and stoppage time. */
const MATCH_DURATION_MS = 115 * 60_000;
// NBC packages run ~14 min; ESPN FC LaLiga packages ran 15–20 min (observed 2026-10-03).
const TYPICAL_SECONDS: [number, number] = [2 * 60, 22 * 60];

/** Short forms used in broadcaster titles that differ from ESPN display/short names (normalized). */
const TEAM_ALIASES: Record<string, string[]> = {
  'wolverhampton wanderers': ['wolves'],
  'tottenham hotspur': ['tottenham', 'spurs'],
  'manchester united': ['man united', 'man utd'],
  'manchester city': ['man city'],
  'nottingham forest': ['nottm forest', 'nott m forest', 'forest'],
  'west ham united': ['west ham'],
  'newcastle united': ['newcastle'],
  'brighton and hove albion': ['brighton'],
  'leeds united': ['leeds'],
  'ipswich town': ['ipswich'],
  'atletico madrid': ['atletico', 'atleti'],
  'athletic club': ['athletic bilbao'],
  'deportivo alaves': ['alaves'],
  internazionale: ['inter', 'inter milan'],
};

/** Every accepted spelling of a team: ESPN display and short names, without club suffixes, plus aliases. */
export function teamNames(p: Pick<Participant, 'name' | 'shortName'>): string[] {
  const names = new Set<string>();
  for (const raw of [p.name, p.shortName]) {
    const n = normalizeName(raw);
    if (!n) continue;
    names.add(n);
    names.add(n.replace(/\b(fc|afc|cf|sc)\b/g, '').replace(/\s+/g, ' ').trim());
    for (const a of TEAM_ALIASES[n] ?? []) names.add(a);
  }
  names.delete('');
  return [...names];
}

const isTeam = (text: string, p: Participant) => teamNames(p).some((n) => normalizeName(text) === n);
/** Broadcaster hype may precede the home team ("INTENSE MADRID DERBY 🍿 Atletico Madrid"). */
const endsWithTeam = (text: string, p: Participant) => teamNames(p).some((n) => endsWithName(text, n));

const Team = z.object({ id: z.string(), displayName: z.string(), shortDisplayName: z.string().optional(), abbreviation: z.string().optional() });
const EspnEvent = z.object({
  id: z.string(),
  date: z.string(),
  season: z.object({ year: z.number().int() }).optional(),
  league: z.object({ slug: z.string(), name: z.string().optional(), abbreviation: z.string().optional(), shortName: z.string().optional() }),
  competitions: z
    .array(
      z.object({
        status: z.object({ type: z.object({ name: z.string(), state: z.string(), completed: z.boolean() }) }),
        competitors: z.array(z.object({ homeAway: z.enum(['home', 'away']), team: Team })).length(2),
      }),
    )
    .min(1),
});

function mapStatus(name: string, state: string, completed: boolean): EventStatus {
  if (name === 'STATUS_POSTPONED') return 'POSTPONED';
  if (name === 'STATUS_CANCELED' || name === 'STATUS_CANCELLED' || name === 'STATUS_ABANDONED') return 'CANCELLED';
  if (state === 'post' && completed) return 'COMPLETED';
  if (state === 'in') return 'IN_PROGRESS';
  if (state === 'pre') return 'SCHEDULED';
  return 'UNKNOWN';
}

export function normalizeEspnSoccerEvent(raw: unknown): SportEvent {
  const e = EspnEvent.parse(raw);
  const c = e.competitions[0]!;
  const participant = (homeAway: 'home' | 'away'): Participant => {
    const t = c.competitors.find((x) => x.homeAway === homeAway)!.team;
    return { id: t.id, name: t.displayName, shortName: t.shortDisplayName ?? t.displayName, ...(t.abbreviation ? { abbr: t.abbreviation } : {}), role: homeAway };
  };
  const label = e.league.shortName ?? e.league.abbreviation ?? e.league.name ?? e.league.slug;
  return {
    id: `soccer:espn:${e.id}`,
    sport: 'soccer',
    competition: label,
    competitionId: e.league.slug,
    provider: 'espn',
    providerEventId: e.id,
    season: e.season?.year ?? null,
    startTime: new Date(e.date).toISOString(),
    status: mapStatus(c.status.type.name, c.status.type.state, c.status.type.completed),
    providerStatus: c.status.type.name,
    stage: null,
    participants: [participant('home'), participant('away')],
    meta: { league: e.league.name ?? label },
  };
}

/** Both schedule views (results, fixtures) for every followed team, deduplicated, filtered to the window. */
export async function fetchSoccerEvents(transport: Transport, window: Window, teamIds: string[]): Promise<EventFetchResult> {
  const byId = new Map<string, SportEvent>();
  const issues: string[] = [];
  let requests = 0;
  for (const id of teamIds) {
    for (const fixture of [false, true]) {
      const url = new URL(`${BASE}/${encodeURIComponent(id)}/schedule`);
      if (fixture) url.searchParams.set('fixture', 'true');
      requests++;
      let body: unknown;
      try {
        body = await getJson(transport, url);
      } catch (err) {
        issues.push(`ESPN soccer team ${id}${fixture ? ' fixtures' : ''}: ${(err as Error).message}`);
        continue;
      }
      const parsed = z.object({ events: z.array(z.unknown()) }).safeParse(body);
      if (!parsed.success) {
        issues.push(`ESPN soccer team ${id}: malformed schedule (no events array)`);
        continue;
      }
      for (const raw of parsed.data.events) {
        try {
          const ev = normalizeEspnSoccerEvent(raw);
          if (ev.startTime >= window.start && ev.startTime < window.end) byId.set(ev.id, ev);
        } catch (err) {
          issues.push(`ESPN soccer team ${id}: malformed event ${String((raw as { id?: unknown })?.id ?? '?')}: ${(err as Error).message.slice(0, 160)}`);
        }
      }
    }
  }
  const events = [...byId.values()].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
  return { events, complete: issues.length === 0, issues, requests };
}

export interface ParsedSoccerTitle {
  /** Text before " v. "/" vs. ": the home team, possibly preceded by broadcaster hype. */
  left: string;
  right: string;
  /** Competition the title format belongs to (ESPN league slug). */
  competitionId: string;
  /** US calendar date in the title (NBC), M/D/YYYY. */
  date?: string;
}

const FORMATS: { competitionId: string; re: RegExp }[] = [
  { competitionId: 'eng.1', re: /^(?<left>.+?)\s+v\.?\s+(?<right>.+?)\s*\|\s*PREMIER LEAGUE HIGHLIGHTS\s*\|\s*(?<date>\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s*\|.*)?$/i },
  { competitionId: 'esp.1', re: /^(?<left>.+?)\s+vs\.?\s+(?<right>.+?)\s*\|\s*LALIGA Highlights(?:\s*\|.*)?$/i },
];

export function parseSoccerTitle(title: string): ParsedSoccerTitle | undefined {
  if (/en espa[ñn]ol/i.test(title)) return undefined; // English commentary only
  for (const f of FORMATS) {
    const m = f.re.exec(title.trim());
    if (m?.groups) return { left: m.groups.left!.trim(), right: m.groups.right!.trim(), competitionId: f.competitionId, ...(m.groups.date ? { date: m.groups.date } : {}) };
  }
  return undefined;
}

const sides = (e: SportEvent) => ({ home: e.participants.find((p) => p.role === 'home')!, away: e.participants.find((p) => p.role === 'away')! });

/** "9/19/2026" or "9/19/26" → days since epoch (UTC midnight). */
function titleDay(date: string): number | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(date);
  if (!m) return undefined;
  const year = Number(m[3]!.length === 2 ? `20${m[3]}` : m[3]);
  return Date.UTC(year, Number(m[1]) - 1, Number(m[2])) / 86_400_000;
}

/** Kickoff calendar day in US Eastern time (days since epoch). */
function easternDay(iso: string): number {
  const [y, mo, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)).split('-').map(Number);
  return Date.UTC(y!, mo! - 1, d!) / 86_400_000;
}

export const soccerAdapter: SportAdapter<ParsedSoccerTitle> = {
  sport: 'soccer',
  label: 'Soccer',
  fetchEvents: ({ transport, window, prefs }) =>
    fetchSoccerEvents(transport, window, prefs.sports.soccer?.enabled ? prefs.sports.soccer.teams.map((t) => t.id) : []),
  follow(e, prefs) {
    const soccer = prefs.sports.soccer;
    if (!soccer?.enabled) return NOT_FOLLOWED;
    const ids = new Set(e.participants.map((p) => p.id));
    const hits = soccer.teams.filter((t) => ids.has(t.id));
    return hits.length ? { followed: true, priority: Math.max(...hits.map((t) => PRIORITY_RANK[t.priority])) } : NOT_FOLLOWED;
  },
  sourceCompetition: (e) => e.competitionId,
  parseTitle: parseSoccerTitle,
  related(e, p) {
    if (p.competitionId !== e.competitionId) return false;
    const { home, away } = sides(e);
    return (endsWithTeam(p.left, home) && isTeam(p.right, away)) || (endsWithTeam(p.left, away) && isTeam(p.right, home));
  },
  match(e, p, input) {
    if (p.competitionId !== e.competitionId) return reject('competition_differs');
    const { home, away } = sides(e);
    const homeFirst = endsWithTeam(p.left, home) && isTeam(p.right, away);
    if (!homeFirst && !(endsWithTeam(p.left, away) && isTeam(p.right, home))) return reject('teams_differ');
    if (p.date !== undefined) {
      const day = titleDay(p.date);
      if (day === undefined || Math.abs(day - easternDay(e.startTime)) > 1) return reject('date_differs');
    }
    const timing = timingRejection(e, input, MATCH_DURATION_MS);
    if (timing) return reject(timing);
    return scoreMatch(e, input, { estimatedDurationMs: MATCH_DURATION_MS, typicalSeconds: TYPICAL_SECONDS, bonus: { ok: homeFirst, flag: 'home_away_order_swapped' } });
  },
  estimatedDurationMs: () => MATCH_DURATION_MS,
  neutralTitle(e) {
    const { home, away } = sides(e);
    return `${home.name} vs ${away.name}`;
  },
  subtitle: (e) => e.competition,
};
