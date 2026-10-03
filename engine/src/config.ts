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

const Preferences = z.object({
  region: z.string().length(2),
  sports: z.object({
    nfl: z
      .object({
        enabled: z.boolean(),
        teams: z.array(z.object({ abbr: z.string().min(1), name: z.string().min(1), priority: z.enum(['must', 'high', 'normal', 'low']) })),
      })
      .optional(),
  }),
});
export type Preferences = z.infer<typeof Preferences>;

export function loadPreferences(root = repoRoot()): Preferences {
  return Preferences.parse(parseYaml(fs.readFileSync(path.join(root, 'config', 'preferences.yaml'), 'utf8')));
}
