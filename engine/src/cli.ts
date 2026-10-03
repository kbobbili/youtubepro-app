import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv, loadPreferences, loadSources, repoRoot, youtubeApiKey } from './config.ts';
import type { Cohort, RunKind, Window } from './domain.ts';
import { liveTransport, recordingTransport, replayTransport, type Transport } from './http.ts';
import { discoverNfl, type DiscoverResult } from './pipeline.ts';
import { buildReport } from './report.ts';
import { buildSnapshot, writeSnapshot } from './snapshot.ts';
import { Store } from './store.ts';
import { YouTubeClient } from './youtube/client.ts';

const USAGE = `Usage:
  pnpm discover nfl [--days 7 | --from YYYY-MM-DD --to YYYY-MM-DD] [--all-teams] [--kind manual|prospective|backfill]
                    [--record DIR | --replay DIR] [--now ISO] [--db FILE]
  pnpm report [--cohort personal|diagnostic] [--kind all|prospective|backfill|manual] [--json]
  pnpm snapshot [--days 7] [--out FILE]
  pnpm review <eventId> <videoId> correct|wrong [--notes TEXT]
  pnpm review --playback <videoId> verified|failed --env target-tv|browser [--notes TEXT]`;

const root = repoRoot();
const dataDir = path.join(root, 'data');

function resolveWindow(v: { days?: string; from?: string; to?: string }, now: string): Window {
  if (v.from || v.to) {
    if (!v.from || !v.to) throw new Error('--from and --to must be used together');
    const start = new Date(`${v.from}T00:00:00Z`);
    const end = new Date(Date.parse(`${v.to}T00:00:00Z`) + 86_400_000); // --to is inclusive
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new Error('Invalid --from/--to');
    return { start: start.toISOString(), end: end.toISOString() };
  }
  const days = Number(v.days ?? 7);
  if (!Number.isFinite(days) || days <= 0 || days > 31) throw new Error('--days must be 1..31');
  return { start: new Date(Date.parse(now) - days * 86_400_000).toISOString(), end: now };
}

