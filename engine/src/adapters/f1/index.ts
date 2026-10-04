import { z } from 'zod';
import { PRIORITY_RANK } from '../../config.ts';
import type { EventStatus, SportEvent, Window } from '../../domain.ts';
import { getJson, type Transport } from '../../http.ts';
import { normalizeName, reject, scoreMatch, timingRejection } from '../common.ts';
import { NOT_FOLLOWED, type EventFetchResult, type SportAdapter } from '../types.ts';

/**
 * Formula 1 races from ESPN's racing scoreboard; highlights from the official FORMULA 1 channel.
 *
 * Observed 2026-10-03: `racing/f1/scoreboard?dates=YYYYMMDD-YYYYMMDD` (ranges work) returns one event per
 * Grand Prix weekend with one competition per session; the race is `type.abbreviation === "Race"`.
 * The weekend-level status is unreliable (a weekend showed STATUS_FINAL while its race was scheduled),
 * so status comes from the race competition. Event names carry sponsors ("Tag Heuer Spanish Grand Prix").
 * Results/standings in the payload are never parsed.
 *
 * Race highlight titles: "Race Highlights | 2026 Azerbaijan Grand Prix" (year sometimes missing; casing of
 * "in Malaysia" varies). F2/F3/sprint/qualifying/"Extended Highlights | <older year>" never start with "Race Highlights".
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard';

/** Initial hypothesis: race plus formalities. */
const RACE_DURATION_MS = 2 * 3_600_000;
const TYPICAL_SECONDS: [number, number] = [4 * 60, 15 * 60];

/** Grand Prix names (as F1 uses them before "Grand Prix"), used to strip sponsor prefixes from ESPN names. */
const KNOWN_GP = [
  'Australian', 'Chinese', 'Japanese', 'Bahrain', 'Saudi Arabian', 'Miami', 'Emilia Romagna', 'Monaco', 'Spanish', 'Barcelona-Catalunya',
  'Canadian', 'Austrian', 'British', 'Belgian', 'Hungarian', 'Dutch', 'Italian', 'Madrid', 'Azerbaijan', 'Singapore', 'United States',
  'Mexico City', 'Mexican', 'São Paulo', 'Brazilian', 'Las Vegas', 'Qatar', 'Abu Dhabi', 'Portuguese', 'Malaysian', 'Turkish', 'French',
  'German', 'Russian', 'Vietnamese', 'Korean', 'Indian', 'Styrian', 'Tuscan', 'Eifel', 'Sakhir', 'Argentine', 'South African',
];

/** Different names for the same Grand Prix (normalized, without "grand prix"). */
const GP_ALIASES: string[][] = [['spanish', 'barcelona catalunya'], ['mexican', 'mexico city'], ['brazilian', 'sao paulo']];

/** "Tag Heuer Spanish Grand Prix" → "Spanish Grand Prix"; "Gulf Air Bahrain Grand Prix in Malaysia" → "Bahrain Grand Prix in Malaysia". */
export function gpName(espnName: string): string {
  const m = /^(?<prefix>.*?)\s*Grand Prix(?<suffix>.*)$/i.exec(espnName.trim());
  if (!m?.groups) return espnName.trim();
  const prefix = m.groups.prefix!;
  const np = normalizeName(prefix);
  const known = KNOWN_GP.map((k) => ({ k, n: normalizeName(k) }))
    .filter(({ n }) => np === n || np.endsWith(` ${n}`))
    .sort((a, b) => b.n.length - a.n.length)[0];
  const words = prefix.split(/\s+/);
  const core = known ? prefix.slice(prefix.length - known.k.length).trim() || known.k : words[words.length - 1]!;
  return `${known && normalizeName(core) !== known.n ? known.k : core} Grand Prix${m.groups.suffix!.replace(/\s+/g, ' ').trimEnd()}`;
}

/** Normalized GP key without "grand prix": "bahrain in malaysia". */
const gpKey = (name: string) => normalizeName(name).replace(/\bgrand prix\b/, ' ').replace(/\s+/g, ' ').trim();

function sameGp(a: string, b: string): boolean {
  const ka = gpKey(a);
  const kb = gpKey(b);
  if (ka === kb) return true;
  return GP_ALIASES.some((group) => group.includes(ka) && group.includes(kb));
}

const Competition = z.object({
  id: z.string(),
  date: z.string(),
  type: z.object({ abbreviation: z.string() }),
  status: z.object({ type: z.object({ name: z.string(), state: z.string(), completed: z.boolean() }) }),
});
const EspnEvent = z.object({
  id: z.string(),
  name: z.string(),
  season: z.object({ year: z.number().int() }),
  circuit: z.object({ fullName: z.string().optional(), address: z.object({ city: z.string().optional(), country: z.string().optional() }).optional() }).optional(),
  competitions: z.array(Competition),
});

