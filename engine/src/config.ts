import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Repository root: the directory containing pnpm-workspace.yaml. */
export function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate repository root (pnpm-workspace.yaml)');
    dir = parent;
  }
  return dir;
}

/** Load `.env` from the repo root if present, without overriding variables already set. */
export function loadEnv(root = repoRoot()): void {
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

/** One key for one Google Cloud project. Keys are never rotated to stretch quota. */
export function youtubeApiKey(): string {
  const key = process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY_1;
  if (!key) throw new Error('Missing YOUTUBE_API_KEY (or YOUTUBE_API_KEY_1) in .env');
  return key;
}

// ---- Source registry -------------------------------------------------------

const Verification = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('verified'),
    verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Official publisher page that links to the channel. */
    evidenceUrl: z.string().url(),
    method: z.string().min(1),
  }),
  z.object({ status: z.literal('candidate'), notes: z.string().optional() }),
]);

export const Source = z.object({
  id: z.string().min(1),
  sport: z.string().min(1),
  displayName: z.string().min(1),
  tier: z.number().int().min(1).max(3),
  platform: z.literal('youtube'),
  channelId: z.string().regex(/^UC[\w-]{22}$/),
  enabled: z.boolean(),
  regions: z.array(z.string().length(2)).min(1),
  competitions: z.array(z.string()).min(1),
  verification: Verification,
});
export type Source = z.infer<typeof Source>;

const Registry = z.object({ sources: z.array(Source) });

export function loadSources(root = repoRoot()): Source[] {
  const raw = parseYaml(fs.readFileSync(path.join(root, 'config', 'sources.yaml'), 'utf8'));
  const { sources } = Registry.parse(raw);
  const ids = new Set<string>();
  for (const s of sources) {
    if (ids.has(s.id)) throw new Error(`Duplicate source id ${s.id}`);
    ids.add(s.id);
  }
  return sources;
}

/** Only enabled AND verified sources are trusted, scoped to sport, competition, and region. */
export function trustedSources(sources: Source[], sport: string, competition: string, region: string): Source[] {
  return sources
    .filter((s) => s.enabled && s.verification.status === 'verified')
    .filter((s) => s.sport === sport && s.competitions.includes(competition) && s.regions.includes(region))
    .sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id));
}

// ---- Preferences -----------------------------------------------------------

const Priority = z.enum(['must', 'high', 'normal', 'low']);
/** A followed team by ESPN team ID (`name` is for readability). */
const TeamPref = z.object({ id: z.string().min(1), name: z.string().min(1), priority: Priority });

const Preferences = z.object({
  region: z.string().length(2),
  sports: z.object({
    nfl: z
      .object({
        enabled: z.boolean(),
        teams: z.array(z.object({ abbr: z.string().min(1), name: z.string().min(1), priority: Priority })),
      })
      .optional(),
    f1: z.object({ enabled: z.boolean(), sessions: z.array(z.literal('race')).min(1), priority: Priority }).optional(),
    soccer: z.object({ enabled: z.boolean(), teams: z.array(TeamPref) }).optional(),
    tennis: z
      .object({
        enabled: z.boolean(),
        tour: z.literal('atp'),
        /** A match is followed when either player's rank is at or better than this. */
        rankThreshold: z.number().int().min(1),
        /** Older ranking snapshots make eligibility unknown (incomplete run), never "no matches". */
        maxRankingAgeDays: z.number().positive(),
        priority: Priority,
      })
      .optional(),
    cricket: z
      .object({
        enabled: z.boolean(),
        /** Men's limited-overs internationals; Tests are deferred. */
        formats: z.array(z.enum(['ODI', 'T20I'])).min(1),
        teams: z.array(TeamPref),
        includeIcc: z.boolean(),
      })
      .optional(),
  }),
});
export type Preferences = z.infer<typeof Preferences>;

export function loadPreferences(root = repoRoot()): Preferences {
  return Preferences.parse(parseYaml(fs.readFileSync(path.join(root, 'config', 'preferences.yaml'), 'utf8')));
}

export const PRIORITY_RANK = { must: 3, high: 2, normal: 1, low: 0 } as const;