/** Exclusive lock so scheduled runs never overlap. Stale locks (dead PID) are reclaimed. */
function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, `${name}.lock`);
  const acquire = () => fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
  try {
    acquire();
  } catch {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) throw new Error(`Another ${name} run is in progress (pid ${pid}); exiting without running.`);
    fs.rmSync(file);
    acquire();
  }
  return fn().finally(() => fs.rmSync(file, { force: true }));
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const mins = (s: number | null | undefined) => (s == null ? '?' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

function printDiscover(r: DiscoverResult, cohort: Cohort): void {
  console.log(`Run ${r.runId}  cohort=${cohort}  status=${r.status.toUpperCase()}`);
  console.log(`Window (UTC, by event start): ${r.window.start} → ${r.window.end}`);
  for (const s of r.scans) {
    console.log(`Scan ${s.sourceId}: ${s.items} uploads since ${s.since}, ${s.pages} page(s), ${s.complete ? 'complete' : 'INCOMPLETE'} (${s.stopReason})`);
  }
  console.log('');
  console.log(`${pad('Event (wanted)', 44)} ${pad('Week', 4)} ${pad('Discovery', 22)} ${pad('Video', 12)} ${pad('Dur', 6)} ${pad('Conf', 4)}  Notes`);
  for (const o of r.outcomes) {
    const e = o.event;
    const label = `${e.away.abbr} @ ${e.home.abbr}  ${e.startTime.slice(0, 16).replace('T', ' ')}Z`;
    const disc = o.discovery === 'SEARCHING' && !o.scanComplete ? 'SEARCHING (incomplete)' : o.discovery;
    const notes = [...(o.primary?.flags ?? []), ...(o.primary ? [] : o.ineligibleReasons), ...(o.primary ? ['tv:NOT_TESTED'] : [])].join(', ');
    console.log(
      `${pad(label, 44)} ${pad(String(e.week), 4)} ${pad(disc, 22)} ${pad(o.primary?.videoId ?? '-', 12)} ${pad(mins(o.primary?.durationSeconds), 6)} ${pad(o.primary ? o.primary.confidence.toFixed(2) : '-', 4)}  ${notes}`,
    );
  }
  const done = r.outcomes.filter((o) => o.event.status === 'COMPLETED');
  const found = done.filter((o) => o.discovery === 'FOUND').length;
  console.log('');
  console.log(
    `Wanted ${r.outcomes.length} (completed ${done.length}) → Matched ${done.filter((o) => o.matchedCandidates > 0).length} → Metadata eligible ${found} → ` +
      `Missing ${done.filter((o) => o.discovery === 'UNAVAILABLE').length} / Pending ${done.filter((o) => o.discovery === 'SEARCHING').length}`,
  );
  console.log('Target-TV playback: NOT_TESTED for all (metadata screening is not playback evidence).');
  console.log(`Quota: ${JSON.stringify(r.quota.calls)} ≈ ${r.quota.estimatedUnits} YouTube units`);
  for (const i of r.issues) console.log(`ISSUE [${i.stage}] ${i.message}`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      days: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
      'all-teams': { type: 'boolean' }, kind: { type: 'string' }, cohort: { type: 'string' },
      record: { type: 'string' }, replay: { type: 'string' }, now: { type: 'string' }, db: { type: 'string' },
      out: { type: 'string' }, json: { type: 'boolean' }, notes: { type: 'string' }, playback: { type: 'string' }, env: { type: 'string' },
    },
  });
  const now = () => values.now ?? new Date().toISOString();
  const dbFile = values.db ?? path.join(dataDir, 'sportscenter.db');
  loadEnv(root);

  switch (command) {
    case 'discover': {
      if (positionals[0] !== 'nfl') throw new Error('Only `nfl` is supported in this spike');
      const kind = (values.kind ?? 'manual') as RunKind;
      if (!['manual', 'prospective', 'backfill'].includes(kind)) throw new Error('--kind must be manual|prospective|backfill');
      const cohort: Cohort = values['all-teams'] ? 'diagnostic' : 'personal';
      let transport: Transport;
      let apiKey: string;
      if (values.replay) {
        transport = replayTransport(path.resolve(values.replay));
        apiKey = 'replay';
      } else {
        apiKey = youtubeApiKey();
        transport = values.record ? recordingTransport(liveTransport(), path.resolve(values.record)) : liveTransport();
      }
      const window = resolveWindow(values, now());
      return withLock('discover', async () => {
        const store = new Store(dbFile);
        try {
          const result = await discoverNfl({
            store, eventsTransport: transport, youtube: new YouTubeClient(transport, apiKey), sources: loadSources(root),
            prefs: loadPreferences(root), window, cohort, kind, runId: `${now().slice(0, 19).replace(/[:T]/g, '')}-${randomUUID().slice(0, 8)}`, now,
          });
          printDiscover(result, cohort);
          return result.status === 'failed' ? 2 : result.status === 'incomplete' ? 3 : 0;
        } finally {
          store.close();
        }
      });
    }
    case 'report': {
      const store = new Store(dbFile);
      try {
        const cohort = (values.cohort ?? 'personal') as Cohort;
        const report = buildReport(store, cohort, (values.kind ?? 'all') as RunKind | 'all');
        if (values.json) console.log(JSON.stringify(report, null, 2));
        else {
          const r = report;
          console.log(`NFL report  cohort=${r.cohort}  kind=${r.kind}`);
          console.log(`Runs: ${r.runs.total} (ok ${r.runs.ok}, incomplete ${r.runs.incomplete}, failed ${r.runs.failed}); observation days ${r.runs.observationDays}; ${r.runs.firstStartedAt ?? '-'} → ${r.runs.lastStartedAt ?? '-'}`);
          console.log('Sport | Eligible events | Matched | Metadata eligible | Missing | Pending | Target-TV verified | Audited correct/wrong/unaudited');
          console.log(`NFL   | ${r.eligibleEvents} | ${r.matched} | ${r.metadataEligible} | ${r.unavailable} | ${r.pending} | ${r.playback.targetTvVerified} (failed ${r.playback.targetTvFailed}) | ${r.audits.correct}/${r.audits.wrong}/${r.audits.unaudited}`);
          console.log(`Events never fully scanned: ${r.incompleteOnly}`);
          console.log(`Latency: median publish vs ESTIMATED end ${r.latency.medianMinutesAfterEstimatedEnd ?? 'unknown'} min (estimate); events with observed completion bounds ${r.latency.eventsWithObservedCompletionBounds}; median publish→discovery ${r.latency.medianMinutesPublishToDiscovery ?? 'n/a'} min (cadence-limited)`);
          console.log(`YouTube quota used across runs ≈ ${r.quotaUnits} units`);
        }
        return 0;
      } finally {
        store.close();
      }
    }
    case 'snapshot': {
      const store = new Store(dbFile);
      try {
        const snap = buildSnapshot(store, loadPreferences(root), loadSources(root), now(), Number(values.days ?? 7));
        const out = values.out ?? path.join(dataDir, 'library.json');
        writeSnapshot(out, snap);
        console.log(`Wrote ${snap.items.length} item(s) to ${path.relative(root, out)}`);
        for (const i of snap.items) console.log(`  ${i.neutralTitle}  (${i.subtitle})  ${i.video.videoId}  tv:${i.targetDevicePlayback}`);
        return 0;
      } finally {
        store.close();
      }
    }
    case 'audit': {
      const store = new Store(dbFile);
      try {
        if (values.playback) {
          const status = positionals[0]?.toUpperCase();
          if ((status !== 'VERIFIED' && status !== 'FAILED') || (values.env !== 'target-tv' && values.env !== 'browser')) throw new Error(USAGE);
          store.recordPlayback({ videoId: values.playback, at: now(), environment: values.env, region: loadPreferences(root).region, status, notes: values.notes });
          console.log(`Recorded ${values.env} playback ${status} for ${values.playback}`);
        } else {
          const [eventId, videoId, verdict] = positionals;
          if (!eventId || !videoId || (verdict !== 'correct' && verdict !== 'wrong')) throw new Error(USAGE);
          store.recordAudit(eventId, videoId, verdict, now(), values.notes);
          console.log(`Recorded audit ${verdict} for ${eventId} / ${videoId}`);
        }
        return 0;
      } finally {
        store.close();
      }
    }
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  },
);
