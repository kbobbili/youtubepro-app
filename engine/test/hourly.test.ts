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
  return { code: res.status, steps: [...log.matchAll(/:: \[(\w+)\]/g)].map((m) => m[1]!), log };
}

describe.skipIf(process.platform !== 'win32')('hourly chain (fail closed)', () => {
  it('runs the personal chain, then the diagnostic, and exits 0 when all succeed', () => {
    const r = simulate([]);
    expect(r.code).toBe(0);
    expect(r.steps).toEqual(['discover', 'snapshot', 'catalog', 'diagnostic']);
  });

  it('a failed or incomplete discover stops every later step and exits non-zero', () => {
    const r = simulate(['discover']);
    expect(r.code).toBe(3);
    expect(r.steps).toEqual(['discover']);
    expect(r.log).toMatch(/CHAIN STOPPED: \[discover\] exit=3; skipped: snapshot, catalog, diagnostic/);
  });

  it('an incomplete catalog stops the chain (publishing, once added, would never see it)', () => {
    const r = simulate(['catalog']);
    expect(r.code).toBe(3);
    expect(r.steps).toEqual(['discover', 'snapshot', 'catalog']);
  });

  it('a diagnostic-only failure never blocks the personal chain', () => {
    const r = simulate(['diagnostic']);
    expect(r.code).toBe(0);
    expect(r.steps).toEqual(['discover', 'snapshot', 'catalog', 'diagnostic']);
  });
});
