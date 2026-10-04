import { z } from 'zod';
import { PRIORITY_RANK } from '../../config.ts';
import type { EventStatus, Participant, SportEvent, Window } from '../../domain.ts';
import { getJson, type Transport } from '../../http.ts';
import type { RankingSnapshot, Store } from '../../store.ts';
import { nameRefersTo, normalizeName, reject, scoreMatch, timingRejection } from '../common.ts';
import { NOT_FOLLOWED, type EventFetchResult, type FollowDecision, type SportAdapter } from '../types.ts';

/**
 * ATP singles where either player is ranked at or better than the configured threshold.
 *
 * Observed 2026-10-03:
 * - `tennis/atp/scoreboard?dates=YYYYMMDD` returns the tournaments active that day with their whole draws;
 *   men's singles are `groupings[slug=mens-singles].competitions[]` (one per match, `round.displayName`,
 *   `venue.fullName` "Tokyo, Japan"). Tournament-level status is not used. `winner`/linescores are never parsed.
 * - Rankings: `sports.core…/tennis/leagues/atp/rankings` → latest weekly snapshot ($ref) with `ranks[].current`
 *   and athlete IDs matching scoreboard competitor IDs (3782 Alcaraz, 2375 Zverev, 296 Djokovic).
 *
 * Ranking policy (experimental, recorded in docs/10-sport-integrations/tennis.md): the latest complete snapshot
 * no older than `maxRankingAgeDays`. A fetch failure may fall back to a stored snapshot only if it is complete and
 * still fresh. Stale/missing/partial snapshots make eligibility UNKNOWN and the run incomplete, never "no matches".
 * Eligibility facts (ranks, snapshot ID) are captured in event meta so every run's decision is recorded.
 *
 * ATP Tour titles: "Carlos Alcaraz vs Matteo Arnaldi Highlights | Tokyo 2026 Round 2" (year sometimes missing).
 * ⚠ Name order in these titles usually puts the winner first (7 of 9 checked) — a structural spoiler no title
 * screen can detect; see tennis.md.
 */

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard';
const RANKINGS = 'https://sports.core.api.espn.com/v2/sports/tennis/leagues/atp/rankings';

/** Initial hypotheses: best-of-three on tour, best-of-five at majors. */
const TOUR_MATCH_MS = 150 * 60_000;
const MAJOR_MATCH_MS = 240 * 60_000;
/** ATP Tour packages run ~2–3 minutes (observed 2026-10-03), so the generic 2-minute clip floor is too high here. */
const TYPICAL_SECONDS: [number, number] = [100, 6 * 60];
const MIN_SECONDS = 60;
const DAY_MS = 86_400_000;

// ---- Rankings ------------------------------------------------------------------

const RankIndex = z.object({ items: z.array(z.object({ $ref: z.string() })).min(1) });
const RankSnapshotBody = z.object({
  lastUpdated: z.string(),
  ranks: z.array(z.object({ current: z.number().int(), athlete: z.object({ $ref: z.string() }) })),
});