function mapStatus(name: string, state: string, completed: boolean): EventStatus {
  if (name === 'STATUS_POSTPONED') return 'POSTPONED';
  if (name === 'STATUS_CANCELED' || name === 'STATUS_CANCELLED') return 'CANCELLED';
  if (state === 'post' && completed) return 'COMPLETED';
  if (state === 'in') return 'IN_PROGRESS';
  if (state === 'pre') return 'SCHEDULED';
  return 'UNKNOWN';
}

/** One race event per Grand Prix weekend, or undefined when the weekend has no race session. Throws on malformed input. */
export function normalizeEspnF1Race(raw: unknown): SportEvent | undefined {
  const e = EspnEvent.parse(raw);
  const race = e.competitions.find((c) => c.type.abbreviation === 'Race');
  if (!race) return undefined;
  const gp = gpName(e.name);
  return {
    id: `f1:espn:${race.id}`,
    sport: 'f1',
    competition: 'Formula 1',
    competitionId: 'F1',
    provider: 'espn',
    providerEventId: race.id,
    season: e.season.year,
    startTime: new Date(race.date).toISOString(),
    status: mapStatus(race.status.type.name, race.status.type.state, race.status.type.completed),
    providerStatus: race.status.type.name,
    stage: 'Race',
    participants: [],
    meta: { gp, espnName: e.name, weekendId: e.id, circuit: e.circuit?.fullName ?? null, country: e.circuit?.address?.country ?? null },
  };
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');

export async function fetchF1Races(transport: Transport, window: Window): Promise<EventFetchResult> {
  const url = new URL(BASE);
  // Pad a few days: weekends start days before the race, and dates are interpreted in US time.
  url.searchParams.set('dates', `${ymd(Date.parse(window.start) - 4 * 86_400_000)}-${ymd(Date.parse(window.end) + 86_400_000)}`);
  const issues: string[] = [];
  let body: unknown;
  try {
    body = await getJson(transport, url);
  } catch (err) {
    return { events: [], complete: false, issues: [`ESPN F1: ${(err as Error).message}`], requests: 1 };
  }
  const board = z.object({ events: z.array(z.unknown()) }).safeParse(body);
  if (!board.success) return { events: [], complete: false, issues: ['ESPN F1: malformed scoreboard (no events array)'], requests: 1 };
  const events: SportEvent[] = [];
  for (const raw of board.data.events) {
    try {
      const ev = normalizeEspnF1Race(raw);
      if (ev && ev.startTime >= window.start && ev.startTime < window.end) events.push(ev);
    } catch (err) {
      issues.push(`ESPN F1: malformed event ${String((raw as { id?: unknown })?.id ?? '?')}: ${(err as Error).message.slice(0, 160)}`);
    }
  }
  events.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return { events, complete: issues.length === 0, issues, requests: 1 };
}

export interface ParsedF1Title {
  year?: number;
  gp: string;
}

const TITLE = /^Race Highlights\s*\|\s*(?:(?<year>\d{4})\s+)?(?<gp>.+?\bGrand Prix\b.*?)\s*$/i;

export function parseF1Title(title: string): ParsedF1Title | undefined {
  const m = TITLE.exec(title.trim());
  if (!m?.groups) return undefined;
  return { gp: m.groups.gp!, ...(m.groups.year ? { year: Number(m.groups.year) } : {}) };
}

export const f1Adapter: SportAdapter<ParsedF1Title> = {
  sport: 'f1',
  label: 'Formula 1',
  fetchEvents: ({ transport, window }) => fetchF1Races(transport, window),
  follow(_e, prefs) {
    const f1 = prefs.sports.f1;
    return f1?.enabled && f1.sessions.includes('race') ? { followed: true, priority: PRIORITY_RANK[f1.priority] } : NOT_FOLLOWED;
  },
  sourceCompetition: () => 'F1',
  parseTitle: parseF1Title,
  related: (e, p) => sameGp(String(e.meta.gp), p.gp),
  match(e, p, input) {
    if (!sameGp(String(e.meta.gp), p.gp)) return reject('grand_prix_differs');
    if (p.year !== undefined && p.year !== e.season) return reject('season_differs');
    const timing = timingRejection(e, input, RACE_DURATION_MS);
    if (timing) return reject(timing);
    return scoreMatch(e, input, { estimatedDurationMs: RACE_DURATION_MS, typicalSeconds: TYPICAL_SECONDS, bonus: { ok: p.year !== undefined, flag: 'year_missing_in_title' } });
  },
  estimatedDurationMs: () => RACE_DURATION_MS,
  neutralTitle: (e) => String(e.meta.gp),
  subtitle: (e) => `Formula 1 · ${e.stage ?? 'Race'}`,
};
