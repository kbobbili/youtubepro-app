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
