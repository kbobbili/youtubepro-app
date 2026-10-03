import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { JsonResponse } from '../http.ts';

/**
 * YouTube OAuth for the playlist publisher: installed-app flow with PKCE and a loopback redirect
 * (127.0.0.1), plain fetch, no googleapis dependency. The refresh token lives in a gitignored file
 * and is never logged; error messages never include token values.
 */

export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export function oauthClientFromEnv(): OAuthClient {
  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing YOUTUBE_OAUTH_CLIENT_ID / YOUTUBE_OAUTH_CLIENT_SECRET in .env (Desktop OAuth client)');
  return { clientId, clientSecret };
}

interface StoredToken {
  refresh_token: string;
  scope: string;
  client_id: string;
  obtained_at: string;
}

const base64url = (b: Buffer) => b.toString('base64url');

/** Run the consent flow once and store the refresh token. Prints the consent URL; opens a browser when possible. */
export async function login(client: OAuthClient, tokenFile: string, o: { openBrowser?: boolean; log?: (s: string) => void } = {}): Promise<{ scope: string }> {
  const log = o.log ?? console.log;
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: client.clientId, redirect_uri: redirectUri, response_type: 'code', scope: YOUTUBE_SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
  }).toString();
  log(`Open this URL and sign in with the YouTube account that should own the playlists:\n\n${url}\n`);
  if (o.openBrowser !== false && process.platform === 'win32') execFile('rundll32', ['url.dll,FileProtocolHandler', url.toString()], () => {});

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the OAuth redirect (5 min)')), 300_000);
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirectUri);
      if (u.pathname !== '/') return void res.writeHead(404).end();
      const error = u.searchParams.get('error');
      const ok = !error && u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' }).end(ok ? 'SportsCenter: signed in. You can close this tab.' : 'SportsCenter: sign-in failed.');
      clearTimeout(timer);
      if (ok) resolve(u.searchParams.get('code')!);
      else reject(new Error(`OAuth consent failed: ${error ?? 'state mismatch or missing code'}`));
    });
  }).finally(() => server.close());

  const res = await tokenRequest({
    client_id: client.clientId, client_secret: client.clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code',
  });
  const refresh = res.refresh_token;
  if (typeof refresh !== 'string') throw new Error('Token response had no refresh token; revoke the app grant and run youtube-login again');
  const scope = String(res.scope ?? '');
  if (!scope.split(' ').includes(YOUTUBE_SCOPE)) throw new Error(`Granted scope does not include ${YOUTUBE_SCOPE}`);
  const stored: StoredToken = { refresh_token: refresh, scope, client_id: client.clientId, obtained_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify(stored, null, 2), { mode: 0o600 });
  return { scope };
}

async function tokenRequest(params: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // Only the OAuth error code is surfaced: never the response body, which could carry token material.
  if (!res.ok) throw new Error(`OAuth token request failed: HTTP ${res.status} ${typeof body.error === 'string' ? body.error : ''}`.trim());
  return body;
}

/** Exchanges the stored refresh token for short-lived access tokens, cached until shortly before expiry. */
export class TokenProvider {
  private cached?: { token: string; expiresAt: number };

  constructor(
    private readonly client: OAuthClient,
    private readonly tokenFile: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async accessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.token;
    if (!fs.existsSync(this.tokenFile)) throw new Error('No YouTube authorization found; run `pnpm youtube-login`');
    const stored = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')) as StoredToken;
    let body: Record<string, unknown>;
    try {
      body = await tokenRequest(
        { client_id: this.client.clientId, client_secret: this.client.clientSecret, refresh_token: stored.refresh_token, grant_type: 'refresh_token' },
        this.fetchImpl,
      );
    } catch (err) {
      throw new Error(`${(err as Error).message}. If this is invalid_grant, run \`pnpm youtube-login\` again (Testing-mode consent expires after 7 days).`);
    }
    const token = body.access_token;
    if (typeof token !== 'string') throw new Error('OAuth refresh returned no access token');
    this.cached = { token, expiresAt: Date.now() + (Number(body.expires_in ?? 3600) - 60) * 1000 };
    return token;
  }
}

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: URL;
  body?: unknown;
}

/** Authorized request transport for the publisher. Fakes implement the same shape in tests. */
export type ApiTransport = (req: ApiRequest) => Promise<JsonResponse>;

export function authorizedTransport(tokens: TokenProvider, timeoutMs = 30_000): ApiTransport {
  return async ({ method, url, body }) => {
    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${await tokens.accessToken()}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { nonJson: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed };
  };
}
