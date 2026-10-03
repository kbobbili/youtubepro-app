/** Normalized, provider-independent event model. Scores are deliberately not ingested. */

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

export interface SportEvent {
  /** Stable internal ID: "<sport>:<provider>:<providerEventId>". */
  id: string;
  sport: string;
  competition: string;
  provider: string;
  providerEventId: string;
  season: number;
  /** 1 = preseason, 2 = regular season, 3 = postseason (ESPN convention). */
  seasonType: number;
  week: number;
  startTime: string;
  status: EventStatus;
  /** Provider's raw status name, kept for diagnostics. */
  providerStatus: string;
  home: Team;
  away: Team;
}

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
  stage: 'events' | 'sources' | 'youtube' | 'store';
  message: string;
}