// ---- Collections (playlist-delivery experiment) ----------------------------

/** Stage reached, by players left: r16 = round of 16, qf = quarterfinals, sf = semifinals, f = final. */
export const Stage = z.enum(['r16', 'qf', 'sf', 'f']);
export const STAGE_PLAYERS = { r16: 16, qf: 8, sf: 4, f: 2 } as const;

/**
 * Which watchable highlights a collection keeps (user decisions 2026-10-03). Only items that pass every
 * eligibility check count, so a match without a trusted source never takes a slot. Leaving a collection never
 * deletes stored history.
 */
export const Keep = z.union([
  /** The N most recent events by start time. */
  z.object({ last: z.number().int().min(1).max(200) }).strict(),
  /** Every event that started in the last D days (no count limit). */
  z.object({ days: z.number().int().min(1).max(366) }).strict(),
  /** Tournament-shaped sports: tournaments in progress or finished within D days, from a stage onward. */
  z
    .object({
      tournaments: z.object({ finishedWithinDays: z.number().int().min(1).max(60), fromStage: Stage, majorsFromStage: Stage }).strict(),
    })
    .strict(),
]);
export type Keep = z.infer<typeof Keep>;

const CollectionBase = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1).max(150),
  keep: Keep,
  /** Publish to a YouTube playlist. Collections are still computed when false. */
  publish: z.boolean(),
};

export const Collection = z.discriminatedUnion('kind', [
  z.object({ ...CollectionBase, kind: z.literal('mixed'), excludeSports: z.array(z.string()).default([]) }),
  z.object({ ...CollectionBase, kind: z.literal('sport'), sport: z.string().min(1) }),
  z.object({ ...CollectionBase, kind: z.literal('team'), sport: z.string().min(1), team: z.string().min(1) }),
]);
export type Collection = z.infer<typeof Collection>;

/** Human-readable selection rule, shown in the catalog and dry runs. */
export function describeKeep(k: Keep): string {
  if ('last' in k) return `last ${k.last} events`;
  if ('days' in k) return `all events from the last ${k.days} days`;
  const t = k.tournaments;
  return `tournaments active or finished within ${t.finishedWithinDays} days; from ${t.fromStage.toUpperCase()} (majors from ${t.majorsFromStage.toUpperCase()})`;
}

export const PublishingConfig = z.object({
  /** Publisher budget per Pacific-time quota day; reads and attempted writes both count. */
  dailyBudgetUnits: z.number().int().min(0),
  /** Fixed per-collection write cap per run, so one busy collection cannot consume the budget. */
  writesPerCollectionPerRun: z.number().int().min(0),
  maxMetadataAgeHours: z.number().positive(),
  /** A sport whose latest personal discovery run is older than this is incomplete, so its collections keep last-known-good. */
  maxDiscoveryAgeHours: z.number().positive(),
  /** Explicit overrides of the title-screen exclusion default; shown in every dry run. */
  includeFlaggedTitles: z.boolean(),
  includeUnreviewedTitles: z.boolean(),
});
export type PublishingConfig = z.infer<typeof PublishingConfig>;

const CollectionsFile = z.object({ publishing: PublishingConfig, collections: z.array(Collection) });
export type CollectionsConfig = z.infer<typeof CollectionsFile>;

export function loadCollections(root = repoRoot()): CollectionsConfig {
  const parsed = CollectionsFile.parse(parseYaml(fs.readFileSync(path.join(root, 'config', 'collections.yaml'), 'utf8')));
  const ids = new Set<string>();
  for (const c of parsed.collections) {
    if (ids.has(c.id)) throw new Error(`Duplicate collection id ${c.id}`);
    ids.add(c.id);
  }
  return parsed;
}

/** Revision of the configuration a catalog was generated from. */
export function configRevision(root = repoRoot()): string {
  const h = createHash('sha256');
  for (const f of ['collections.yaml', 'preferences.yaml', 'sources.yaml']) h.update(fs.readFileSync(path.join(root, 'config', f)));
  return h.digest('hex').slice(0, 12);
}
