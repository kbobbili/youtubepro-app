import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../src/config.ts';

const script = path.join(repoRoot(), 'scripts', 'run-hourly.ps1');

/** Run the hourly chain in -Simulate mode (no engine calls) and return its exit code and the steps it logged. */
function simulate(fail: string[]): { code: number | null; steps: string[]; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-hourly-'));
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Simulate', '-LogDir', dir];
  if (fail.length) args.push('-SimulateFail', fail.join(','));
  const res = spawnSync('powershell.exe', args, { encoding: 'utf8' });
  const log = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: res.status, steps: [...log.matchAll(/:: \[([\w-]+)\]/g)].map((m) => m[1]!), log };
}

const ALL = ['discover-nfl', 'discover-f1', 'snapshot', 'catalog', 'diagnostic'];

describe.skipIf(process.platform !== 'win32')('hourly chain (per-collection failure isolation)', () => {
  it('runs every step and exits 0 when all succeed', () => {
    const r = simulate([]);
    expect(r.code).toBe(0);
    expect(r.steps).toEqual(ALL);
    expect(r.log).toMatch(/CHAIN OK/);
  });

  it("a failed sport's discovery does not stop the catalog (it marks only that sport's collections incomplete), but the run exits non-zero", () => {
    const r = simulate(['discover-nfl']);
    expect(r.code).toBe(3);
    expect(r.steps).toEqual(ALL);
    expect(r.log).toMatch(/CHAIN DONE WITH FAILURES: discover-nfl=3/);
  });

  it('a catalog that fails to build is a gate: later personal steps (publishing) never run', () => {
    const r = simulate(['catalog']);
    expect(r.code).toBe(3);
    expect(r.steps).toEqual(ALL); // nothing after catalog yet besides the diagnostic, which always runs
    expect(r.log).toMatch(/GATE FAILED: \[catalog\] exit=3/);
  });

  it('a diagnostic-only failure never affects the exit code', () => {
    const r = simulate(['diagnostic']);
    expect(r.code).toBe(0);
    expect(r.steps).toEqual(ALL);
  });
});
