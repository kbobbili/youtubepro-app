import { CatalogSnapshot, type CatalogCollection } from '@sportscenter/contracts';
import type { CollectionsConfig } from '../config.ts';
import { HttpError, sanitizeUrl } from '../http.ts';
import { markQuotaExhausted, quotaDay, quotaExhausted } from '../quota.ts';
import type { Store } from '../store.ts';
import { QuotaExceededError } from '../youtube/client.ts';
import type { ApiTransport } from '../youtube/oauth.ts';

/**
 * Publishes catalog collections to the authenticated account's private YouTube playlists
 * (SmartTube delivery EXPERIMENT; see docs/07 open decisions and docs/08).
 *
 * Reconciles from remote state on every run (no operation journal): fully paginate the remote playlist,
 * diff against the latest complete desired list, then delete → repair drift → insert at computed positions.
 * A crash, timeout or budget stop is recovered by running again. Dry-run is the default and never mutates.
 */

const API = 'https://www.googleapis.com/youtube/v3/';

/** Documented YouTube Data API v3 costs (units). */
export const COST = { list: 1, write: 50 } as const;

export class BudgetExceededError extends Error {}

export { quotaDay };

export function playlistMarker(installId: string, collectionId: string): string {
  return `[sportscenter install=${installId} collection=${collectionId}]`;
}

// ---- Planning (pure) ---------------------------------------------------------

export interface RemoteItem {
  itemId: string;
  videoId: string;
  position: number;
}

export type Op =
  | { kind: 'delete'; itemId: string; videoId: string; reason: 'not_desired' | 'duplicate' }
  | { kind: 'move'; itemId: string; videoId: string; position: number }
  | { kind: 'insert'; videoId: string; position: number };

/**
 * Ops that turn `remote` into `desired` (unique video IDs in display order), with positions computed by
 * simulating each preceding op. Executing any prefix of the list is safe; the next run re-plans from remote.
 * Inserting a late match or cap substitution mid-list is normal; only `move` ops represent drift.
 */
export function planSync(desired: string[], remote: RemoteItem[]): Op[] {
  const want = new Map(desired.map((v, i) => [v, i]));
  const ops: Op[] = [];
  const seen = new Set<string>();
  const current: RemoteItem[] = [];
  for (const it of [...remote].sort((a, b) => a.position - b.position)) {
    if (!want.has(it.videoId)) ops.push({ kind: 'delete', itemId: it.itemId, videoId: it.videoId, reason: 'not_desired' });
    else if (seen.has(it.videoId)) ops.push({ kind: 'delete', itemId: it.itemId, videoId: it.videoId, reason: 'duplicate' });
    else {
      seen.add(it.videoId);
      current.push(it);
    }
  }

  // Drift: keep the longest run of items already in desired relative order; move the rest.
  const idx = current.map((it) => want.get(it.videoId)!);
  const keep = longestIncreasingSubsequence(idx);
  const positionFor = (target: number) => {
    let pos = 0;
    current.forEach((it, i) => {
      if (want.get(it.videoId)! < target) pos = i + 1;
    });
    return pos;
  };
  const toMove = current.filter((_, i) => !keep.has(i)).sort((a, b) => want.get(a.videoId)! - want.get(b.videoId)!);
  for (const it of toMove) {
    current.splice(current.indexOf(it), 1);
    const position = positionFor(want.get(it.videoId)!);
    current.splice(position, 0, it);
    ops.push({ kind: 'move', itemId: it.itemId, videoId: it.videoId, position });
  }

  for (const [videoId, i] of want) {
    if (seen.has(videoId)) continue;
    const position = positionFor(i);
    current.splice(position, 0, { itemId: '', videoId, position });
    ops.push({ kind: 'insert', videoId, position });
  }
  return ops;
}

/** Indices of one longest strictly increasing subsequence of `xs`. */
function longestIncreasingSubsequence(xs: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = [];
  xs.forEach((x, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[tails[mid]!]! < x) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  });
  const out = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) out.add(i);
  return out;
}

