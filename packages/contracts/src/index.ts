import { z } from 'zod';

/**
 * Library snapshot: the only data the TV client receives from the engine.
 *
 * Spoiler invariant: items carry an engine-generated neutral title only. No raw
 * publisher titles, descriptions, scores, results, or publisher thumbnails.
 */
export const LIBRARY_SCHEMA_VERSION = 1;

/** Evidence that a video actually played in a given environment. API metadata never sets this. */
export const PlaybackVerification = z.enum(['NOT_TESTED', 'VERIFIED', 'FAILED']);
export type PlaybackVerification = z.infer<typeof PlaybackVerification>;

export const LibraryItem = z
  .object({
    eventId: z.string().min(1),
    sport: z.string().min(1),
    competition: z.string().min(1),
    /** Neutral, spoiler-free label, e.g. "Los Angeles Chargers at Buffalo Bills". */
    neutralTitle: z.string().min(1),
    /** Neutral context, e.g. "NFL · Week 3". */
    subtitle: z.string(),
    eventStartTime: z.iso.datetime(),
    video: z
      .object({
        platform: z.literal('youtube'),
        videoId: z.string().min(1),
        durationSeconds: z.number().int().nonnegative(),
        publishedAt: z.iso.datetime(),
      })
      .strict(),
    source: z
      .object({
        id: z.string().min(1),
        displayName: z.string().min(1),
        tier: z.number().int().min(1).max(3),
      })
      .strict(),
    /** The candidate passed API metadata screening (embeddable, region, age, not live). Not playback proof. */
    metadataEligible: z.literal(true),
    targetDevicePlayback: PlaybackVerification,
  })
  .strict();
export type LibraryItem = z.infer<typeof LibraryItem>;

export const LibrarySnapshot = z
  .object({
    schemaVersion: z.literal(LIBRARY_SCHEMA_VERSION),
    generatedAt: z.iso.datetime(),
    region: z.string().length(2),
    items: z.array(LibraryItem),
  })
  .strict();
export type LibrarySnapshot = z.infer<typeof LibrarySnapshot>;

/**
 * Catalog snapshot: front-end-agnostic collections (browsing lists) over stored events and highlights.
 * Versioned separately from the library snapshot, whose v1 shape is frozen.
 *
 * Same spoiler invariant as the library: neutral engine titles only, never publisher titles or results.
 * Delivering a collection to a player that shows publisher titles (e.g. a YouTube playlist) is gated by
 * each item's title screen, which is a heuristic, not proof of spoiler safety.
 */
export const CATALOG_SCHEMA_VERSION = 1;

export const TitleScreenStatus = z.enum(['flagged', 'unflagged', 'unreviewed']);

export const CatalogItem = z
  .object({
    eventId: z.string().min(1),
    sport: z.string().min(1),
    competition: z.string().min(1),
    neutralTitle: z.string().min(1),
    subtitle: z.string(),
    eventStartTime: z.iso.datetime(),
    /** Preference priority used for capped selection (must 3, high 2, normal 1, low 0). */
    priority: z.number().int(),
    video: LibraryItem.shape.video,
    source: LibraryItem.shape.source,
    /** Title screen status. Non-'unflagged' items appear only under an explicit configuration override. */
    titleScreen: TitleScreenStatus,
  })
  .strict();
export type CatalogItem = z.infer<typeof CatalogItem>;

export const CatalogExclusion = z.object({ eventId: z.string().min(1), videoId: z.string().optional(), reason: z.string().min(1) }).strict();
export type CatalogExclusion = z.infer<typeof CatalogExclusion>;

export const CatalogCollection = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    kind: z.enum(['mixed', 'sport', 'team']),
    publish: z.boolean(),
    /**
     * complete: inputs were complete and fresh, so the items are the full desired list (possibly empty).
     * incomplete: inputs were missing or stale; consumers must keep their last-known-good copy.
     */
    status: z.enum(['complete', 'incomplete']),
    issues: z.array(z.string()),
    window: z.object({ start: z.iso.datetime(), end: z.iso.datetime() }).strict(),
    /** Stored history starts here; the catalog does not claim a backfill before it. */
    coverage: z.object({ storedHistoryFrom: z.iso.datetime().nullable() }).strict(),
    /** Ordered by event start time (oldest first), ties by event ID. */
    items: z.array(CatalogItem),
    exclusions: z.array(CatalogExclusion),
  })
  .strict();
export type CatalogCollection = z.infer<typeof CatalogCollection>;

export const CatalogSnapshot = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    generatedAt: z.iso.datetime(),
    region: z.string().length(2),
    configRevision: z.string().min(1),
    /** Discovery runs whose results the catalog reflects (latest personal run per sport). */
    sourceRuns: z.array(z.object({ sport: z.string(), runId: z.string(), status: z.enum(['ok', 'incomplete', 'failed']).nullable(), startedAt: z.string() }).strict()),
    titleOverrides: z.object({ includeFlaggedTitles: z.boolean(), includeUnreviewedTitles: z.boolean() }).strict(),
    collections: z.array(CatalogCollection),
  })
  .strict();
export type CatalogSnapshot = z.infer<typeof CatalogSnapshot>;
