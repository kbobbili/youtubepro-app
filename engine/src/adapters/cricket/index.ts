import { z } from 'zod';
import { PRIORITY_RANK } from '../../config.ts';
import type { EventStatus, Participant, SportEvent, Window } from '../../domain.ts';
import { getJson, type Transport } from '../../http.ts';
import { nameRefersTo, reject, scoreMatch, timingRejection } from '../common.ts';
import { NOT_FOLLOWED, type EventFetchResult, type SportAdapter } from '../types.ts';

/**
 * Men's limited-overs internationals (ODI, T20I) involving followed nations.
 *
 * Observed 2026-10-03: `cricket/scorepanel?dates=YYYYMMDD` lists that day's matches grouped by series
 * (`scores[].leagues[0]` = series id/name). `competitions[0].class.internationalClassId`: 2 = men's ODI,
 * 3 = men's T20I (9/10 women's, 14 youth, 0 domestic). Completion: `status.type.state = "post"` with
 * description "Result"; "No result"/"Abandoned" mean no match to highlight. Result text is never parsed.
 *
 * Sources resolve per series (`series:<ESPN series id>`), only where coverage was observed (config/sources.yaml);
 * there is no blanket "bilateral → Willow" rule. Test cricket is deferred (needs day-part modelling).
 *
 * Willow titles: "Highlights: 2nd ODI, South Africa vs Australia | SA vs AUS",
 *                "Highlights : 3rd T20I, Afghanistan vs India | IND vs AFG", "Highlights: 3rd T20I - England vs Sri Lanka".
 */

const SCOREPANEL = 'https://site.api.espn.com/apis/site/v2/sports/cricket/scorepanel';
const FORMAT_BY_CLASS: Record<string, 'ODI' | 'T20I'> = { '2': 'ODI', '3': 'T20I' };

/** Initial hypotheses for match length. */
const DURATION_MS = { ODI: 8 * 3_600_000, T20I: 3.5 * 3_600_000 } as const;
const TYPICAL_SECONDS: [number, number] = [3 * 60, 30 * 60];
const DAY_MS = 86_400_000;

const Event = z.object({
  id: z.string(),
  date: z.string(),
  status: z.object({ type: z.object({ state: z.string().optional(), description: z.string().optional(), name: z.string().optional() }) }).optional(),
  season: z.object({ year: z.number().int() }).optional(),
  competitions: z
    .array(
      z.object({
        description: z.string().optional(),
        class: z.object({ internationalClassId: z.union([z.string(), z.number()]).optional() }).optional(),
        venue: z.object({ fullName: z.string().optional(), address: z.object({ country: z.string().optional() }).optional() }).optional(),
        competitors: z.array(z.object({ homeAway: z.string().optional(), team: z.object({ id: z.string(), displayName: z.string(), abbreviation: z.string().optional() }) })).length(2),
      }),
    )
    .min(1),
});
const Series = z.object({ id: z.string(), name: z.string() });

function mapStatus(state: string | undefined, description: string | undefined): EventStatus {
  if (/no result|abandon|cancel/i.test(description ?? '')) return 'CANCELLED';
  if (/postpone/i.test(description ?? '')) return 'POSTPONED';
  if (state === 'post') return 'COMPLETED';
  if (state === 'in') return 'IN_PROGRESS';
  if (state === 'pre') return 'SCHEDULED';
  return 'UNKNOWN';
}

/** "2nd ODI" → 2; ICC-style "127th Match" → 127; "Final" → undefined. */
const matchNumber = (description: string) => {
  const m = /^(\d+)(?:st|nd|rd|th)\b/i.exec(description.trim());
  return m ? Number(m[1]) : undefined;
};

