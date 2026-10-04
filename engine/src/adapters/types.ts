import type { Preferences } from '../config.ts';
import type { SportEvent, Window } from '../domain.ts';
import type { Transport } from '../http.ts';
import type { Store } from '../store.ts';

/**
 * One adapter per sport. The pipeline is sport-agnostic: it asks the adapter what happened (events),
 * whether the user cares (follow), where trusted highlights live (sourceCompetition), and whether a
 * trusted upload is this event's highlight (parseTitle → related → match).
 */
export interface SportAdapter<P = unknown> {
  readonly sport: string;
  /** Display label, e.g. "Formula 1". */
  readonly label: string;
  fetchEvents(ctx: FetchContext): Promise<EventFetchResult>;
  /** Pure function of preferences and event data, so the catalog can re-evaluate it every build. */
  follow(e: SportEvent, prefs: Preferences): FollowDecision;
  /** Coverage key(s) matched against a source's `competitions` list in config/sources.yaml (the first is the reported key). */
  sourceCompetition(e: SportEvent): string | string[];
  parseTitle(title: string): P | undefined;
  /** Cheap identity check (same participants). Related candidates are recorded even when `match` rejects them. */
  related(e: SportEvent, parsed: P): boolean;
  match(e: SportEvent, parsed: P, input: MatchInput): MatchResult;
  /** Initial hypothesis for event length when the provider gives no end time. */
  estimatedDurationMs(e: SportEvent): number;
  /** Spoiler-free label generated from event data, never from publisher metadata. */
  neutralTitle(e: SportEvent): string;
  subtitle(e: SportEvent): string;
  /** Tournament-shaped sports only: which tournament the event belongs to and how many players were left. */
  tournament?(e: SportEvent): { id: string; major: boolean; playersLeft?: number };
}

export interface FetchContext {
  transport: Transport;
  window: Window;
  prefs: Preferences;
  store: Store;
  now: string;
}

export interface EventFetchResult {
  events: SportEvent[];
  /** False when any request failed or any event was malformed: the result must not be read as "no events". */
  complete: boolean;
  issues: string[];
  requests: number;
  /** Informational notes that do not make the run incomplete (e.g. a still-fresh cached snapshot was used). */
  notes?: string[];
}

export interface FollowDecision {
  followed: boolean;
  /** Preference priority (must 3, high 2, normal 1, low 0); -1 when not followed. */
  priority: number;
  /** Eligibility could not be determined (e.g. stale rankings): the run is incomplete, never "not followed". */
  unknown?: boolean;
  /** Not yet decidable (e.g. TBD participants); not an error. */
  pending?: boolean;
  reason?: string;
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

export const NOT_FOLLOWED: FollowDecision = { followed: false, priority: -1 };