// ---- API with budget guard ---------------------------------------------------

class PublishApi {
  readonly calls: Record<string, number> = {};
  units = 0;

  constructor(
    private readonly transport: ApiTransport,
    /** Units already attempted on this quota day by earlier runs. */
    private readonly usedBefore: number,
    private readonly budget: number,
    private readonly persist: (calls: Record<string, number>, units: number) => void,
  ) {}

  get remaining(): number {
    return this.budget - this.usedBefore - this.units;
  }

  /** Counts and persists every attempted call before sending it. Reads retry transient failures; writes never retry. */
  async request(endpoint: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', params: Record<string, string>, body?: unknown): Promise<unknown> {
    const cost = method === 'GET' ? COST.list : COST.write;
    const url = new URL(endpoint, API);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const attempts = method === 'GET' ? 3 : 1;
    let last: unknown;
    for (let a = 0; a < attempts; a++) {
      if (cost > this.remaining) throw new BudgetExceededError(`Daily publish budget reached before ${method} ${endpoint}`);
      const key = `${endpoint}.${method === 'GET' ? 'list' : method === 'POST' ? 'insert' : method === 'PUT' ? 'update' : 'delete'}`;
      this.calls[key] = (this.calls[key] ?? 0) + 1;
      this.units += cost;
      this.persist(this.calls, this.units);
      const res = await this.transport({ method, url, body });
      if (res.status >= 200 && res.status < 300) return res.body;
      const reason = (res.body as { error?: { errors?: { reason?: string }[] } })?.error?.errors?.[0]?.reason;
      if (res.status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')) throw new QuotaExceededError(`YouTube quota exceeded (${method} ${endpoint})`);
      last = new HttpError(res.status, sanitizeUrl(url), res.body);
      if (res.status !== 429 && res.status < 500) break;
    }
    throw last;
  }
}

const reasonOf = (err: unknown) => (err instanceof HttpError ? (err.body as { error?: { errors?: { reason?: string }[] } })?.error?.errors?.[0]?.reason : undefined);

/** A definite rejection (4xx other than 429): the request was not applied. Anything else is uncertain. */
const isDefiniteFailure = (err: unknown) => err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429;

async function readPlaylistItems(api: PublishApi, playlistId: string): Promise<RemoteItem[]> {
  const items: RemoteItem[] = [];
  let pageToken: string | undefined;
  do {
    const page = (await api.request('playlistItems', 'GET', { part: 'snippet', playlistId, maxResults: '50', ...(pageToken ? { pageToken } : {}) })) as {
      nextPageToken?: string;
      items?: { id: string; snippet: { position: number; resourceId: { videoId: string } } }[];
    };
    for (const it of page.items ?? []) items.push({ itemId: it.id, videoId: it.snippet.resourceId.videoId, position: it.snippet.position });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

async function readOwnedPlaylists(api: PublishApi): Promise<{ id: string; channelId: string; description: string }[]> {
  const out: { id: string; channelId: string; description: string }[] = [];
  let pageToken: string | undefined;
  do {
    const page = (await api.request('playlists', 'GET', { part: 'snippet', mine: 'true', maxResults: '50', ...(pageToken ? { pageToken } : {}) })) as {
      nextPageToken?: string;
      items?: { id: string; snippet: { channelId: string; description?: string } }[];
    };
    for (const p of page.items ?? []) out.push({ id: p.id, channelId: p.snippet.channelId, description: p.snippet.description ?? '' });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

// ---- Sync ----------------------------------------------------------------------

export type CollectionOutcome =
  | 'in_sync'
  | 'applied'
  | 'partial' // write cap or budget left a backlog
  | 'planned' // dry run
  | 'would_create' // dry run, untracked
  | 'skipped_incomplete_catalog'
  | 'skipped_account_mismatch'
  | 'creation_pending' // uncertain create; recovery lookup will run next time
  | 'creation_unresolved'
  | 'conflict_duplicate_markers'
  | 'playlist_missing'
  | 'failed';

export interface CollectionReport {
  collectionId: string;
  outcome: CollectionOutcome;
  playlistId?: string;
  desired: number;
  planned: { deletes: number; moves: number; inserts: number };
  applied: { creates: number; deletes: number; moves: number; inserts: number };
  backlog: number;
  ops: Op[];
  exclusions: Record<string, number>;
  notes: string[];
}

export interface SyncReport {
  runId: string;
  mode: 'dry-run' | 'apply';
  status: 'ok' | 'incomplete' | 'failed' | 'budget_limited';
  quotaDay: string;
  channelId?: string;
  catalogGeneratedAt: string;
  titleOverrides: CatalogSnapshot['titleOverrides'];
  collections: CollectionReport[];
  calls: Record<string, number>;
  units: number;
  budget: { daily: number; usedBefore: number; remainingAfter: number; remainingWrites: number };
  issues: string[];
}

export interface SyncOptions {
  store: Store;
  transport: ApiTransport;
  catalog: CatalogSnapshot;
  config: CollectionsConfig;
  apply: boolean;
  runId: string;
  now: () => string;
  newInstallId: () => string;
  /** Collections whose unresolved creation the user inspected and allows to be retried. */
  retryCreate?: string[];
}

export async function syncPlaylists(o: SyncOptions): Promise<SyncReport> {
  const { store, config } = o;
  const catalog = CatalogSnapshot.parse(o.catalog);
  const mode = o.apply ? 'apply' : 'dry-run';
  const startedAt = o.now();
  const day = quotaDay(startedAt);
  const usedBefore = store.publishUnitsOn(day);
  store.startPublishRun({ id: o.runId, startedAt, quotaDay: day, mode, catalogGeneratedAt: catalog.generatedAt });
  const api = new PublishApi(o.transport, usedBefore, config.publishing.dailyBudgetUnits, (calls, units) => store.recordPublishCalls(o.runId, calls, units));
  const issues: string[] = [];
  const reports: CollectionReport[] = [];
  let status: SyncReport['status'] = 'ok';
  let channelId: string | undefined;

  const exhausted = quotaExhausted(store, startedAt);
  if (exhausted) {
    const report: SyncReport = {
      runId: o.runId, mode, status: 'budget_limited', quotaDay: day, catalogGeneratedAt: catalog.generatedAt, titleOverrides: catalog.titleOverrides, collections: [], calls: {}, units: 0,
      budget: { daily: config.publishing.dailyBudgetUnits, usedBefore, remainingAfter: 0, remainingWrites: 0 },
      issues: [`YouTube quota exhausted for ${exhausted.day} (by ${exhausted.source} at ${exhausted.at}); publishing resumes after midnight Pacific`],
    };
    store.finishPublishRun(o.runId, o.now(), 'budget_limited', report);
    return report;
  }

  const catalogAgeH = (Date.parse(startedAt) - Date.parse(catalog.generatedAt)) / 3_600_000;
  const catalogStale = catalogAgeH > config.publishing.maxMetadataAgeHours;
  if (catalogStale) issues.push(`catalog is ${catalogAgeH.toFixed(1)}h old (max ${config.publishing.maxMetadataAgeHours}h): treated as incomplete`);

  try {
    const me = (await api.request('channels', 'GET', { part: 'id', mine: 'true' })) as { items?: { id: string }[] };
    channelId = me.items?.[0]?.id;
    if (!channelId) throw new Error('Authenticated account has no YouTube channel');
    // Durable before any remote creation can depend on it.
    const installId = store.installId(o.newInstallId);

    const byId = new Map(catalog.collections.map((c) => [c.id, c]));
    for (const col of config.collections.filter((c) => c.publish)) {
      const entry = byId.get(col.id);
      const report: CollectionReport = {
        collectionId: col.id, outcome: 'in_sync', desired: entry?.items.length ?? 0, planned: { deletes: 0, moves: 0, inserts: 0 },
        applied: { creates: 0, deletes: 0, moves: 0, inserts: 0 }, backlog: 0, ops: [], exclusions: {}, notes: [],
      };
      reports.push(report);
      for (const e of entry?.exclusions ?? []) {
        const k = e.reason.split(':')[0]!;
        report.exclusions[k] = (report.exclusions[k] ?? 0) + 1;
      }
      try {
        await syncCollection(api, store, o, col.title, entry, catalogStale, channelId, installId, report);
      } catch (err) {
        if (err instanceof BudgetExceededError || err instanceof QuotaExceededError) throw err;
        report.outcome = 'failed';
        report.notes.push((err as Error).message);
      }
      if (report.outcome === 'failed' || report.outcome.startsWith('skipped') || report.outcome.startsWith('creation') || report.outcome === 'conflict_duplicate_markers' || report.outcome === 'playlist_missing') {
        if (status === 'ok') status = 'incomplete';
      }
    }
  } catch (err) {
    if (err instanceof BudgetExceededError || err instanceof QuotaExceededError) {
      status = 'budget_limited';
      issues.push(`${err.message}; publishing resumes after midnight Pacific`);
      // Only YouTube's own signal stops all YouTube work for the day; the publisher's budget only stops publishing.
      if (err instanceof QuotaExceededError) markQuotaExhausted(store, o.now(), 'publish');
      const last = reports[reports.length - 1];
      if (last && last.outcome !== 'failed') last.outcome = 'partial';
    } else {
      status = 'failed';
      issues.push((err as Error).message);
    }
  }

  const remainingAfter = Math.max(0, api.remaining);
  const report: SyncReport = {
    runId: o.runId, mode, status, quotaDay: day, channelId, catalogGeneratedAt: catalog.generatedAt, titleOverrides: catalog.titleOverrides,
    collections: reports, calls: api.calls, units: api.units,
    budget: { daily: config.publishing.dailyBudgetUnits, usedBefore, remainingAfter, remainingWrites: Math.floor(remainingAfter / COST.write) },
    issues,
  };
  store.finishPublishRun(o.runId, o.now(), status, { ...report, collections: reports.map(({ ops: _ops, ...r }) => r) });
  return report;
}

async function syncCollection(
  api: PublishApi,
  store: Store,
  o: SyncOptions,
  title: string,
  entry: CatalogCollection | undefined,
  catalogStale: boolean,
  channelId: string,
  installId: string,
  report: CollectionReport,
): Promise<void> {
  const at = o.now();
  const id = report.collectionId;
  // Incomplete input preserves the last-known-good remote collection: never read missing items as deletions.
  if (!entry || entry.status !== 'complete' || catalogStale) {
    report.outcome = 'skipped_incomplete_catalog';
    report.notes.push(entry ? entry.issues.join('; ') || 'catalog stale' : 'collection missing from catalog');
    return;
  }

  let tracked = store.publishPlaylist(id);
  if (tracked && tracked.channelId !== channelId) {
    report.outcome = 'skipped_account_mismatch';
    report.notes.push(`tracked playlist belongs to channel ${tracked.channelId}, authenticated as ${channelId}`);
    return;
  }
  if (tracked?.state === 'conflict') {
    report.outcome = 'conflict_duplicate_markers';
    report.notes.push('multiple owned playlists carry this collection marker; resolve manually');
    return;
  }
  if (tracked?.state === 'unresolved') {
    if (!o.retryCreate?.includes(id)) {
      report.outcome = 'creation_unresolved';
      report.notes.push('earlier creation outcome unknown and no marked playlist was found; inspect the account, then rerun with --retry-create ' + id);
      return;
    }
    if (o.apply) store.deletePublishPlaylist(id);
    tracked = undefined;
  }
  if (tracked?.state === 'creating') {
    // Uncertain earlier create: only a complete lookup of the account's own playlists may resolve it.
    const marker = playlistMarker(installId, id);
    const matches = (await readOwnedPlaylists(api)).filter((p) => p.channelId === channelId && p.description.includes(marker));
    if (matches.length > 1) {
      if (o.apply) store.setPublishPlaylist({ ...tracked, state: 'conflict' }, at);
      report.outcome = 'conflict_duplicate_markers';
      report.notes.push(`${matches.length} playlists carry ${marker}`);
      return;
    }
    if (matches.length === 0) {
      if (o.apply) store.setPublishPlaylist({ ...tracked, state: 'unresolved' }, at);
      report.outcome = 'creation_unresolved';
      report.notes.push('no playlist with this collection marker found after an uncertain create; inspect before retrying');
      return;
    }
    tracked = { ...tracked, playlistId: matches[0]!.id, state: 'active' };
    if (o.apply) store.setPublishPlaylist(tracked, at);
    report.notes.push(`recovered playlist ${matches[0]!.id} by install marker`);
  }

  const desired = [...new Set(entry.items.map((i) => i.video.videoId))];
  if (!tracked) {
    const ops = planSync(desired, []);
    report.ops = ops;
    report.planned.inserts = ops.length;
    if (!o.apply) {
      report.outcome = 'would_create';
      report.backlog = ops.length;
      return;
    }
    const cap = o.config.publishing.writesPerCollectionPerRun;
    if (cap < 1) {
      report.outcome = 'partial';
      report.backlog = ops.length + 1;
      return;
    }
    store.setPublishPlaylist({ collectionId: id, channelId, installId, state: 'creating' }, at);
    try {
      const created = (await api.request('playlists', 'POST', { part: 'snippet,status' }, {
        snippet: {
          title,
          description: `Managed by SportsCenter (personal experiment). Items are reconciled automatically; manual edits may be undone. ${playlistMarker(installId, id)}`,
        },
        status: { privacyStatus: 'private' },
      })) as { id?: string };
      if (!created.id) throw new Error('playlists.insert returned no id');
      tracked = { collectionId: id, channelId, installId, playlistId: created.id, state: 'active' };
      store.setPublishPlaylist(tracked, o.now());
      report.applied.creates = 1;
    } catch (err) {
      if (err instanceof BudgetExceededError || err instanceof QuotaExceededError || isDefiniteFailure(err)) store.deletePublishPlaylist(id); // not sent, or definitely rejected
      if (err instanceof BudgetExceededError || err instanceof QuotaExceededError) throw err;
      report.outcome = isDefiniteFailure(err) ? 'failed' : 'creation_pending';
      report.notes.push(`playlist creation ${isDefiniteFailure(err) ? 'rejected' : 'outcome unknown'}: ${(err as Error).message}`);
      return;
    }
  }

  let remote: RemoteItem[];
  try {
    remote = await readPlaylistItems(api, tracked.playlistId!);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404 && report.applied.creates) {
      // Observed 2026-10-03: a playlist created moments ago returns playlistNotFound until YouTube propagates it.
      report.outcome = 'partial';
      report.backlog = desired.length;
      report.notes.push(`created ${tracked.playlistId}; YouTube is not serving it yet, so its videos are added on the next run`);
      return;
    }
    if (err instanceof HttpError && err.status === 404) {
      report.outcome = 'playlist_missing';
      report.notes.push(`tracked playlist ${tracked.playlistId} not found (${reasonOf(err) ?? '404'}); not recreated automatically`);
      return;
    }
    throw err;
  }
  report.playlistId = tracked.playlistId;
  const ops = planSync(desired, remote);
  report.ops = ops;
  for (const op of ops) report.planned[op.kind === 'delete' ? 'deletes' : op.kind === 'move' ? 'moves' : 'inserts']++;
  if (!ops.length) {
    report.outcome = 'in_sync';
    return;
  }
  if (!o.apply) {
    report.outcome = 'planned';
    report.backlog = ops.length;
    return;
  }

  const cap = Math.max(0, o.config.publishing.writesPerCollectionPerRun - report.applied.creates);
  let done = 0;
  for (const op of ops.slice(0, cap)) {
    try {
      if (op.kind === 'delete') {
        await api.request('playlistItems', 'DELETE', { id: op.itemId });
        report.applied.deletes++;
      } else {
        const snippet = { playlistId: tracked.playlistId, position: op.position, resourceId: { kind: 'youtube#video', videoId: op.videoId } };
        const res = (await api.request('playlistItems', op.kind === 'insert' ? 'POST' : 'PUT', { part: 'snippet' }, op.kind === 'insert' ? { snippet } : { id: op.itemId, snippet })) as {
          snippet?: { position?: number };
        };
        if (res?.snippet?.position !== undefined && res.snippet.position !== op.position) {
          report.notes.push(`position_not_honored: requested ${op.position}, got ${res.snippet.position} (playlist may not use manual ordering)`);
        }
        if (op.kind === 'insert') report.applied.inserts++;
        else report.applied.moves++;
      }
      done++;
    } catch (err) {
      if (err instanceof BudgetExceededError || err instanceof QuotaExceededError) {
        report.backlog = ops.length - done;
        throw err;
      }
      // Later positions assumed this op succeeded: stop and re-plan from remote state next run.
      report.outcome = 'failed';
      report.backlog = ops.length - done;
      report.notes.push(`${op.kind} ${op.videoId} failed: ${(err as Error).message}`);
      return;
    }
  }
  report.backlog = ops.length - done;
  report.outcome = report.backlog ? 'partial' : 'applied';
}

// ---- Retire ----------------------------------------------------------------------

export interface RetireReport {
  collectionId: string;
  playlistId?: string;
  outcome: 'deleted' | 'already_gone' | 'refused';
  reason?: string;
  units: number;
}

/**
 * Delete one engine-owned playlist on explicit request and stop tracking it. Refuses unless the playlist is tracked,
 * owned by the authenticated channel, and still carries this install's collection marker, so it can never delete a
 * playlist the engine did not create. Counts against the same daily budget.
 */
export async function retirePlaylist(o: { store: Store; transport: ApiTransport; config: CollectionsConfig; collectionId: string; runId: string; now: () => string }): Promise<RetireReport> {
  const { store } = o;
  const startedAt = o.now();
  const day = quotaDay(startedAt);
  store.startPublishRun({ id: o.runId, startedAt, quotaDay: day, mode: 'apply' });
  const api = new PublishApi(o.transport, store.publishUnitsOn(day), o.config.publishing.dailyBudgetUnits, (calls, units) => store.recordPublishCalls(o.runId, calls, units));
  const done = (r: Omit<RetireReport, 'collectionId' | 'units'>): RetireReport => {
    const report = { collectionId: o.collectionId, units: api.units, ...r };
    store.finishPublishRun(o.runId, o.now(), r.outcome === 'refused' ? 'failed' : 'ok', { retire: report });
    return report;
  };
  const tracked = store.publishPlaylist(o.collectionId);
  if (!tracked?.playlistId) return done({ outcome: 'refused', reason: 'collection has no tracked playlist' });
  const me = (await api.request('channels', 'GET', { part: 'id', mine: 'true' })) as { items?: { id: string }[] };
  if (me.items?.[0]?.id !== tracked.channelId) return done({ outcome: 'refused', playlistId: tracked.playlistId, reason: `tracked playlist belongs to channel ${tracked.channelId}` });
  const found = (await api.request('playlists', 'GET', { part: 'snippet', id: tracked.playlistId })) as { items?: { id: string; snippet: { channelId: string; description?: string } }[] };
  const p = found.items?.[0];
  if (!p) {
    store.deletePublishPlaylist(o.collectionId);
    return done({ outcome: 'already_gone', playlistId: tracked.playlistId });
  }
  const marker = playlistMarker(tracked.installId, o.collectionId);
  if (p.snippet.channelId !== tracked.channelId || !(p.snippet.description ?? '').includes(marker)) {
    return done({ outcome: 'refused', playlistId: tracked.playlistId, reason: `playlist does not carry ${marker}` });
  }
  await api.request('playlists', 'DELETE', { id: tracked.playlistId });
  store.deletePublishPlaylist(o.collectionId);
  return done({ outcome: 'deleted', playlistId: tracked.playlistId });
}
