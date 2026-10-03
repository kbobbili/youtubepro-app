import { z } from 'zod';
import type { EventStatus, SportEvent, Window } from '../../domain.ts';
import { getJson, type Transport } from '../../http.ts';

/**
 * NFL events from ESPN's public (unofficial, undocumented) scoreboard JSON.
 *
 * Observed 2026-10-02: `?dates=YYYYMMDD` returns games on that US Eastern calendar date;
 * date ranges (`YYYYMMDD-YYYYMMDD`) return HTTP 400. A day without games returns `events: []`.
 * Scores are present in the response but intentionally not parsed.
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

const Competitor = z.object({
  homeAway: z.enum(['home', 'away']),
  team: z.object({
    abbreviation: z.string().min(1),
    displayName: z.string().min(1),
    shortDisplayName: z.string().min(1),
  }),
});

const EspnEvent = z.object({
  id: z.string().min(1),
  date: z.string().min(1),
  season: z.object({ year: z.number().int(), type: z.number().int() }),
  week: z.object({ number: z.number().int() }),
  status: z.object({
    type: z.object({ name: z.string(), state: z.string(), completed: z.boolean() }),
  }),
  competitions: z.array(z.object({ competitors: z.array(Competitor).length(2) })).min(1),
});

const Scoreboard = z.object({ events: z.array(z.unknown()) });

export interface EventFetchResult {
  events: SportEvent[];
  /** False when any date failed or any event was malformed: the result must not be read as "no games". */
  complete: boolean;
  issues: string[];
  requests: number;
}

function mapStatus(name: string, state: string, completed: boolean): EventStatus {
  if (name === 'STATUS_POSTPONED') return 'POSTPONED';
  if (name === 'STATUS_CANCELED' || name === 'STATUS_CANCELLED') return 'CANCELLED';
  if (state === 'post' && completed) return 'COMPLETED';
  if (state === 'in') return 'IN_PROGRESS';
  if (state === 'pre') return 'SCHEDULED';
  return 'UNKNOWN';
}

/** Normalize one raw ESPN event. Throws on malformed input. */
export function normalizeEspnNflEvent(raw: unknown): SportEvent {
  const e = EspnEvent.parse(raw);
  const competitors = e.competitions[0]!.competitors;
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');
  if (!home || !away) throw new Error(`event ${e.id}: missing home/away competitor`);
  const team = (c: z.infer<typeof Competitor>) => ({
    abbr: c.team.abbreviation,
    name: c.team.displayName,
    shortName: c.team.shortDisplayName,
  });
  return {
    id: `nfl:espn:${e.id}`,
    sport: 'nfl',
    competition: 'NFL',
    provider: 'espn',
    providerEventId: e.id,
    season: e.season.year,
    seasonType: e.season.type,
    week: e.week.number,
    // ESPN uses minute precision ("2026-09-27T17:00Z"); store full ISO.
    startTime: new Date(e.date).toISOString(),
    status: mapStatus(e.status.type.name, e.status.type.state, e.status.type.completed),
    providerStatus: e.status.type.name,
    home: team(home),
    away: team(away),
  };
}

/** US Eastern calendar dates (YYYYMMDD) covering the window, padded one day each side. */
export function easternDatesFor(window: Window): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = 86_400_000;
  const dates = new Set<string>();
  for (let t = Date.parse(window.start) - day; t <= Date.parse(window.end) + day; t += day / 2) {
    dates.add(fmt.format(new Date(t)).replaceAll('-', ''));
  }
  return [...dates].sort();
}

export async function fetchNflEvents(transport: Transport, window: Window): Promise<EventFetchResult> {
  const byId = new Map<string, SportEvent>();
  const issues: string[] = [];
  let requests = 0;
  for (const date of easternDatesFor(window)) {
    const url = new URL(BASE);
    url.searchParams.set('dates', date);
    requests++;
    let body: unknown;
    try {
      body = await getJson(transport, url);
    } catch (err) {
      issues.push(`ESPN ${date}: ${(err as Error).message}`);
      continue;
    }
    const board = Scoreboard.safeParse(body);
    if (!board.success) {
      issues.push(`ESPN ${date}: malformed scoreboard (no events array)`);
      continue;
    }
    for (const raw of board.data.events) {
      try {
        const ev = normalizeEspnNflEvent(raw);
        if (ev.startTime >= window.start && ev.startTime < window.end) byId.set(ev.id, ev);
      } catch (err) {
        const id = (raw as { id?: unknown })?.id ?? '?';
        issues.push(`ESPN ${date}: malformed event ${String(id)}: ${(err as Error).message.slice(0, 160)}`);
      }
    }
  }
  const events = [...byId.values()].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
  return { events, complete: issues.length === 0, issues, requests };
}
