import type { Store } from './store.ts';

/**
 * Project-wide YouTube quota day (user decision 2026-10-03): the publisher may use the project's full daily
 * quota. Once YouTube reports the quota exhausted (from discovery, catalog refresh or publishing), YouTube work
 * stops for the rest of that Pacific-time day and resumes after midnight Pacific, when the quota resets.
 * Nothing is lost: discovery scans back to the oldest event it is still searching for.
 */

const KEY = 'quota_exhausted_day';

/** Pacific-time quota day (YouTube resets quota at midnight Pacific). */
export function quotaDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export function markQuotaExhausted(store: Store, now: string, source: string): void {
  store.setMeta(KEY, JSON.stringify({ day: quotaDay(now), at: now, source }));
}

/** The exhaustion record for the current quota day, if YouTube quota already ran out today. */
export function quotaExhausted(store: Store, now: string): { day: string; at: string; source: string } | undefined {
  const raw = store.getMeta(KEY);
  if (!raw) return undefined;
  const r = JSON.parse(raw) as { day: string; at: string; source: string };
  return r.day === quotaDay(now) ? r : undefined;
}
