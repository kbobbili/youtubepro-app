/** Normalized, provider-independent event model. Scores and results are deliberately not ingested. */

export type EventStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'POSTPONED' | 'CANCELLED' | 'UNKNOWN';

export type DiscoveryStatus = 'WAITING_FOR_EVENT_END' | 'SEARCHING' | 'FOUND' | 'UNAVAILABLE';

export interface Team {
  /** Provider team abbreviation, e.g. "BUF". */
  abbr: string;
  /** Full name, e.g. "Buffalo Bills". */
  name: string;
  /** Short name, e.g. "Bills". */
  shortName: string;
}

/** A team or player taking part in an event. Never carries a result. */
export interface Participant {
  /** Stable provider identity used for preferences and team collections (NFL: abbreviation; others: ESPN ID). */
  id: string;
  name: string;
  shortName: string;
  abbr?: string;
  /** home/away for team sports with a designated home side; competitor otherwise. */
  role: 'home' | 'away' | 'competitor';
}

/** Scalar, result-free event context (e.g. NFL week, tennis round, cricket format and match number). */
export type EventMeta = Record<string, string | number | boolean | null>;

export interface SportEvent {
  /** Stable internal ID: "<sport>:<provider>:<providerEventId>". */
  id: string;
  sport: string;
  /** Display label, e.g. "NFL", "Premier League", "ATP Tokyo". */
  competition: string;
  /** Source-resolution key, e.g. "NFL", "eng.1", "atp", "F1", "bilateral". */
  competitionId: string;
  provider: string;
  providerEventId: string;
  /** Season year where the provider supplies one. */
  season: number | null;
  startTime: string;
  status: EventStatus;
  /** Provider's raw status name, kept for diagnostics. */
  providerStatus: string;
  /** Neutral stage label, e.g. "Week 3", "Quarterfinal", "Race", "2nd ODI". */
  stage: string | null;
  participants: Participant[];
  meta: EventMeta;
}

/** NFL keeps its original fields (stored in the legacy event columns) alongside the generic ones. */
export interface NflEvent extends SportEvent {
  season: number;
  /** 1 = preseason, 2 = regular season, 3 = postseason (ESPN convention). */
  seasonType: number;
  week: number;
  home: Team;
  away: Team;
}

export const isNflEvent = (e: SportEvent): e is NflEvent => e.sport === 'nfl' && 'home' in e && 'week' in e;

export interface Window {
  /** Inclusive, UTC ISO. */
  start: string;
  /** Exclusive, UTC ISO. */
  end: string;
}

export type Cohort = 'personal' | 'diagnostic';
export type RunKind = 'prospective' | 'backfill' | 'manual';
export type RunStatus = 'ok' | 'incomplete' | 'failed';

export interface RunIssue {
  stage: 'events' | 'eligibility' | 'sources' | 'youtube' | 'store';
  message: string;
}