/** Normalize one men's ODI/T20I; other classes return undefined. Throws on malformed input. */
export function normalizeCricketMatch(raw: unknown, series: { id: string; name: string }): SportEvent | undefined {
  const e = Event.parse(raw);
  const c = e.competitions[0]!;
  const format = FORMAT_BY_CLASS[String(c.class?.internationalClassId ?? '')];
  if (!format) return undefined;
  const [first, second] = c.competitors;
  const participant = (x: typeof first, fallback: 'home' | 'away'): Participant => ({
    id: x!.team.id, name: x!.team.displayName, shortName: x!.team.abbreviation ?? x!.team.displayName, ...(x!.team.abbreviation ? { abbr: x!.team.abbreviation } : {}),
    role: x!.homeAway === 'home' || x!.homeAway === 'away' ? x!.homeAway : fallback,
  });
  const description = c.description ?? format;
  const startTime = new Date(e.date).toISOString();
  return {
    id: `cricket:espn:${e.id}`,
    sport: 'cricket',
    competition: series.name,
    competitionId: `series:${series.id}`,
    provider: 'espn',
    providerEventId: e.id,
    season: e.season?.year ?? Number(startTime.slice(0, 4)),
    startTime,
    status: mapStatus(e.status?.type.state, e.status?.type.description),
    providerStatus: e.status?.type.description ?? e.status?.type.name ?? 'unknown',
    stage: description,
    participants: [participant(first, 'home'), participant(second, 'away')].sort((a, b) => (a.role === 'home' ? -1 : b.role === 'home' ? 1 : 0)),
    meta: { format, matchNumber: matchNumber(description) ?? null, seriesId: series.id, icc: /^ICC\b/i.test(series.name), country: c.venue?.address?.country ?? null },
  };
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');

export async function fetchCricketEvents(transport: Transport, window: Window): Promise<EventFetchResult> {
  const byId = new Map<string, SportEvent>();
  const issues: string[] = [];
  let requests = 0;
  for (let t = Date.parse(window.start) - DAY_MS; t <= Date.parse(window.end); t += DAY_MS) {
    const url = new URL(SCOREPANEL);
    url.searchParams.set('dates', ymd(t));
    requests++;
    let body: unknown;
    try {
      body = await getJson(transport, url);
    } catch (err) {
      issues.push(`ESPN cricket ${ymd(t)}: ${(err as Error).message}`);
      continue;
    }
    const panel = z.object({ scores: z.array(z.object({ leagues: z.array(z.unknown()).optional(), events: z.array(z.unknown()).optional() })) }).safeParse(body);
    if (!panel.success) {
      issues.push(`ESPN cricket ${ymd(t)}: malformed scorepanel`);
      continue;
    }
    for (const group of panel.data.scores) {
      const series = Series.safeParse(group.leagues?.[0]);
      for (const raw of group.events ?? []) {
        if (!series.success) {
          issues.push(`ESPN cricket ${ymd(t)}: event ${String((raw as { id?: unknown })?.id ?? '?')} without series`);
          continue;
        }
        try {
          const ev = normalizeCricketMatch(raw, series.data);
          if (ev && ev.startTime >= window.start && ev.startTime < window.end) byId.set(ev.id, ev);
        } catch (err) {
          issues.push(`ESPN cricket: malformed match ${String((raw as { id?: unknown })?.id ?? '?')}: ${(err as Error).message.slice(0, 160)}`);
        }
      }
    }
  }
  const events = [...byId.values()].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
  return { events, complete: issues.length === 0, issues, requests };
}

export interface ParsedCricketTitle {
  matchNumber: number;
  format: 'ODI' | 'T20I';
  a: string;
  b: string;
}

const TITLE = /^Highlights\s*:\s*(?<num>\d+)(?:st|nd|rd|th)\s+(?<fmt>ODI|T20I)\s*[,\-–]?\s*(?<a>.+?)\s+vs\.?\s+(?<b>.+?)(?:\s*\|.*)?$/i;

export function parseCricketTitle(title: string): ParsedCricketTitle | undefined {
  const m = TITLE.exec(title.trim().replace(/\s+/g, ' '));
  if (!m?.groups) return undefined;
  return { matchNumber: Number(m.groups.num), format: m.groups.fmt!.toUpperCase() === 'ODI' ? 'ODI' : 'T20I', a: m.groups.a!.trim(), b: m.groups.b!.trim() };
}

/** Exact team identity: "India" never matches "India Women" or "India A". */
const isTeam = (text: string, p: Participant) => nameRefersTo(text, p.name) && nameRefersTo(p.name, text);
const teamsMatch = (e: SportEvent, p: ParsedCricketTitle) => {
  const [x, y] = e.participants;
  return !!x && !!y && ((isTeam(p.a, x) && isTeam(p.b, y)) || (isTeam(p.a, y) && isTeam(p.b, x)));
};
const duration = (e: SportEvent) => DURATION_MS[e.meta.format === 'T20I' ? 'T20I' : 'ODI'];

export const cricketAdapter: SportAdapter<ParsedCricketTitle> = {
  sport: 'cricket',
  label: 'Cricket',
  fetchEvents: ({ transport, window }) => fetchCricketEvents(transport, window),
  follow(e, prefs) {
    const cricket = prefs.sports.cricket;
    if (!cricket?.enabled || !cricket.formats.includes(e.meta.format as 'ODI' | 'T20I')) return NOT_FOLLOWED;
    if (e.meta.icc && !cricket.includeIcc) return NOT_FOLLOWED;
    const ids = new Set(e.participants.map((p) => p.id));
    const hits = cricket.teams.filter((t) => ids.has(t.id));
    return hits.length ? { followed: true, priority: Math.max(...hits.map((t) => PRIORITY_RANK[t.priority])) } : NOT_FOLLOWED;
  },
  sourceCompetition: (e) => e.competitionId,
  parseTitle: parseCricketTitle,
  related: (e, p) => teamsMatch(e, p),
  match(e, p, input) {
    if (!teamsMatch(e, p)) return reject('teams_differ');
    if (p.format !== e.meta.format) return reject('format_differs');
    if (p.matchNumber !== e.meta.matchNumber) return reject('match_number_differs');
    const timing = timingRejection(e, input, duration(e));
    if (timing) return reject(timing);
    return scoreMatch(e, input, { estimatedDurationMs: duration(e), typicalSeconds: TYPICAL_SECONDS });
  },
  estimatedDurationMs: duration,
  neutralTitle: (e) => e.participants.map((p) => p.name).join(' vs '),
  subtitle: (e) => `${e.stage ?? e.meta.format} · ${e.competition}`,
};
