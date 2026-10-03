import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TokenProvider } from '../src/youtube/oauth.ts';

const client = { clientId: 'cid', clientSecret: 'csecret' };

function tokenFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-oauth-'));
  const file = path.join(dir, 'youtube-token.json');
  fs.writeFileSync(file, JSON.stringify({ refresh_token: 'REFRESH-SECRET', scope: 'x', client_id: 'cid', obtained_at: 'now' }));
  return file;
}

const respond = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('TokenProvider', () => {
  it('exchanges the refresh token and caches the access token', async () => {
    let calls = 0;
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      calls++;
      return respond(200, { access_token: 'ACCESS', expires_in: 3600 })(...args);
    }) as typeof fetch;
    const p = new TokenProvider(client, tokenFile(), fetchImpl);
    expect(await p.accessToken()).toBe('ACCESS');
    expect(await p.accessToken()).toBe('ACCESS');
    expect(calls).toBe(1);
  });

  it('refresh failures name the OAuth error and the fix, never token material', async () => {
    const p = new TokenProvider(client, tokenFile(), respond(400, { error: 'invalid_grant', error_description: 'Token REFRESH-SECRET expired' }));
    const err = (await p.accessToken().then(() => new Error('expected a failure'), (e: Error) => e)) as Error;
    expect(err.message).toMatch(/invalid_grant.*youtube-login/s);
    expect(err.message).not.toMatch(/REFRESH-SECRET|csecret/);
  });

  it('a missing authorization asks for youtube-login', async () => {
    await expect(new TokenProvider(client, path.join(os.tmpdir(), 'nope', 't.json')).accessToken()).rejects.toThrow(/youtube-login/);
  });
});