const https = (ref: string) => ref.replace(/^http:\/\//, 'https://');

export async function fetchAtpRankings(transport: Transport, fetchedAt: string): Promise<{ snapshot?: RankingSnapshot; error?: string; requests: number }> {
  let requests = 0;
  try {
    requests++;
    const index = RankIndex.parse(await getJson(transport, new URL(RANKINGS)));
    const ref = new URL(https(index.items[0]!.$ref));
    requests++;
    const body = RankSnapshotBody.parse(await getJson(transport, ref));
    const ranks: Record<string, number> = {};
    for (const r of body.ranks) {
      const id = /athletes\/(\d+)/.exec(r.athlete.$ref)?.[1];
      if (id) ranks[id] = r.current;
    }
    const id = ref.pathname.replace(/^.*\/leagues\//, '');
    return { snapshot: { id, tour: 'atp', providerUpdatedAt: new Date(body.lastUpdated).toISOString(), fetchedAt, complete: Object.keys(ranks).length > 0, ranks }, requests };
  } catch (err) {
    return { error: (err as Error).message, requests };
  }
}

// ---- Events --------------------------------------------------------------------

const Competition = z.object({
  id: z.string(),
  date: z.string(),
  status: z.object({ type: z.object({ name: z.string(), state: z.string(), completed: z.boolean().optional() }) }),
  round: z.object({ displayName: z.string() }).optional(),
  venue: z.object({ fullName: z.string().optional() }).optional(),
  competitors: z.array(z.object({ id: z.string(), order: z.number().optional(), athlete: z.object({ displayName: z.string(), shortName: z.string().optional() }).optional() })),
});
const Tournament = z.object({
  id: z.string(),
  name: z.string(),
  major: z.boolean().optional(),
  groupings: z.array(z.object({ grouping: z.object({ slug: z.string() }), competitions: z.array(z.unknown()) })).optional(),
});

function mapStatus(name: string, state: string, completed: boolean | undefined): EventStatus {
  if (/WALKOVER|CANCEL|ABANDON/i.test(name)) return 'CANCELLED'; // no match played, so no highlight
  if (name === 'STATUS_POSTPONED') return 'POSTPONED';
  if (state === 'post' && completed !== false) return 'COMPLETED';
  if (state === 'in') return 'IN_PROGRESS';
  if (state === 'pre') return 'SCHEDULED';
  return 'UNKNOWN';
}

const isTbd = (c: { id: string; athlete?: { displayName: string } }) => Number(c.id) < 0 || !c.athlete || /^tbd$/i.test(c.athlete.displayName);

/** Normalize one men's-singles match. Qualifying rounds return undefined. Throws on malformed input. */
export function normalizeAtpMatch(rawComp: unknown, tournament: { id: string; name: string; major?: boolean }): SportEvent | undefined {
  const c = Competition.parse(rawComp);
  const round = c.round?.displayName ?? '';
  if (/qualifying/i.test(round)) return undefined;
  const city = (c.venue?.fullName ?? '').split(',')[0]!.trim() || tournament.name;
  const players = [...c.competitors].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); // draw order, not result
  const participants: Participant[] = players.map((p) =>
    isTbd(p) ? { id: 'TBD', name: 'TBD', shortName: 'TBD', role: 'competitor' } : { id: p.id, name: p.athlete!.displayName, shortName: p.athlete!.shortName ?? p.athlete!.displayName, role: 'competitor' },
  );
  const startTime = new Date(c.date).toISOString();
  return {
    id: `tennis:espn:${c.id}`,
    sport: 'tennis',
    competition: `ATP ${city}`,
    competitionId: tournament.major ? normalizeName(tournament.name) : 'atp',
    provider: 'espn',
    providerEventId: c.id,
    season: Number(startTime.slice(0, 4)),
    startTime,
    status: mapStatus(c.status.type.name, c.status.type.state, c.status.type.completed),
    providerStatus: c.status.type.name,
    stage: round || null,
    participants,
    meta: { tournament: tournament.name, tournamentId: tournament.id, city, major: !!tournament.major },
  };
}

/** Attach the eligibility facts from a snapshot to an event's meta (or mark them unknown). */
function withRanks(e: SportEvent, snapshot: RankingSnapshot | undefined): SportEvent {
  if (!snapshot) return { ...e, meta: { ...e.meta, rankingStatus: 'unknown', rankingSnapshot: null, rankA: null, rankB: null } };
  const rank = (p: Participant | undefined) => (p && p.id !== 'TBD' ? (snapshot.ranks[p.id] ?? null) : null);
  // Absent from a complete snapshot = ranked below its last entry (a known rank outside the list, not a missing one).
  return { ...e, meta: { ...e.meta, rankingStatus: 'ok', rankingSnapshot: snapshot.id, rankA: rank(e.participants[0]), rankB: rank(e.participants[1]) } };
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');

/** Surnames carried by more than one player in a draw (comma-separated, normalized), e.g. "cerundolo". */
function sharedSurnamesIn(competitions: unknown[]): string {
  const byName = new Map<string, Set<string>>();
  for (const raw of competitions) {
    const c = Competition.safeParse(raw);
    if (!c.success) continue;
    for (const p of c.data.competitors) {
      if (isTbd(p)) continue;
      const last = normalizeName(p.athlete!.displayName).split(' ').at(-1)!;
      byName.set(last, (byName.get(last) ?? new Set()).add(p.id));
    }
  }
  return [...byName].filter(([, ids]) => ids.size > 1).map(([n]) => n).sort().join(',');
}

export async function fetchAtpEvents(transport: Transport, window: Window, store: Store, now: string, maxRankingAgeDays: number): Promise<EventFetchResult> {
  const issues: string[] = [];
  const notes: string[] = [];
  let requests = 0;

  // Rankings first: eligibility depends on them.
  const fresh = (s: RankingSnapshot | undefined) => s?.complete && Date.parse(now) - Date.parse(s.providerUpdatedAt) <= maxRankingAgeDays * DAY_MS;
  const fetched = await fetchAtpRankings(transport, now);
  requests += fetched.requests;
  let snapshot: RankingSnapshot | undefined;
  if (fetched.snapshot) {
    store.saveRankingSnapshot(fetched.snapshot);
    if (fresh(fetched.snapshot)) snapshot = fetched.snapshot;
    else issues.push(`ATP rankings snapshot ${fetched.snapshot.id} (updated ${fetched.snapshot.providerUpdatedAt}) is ${fetched.snapshot.complete ? `older than ${maxRankingAgeDays} days` : 'incomplete'}: eligibility unknown`);
  } else {
    const cached = store.latestRankingSnapshot('atp');
    if (fresh(cached)) {
      snapshot = cached;
      notes.push(`ATP rankings fetch failed (${fetched.error}); using cached snapshot ${cached!.id} from ${cached!.providerUpdatedAt}`);
    } else issues.push(`ATP rankings unavailable (${fetched.error}) and no fresh cached snapshot: eligibility unknown`);
  }

  const byId = new Map<string, SportEvent>();
  for (let t = Date.parse(window.start) - DAY_MS; t <= Date.parse(window.end); t += DAY_MS) {
    const url = new URL(SCOREBOARD);
    url.searchParams.set('dates', ymd(t));
    requests++;
    let body: unknown;
    try {
      body = await getJson(transport, url);
    } catch (err) {
      issues.push(`ESPN ATP ${ymd(t)}: ${(err as Error).message}`);
      continue;
    }
    const board = z.object({ events: z.array(z.unknown()) }).safeParse(body);
    if (!board.success) {
      issues.push(`ESPN ATP ${ymd(t)}: malformed scoreboard (no events array)`);
      continue;
    }
    for (const rawT of board.data.events) {
      const tp = Tournament.safeParse(rawT);
      if (!tp.success) {
        issues.push(`ESPN ATP ${ymd(t)}: malformed tournament ${String((rawT as { id?: unknown })?.id ?? '?')}`);
        continue;
      }
      for (const g of tp.data.groupings ?? []) {
        if (g.grouping.slug !== 'mens-singles') continue;
        const sharedSurnames = sharedSurnamesIn(g.competitions);
        for (const rawC of g.competitions) {
          try {
            const ev = normalizeAtpMatch(rawC, tp.data);
            if (ev) ev.meta.sharedSurnames = sharedSurnames;
            if (ev && ev.startTime >= window.start && ev.startTime < window.end) byId.set(ev.id, withRanks(ev, snapshot));
          } catch (err) {
            issues.push(`ESPN ATP: malformed match ${String((rawC as { id?: unknown })?.id ?? '?')}: ${(err as Error).message.slice(0, 160)}`);
          }
        }
      }
    }
  }
  const events = [...byId.values()].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
  return { events, complete: issues.length === 0, issues, requests, notes };
}

// ---- Titles and matching ---------------------------------------------------------

export interface ParsedTennisTitle {
  /** Text before/after " vs " (or Tennis TV's " Faces "): exact names (ATP Tour) or names wrapped in hype (Tennis TV). */
  a: string;
  b: string;
  /** True when a/b may carry hype words around the names ("Drama Filled Valentin Vacherot"). */
  hype: boolean;
  city: string;
  year?: number;
  /** Normalized round when the title names one: "round 1", … "qf", "sf", "f". Tennis TV titles usually omit it. */
  round?: string;
}

/**
 * Tennis TV (preferred, longer packages; observed 2026-10-04). Formats vary widely:
 *   "Drama Filled Valentin Vacherot vs Arthur Fils | Tokyo 2026 Match Highlights"
 *   "Daniil Medvedev Faces Francisco Cerundolo 💪 | Beijing 2026 Highlights"
 *   "Tommy Paul vs Alejandro Tabilo Match Highlights | Tokyo 2026"
 *   "Arthur Fils vs Luca Van Assche High-Quality Match 🔥 | Tokyo 2026"
 *   "Valentin Vacherot vs Alexander Blockx 💥 I Tokyo Match Highlights"        (capital I as the separator)
 *   "Alejandro Davidovich Fokina vs Hubert Hurkacz For The Title 🔥 | Chengdu 2026 Highlights Final"
 *   "Rublev vs Gaston EPIC 🍿 | Hangzhou 2026 Highlights"                       (surnames only)
 * Never parsed: roundups ("…; … & More", "… Feature", "… Highlights Day 4"), doubles, and clips without a "| <City>" part.
 */
const TV_TITLE = /^(?<players>[^|]+?)\s*\|\s*(?<city>[A-Za-z][A-Za-z .'-]*?)(?:\s+(?<year>\d{4}))?(?:\s+(?:Match\s+|Condensed\s+)?Highlights)?(?:\s+(?<round>Round\s+(?:of\s+)?\d+|Quarter-?finals?|Semi-?finals?|Finals?))?\s*$/i;
const CONNECTOR = /\s+(?:vs\.?|faces|battles|takes on|meets)\s+/i;

const TITLE = /^(?<a>.+?)\s+vs\.?\s+(?<b>.+?)\s+Highlights\s*\|\s*(?<city>.+?)(?:\s+(?<year>\d{4}))?\s+(?<round>Round\s+(?:of\s+)?\d+|R\d+|Quarter-?finals?|QF|Semi-?finals?|SF|Finals?)\s*$/i;

/** ESPN "Round 2" / "Quarterfinal" and title "R2" / "Quarter-finals" to one form. */
export function normalizeRound(round: string): string {
  const r = normalizeName(round).replace(/\s+/g, ' ');
  if (/^(quarter ?finals?|qf)$/.test(r)) return 'qf';
  if (/^(semi ?finals?|sf)$/.test(r)) return 'sf';
  if (/^finals?$/.test(r)) return 'f';
  const n = /^(?:round (?:of )?|r)(\d+)$/.exec(r);
  return n ? `round ${n[1]}` : r;
}

export function parseTennisTitle(title: string): ParsedTennisTitle | undefined {
  const t = title.trim().replace(/\s+/g, ' ');
  const m = TITLE.exec(t);
  if (m?.groups) {
    return { a: m.groups.a!, b: m.groups.b!, hype: false, city: m.groups.city!, round: normalizeRound(m.groups.round!), ...(m.groups.year ? { year: Number(m.groups.year) } : {}) };
  }
  // "… 💥 I Tokyo Match Highlights": a capital I used as the separator.
  const tv = TV_TITLE.exec(t.includes('|') ? t : t.replace(/\s+I\s+(?=[A-Z][A-Za-z .'-]*?(?:\s+\d{4})?\s+(?:Match\s+)?Highlights\s*$)/, ' | '));
  if (!tv?.groups || /\bday \d+\b|doubles/i.test(t)) return undefined;
  const players = tv.groups.players!.replace(/\s+(?:match\s+)?highlights\s*$/i, '');
  if (/[;&]|\bmore\b|\bin action\b|\bfeature\b/i.test(players)) return undefined; // several matches in one video
  const parts = players.split(CONNECTOR);
  if (parts.length !== 2) return undefined;
  return {
    a: parts[0]!, b: parts[1]!, hype: true, city: tv.groups.city!.trim(), ...(tv.groups.year ? { year: Number(tv.groups.year) } : {}),
    ...(tv.groups.round ? { round: normalizeRound(tv.groups.round) } : {}),
  };
}

/** Tournament names used in place of the city in some titles. */
const CITY_ALIASES: string[][] = [['beijing', 'china'], ['tokyo', 'japan']];
/** "Hangzhou Open" = "Hangzhou". */
const cityKey = (s: string) => normalizeName(s).replace(/\s+(open|masters|championships?)$/, '');
const sameCity = (a: string, b: string) => {
  const x = cityKey(a);
  const y = cityKey(b);
  return x === y || CITY_ALIASES.some((g) => g.includes(x) && g.includes(y));
};

/**
 * The name may be wrapped in hype: a run of words at the inner edge (end of a, start of b) must refer to the player —
 * 2–4 words as a (possibly shortened) full name, or a bare surname only when no two players in this tournament's draw
 * share it (e.g. the Cerundolo brothers never match by surname).
 */
const words = (s: string) => normalizeName(s.replace(/['’]s\b/gi, '')).split(' ').filter(Boolean); // "Nishikori's" → "nishikori"
const surname = (full: string) => words(full).at(-1) ?? '';
const refersTo = (run: string[], full: string, shared: Set<string>) =>
  run.length === 1 ? run[0] === surname(full) && !shared.has(run[0]!) : nameRefersTo(run.join(' '), full);
const refersAtEnd = (text: string, full: string, shared: Set<string>) => [1, 2, 3, 4].some((k) => words(text).length >= k && refersTo(words(text).slice(-k), full, shared));
const refersAtStart = (text: string, full: string, shared: Set<string>) => [1, 2, 3, 4].some((k) => words(text).length >= k && refersTo(words(text).slice(0, k), full, shared));

const playersMatch = (e: SportEvent, p: ParsedTennisTitle) => {
  const [x, y] = e.participants;
  if (!x || !y || x.id === 'TBD' || y.id === 'TBD') return false;
  const shared = new Set(String(e.meta.sharedSurnames ?? '').split(',').filter(Boolean));
  const pair = (l: string, r: string) => (p.hype ? refersAtEnd(p.a, l, shared) && refersAtStart(p.b, r, shared) : nameRefersTo(p.a, l) && nameRefersTo(p.b, r));
  return pair(x.name, y.name) || pair(y.name, x.name);
};

const duration = (e: SportEvent) => (e.meta.major ? MAJOR_MATCH_MS : TOUR_MATCH_MS);

/**
 * Players left at this stage: QF 8, SF 4, F 2, "Round of 16" 16. Numbered rounds only have a fixed meaning in a
 * Grand Slam's 128-player main draw (Round 4 = 16 left); on tour their size depends on the draw, so undefined.
 */
export function playersLeft(stage: string | null, major: boolean): number | undefined {
  const r = normalizeRound(stage ?? '');
  if (r === 'qf') return 8;
  if (r === 'sf') return 4;
  if (r === 'f') return 2;
  const n = Number(/^round (\d+)$/.exec(r)?.[1]);
  if (!n) return undefined;
  if (n >= 8) return n; // "Round of 16"
  return major ? 128 / 2 ** (n - 1) : undefined;
}

export const tennisAdapter: SportAdapter<ParsedTennisTitle> = {
  sport: 'tennis',
  label: 'Tennis',
  fetchEvents: ({ transport, window, store, now, prefs }) => fetchAtpEvents(transport, window, store, now, prefs.sports.tennis?.maxRankingAgeDays ?? 10),

  follow(e, prefs): FollowDecision {
    const tennis = prefs.sports.tennis;
    if (!tennis?.enabled) return NOT_FOLLOWED;
    if (e.participants.some((p) => p.id === 'TBD')) return { ...NOT_FOLLOWED, pending: true, reason: 'participants_tbd' };
    if (e.meta.rankingStatus !== 'ok') return { ...NOT_FOLLOWED, unknown: true, reason: 'ranking_unknown' };
    const ranks = [e.meta.rankA, e.meta.rankB].filter((r): r is number => typeof r === 'number');
    const best = ranks.length ? Math.min(...ranks) : undefined;
    const reason = `ranks ${e.meta.rankA ?? '>list'}/${e.meta.rankB ?? '>list'} (snapshot ${e.meta.rankingSnapshot})`;
    return best !== undefined && best <= tennis.rankThreshold ? { followed: true, priority: PRIORITY_RANK[tennis.priority], reason } : { ...NOT_FOLLOWED, reason };
  },

  sourceCompetition: (e) => e.competitionId,
  parseTitle: parseTennisTitle,
  related: (e, p) => playersMatch(e, p),
  match(e, p, input) {
    if (!playersMatch(e, p)) return reject('players_differ');
    if (!sameCity(p.city, String(e.meta.city))) return reject('tournament_differs');
    // A single-elimination draw has each matchup once per tournament, so players + city + year identify it when the round is absent.
    if (p.round !== undefined && p.round !== normalizeRound(e.stage ?? '')) return reject('round_differs');
    if (p.year !== undefined && p.year !== e.season) return reject('season_differs');
    const timing = timingRejection(e, input, duration(e), 72, MIN_SECONDS);
    if (timing) return reject(timing);
    return scoreMatch(e, input, { estimatedDurationMs: duration(e), typicalSeconds: TYPICAL_SECONDS, bonus: { ok: p.year !== undefined, flag: 'year_missing_in_title' } });
  },
  estimatedDurationMs: duration,
  neutralTitle: (e) => e.participants.map((p) => p.name).join(' vs '),
  subtitle: (e) => `${e.competition}${e.stage ? ` · ${e.stage}` : ''}`,
  tournament: (e) => ({ id: String(e.meta.tournamentId ?? e.competition), major: !!e.meta.major, playersLeft: playersLeft(e.stage, !!e.meta.major) }),
};
