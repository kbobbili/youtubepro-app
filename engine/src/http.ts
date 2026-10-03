import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * JSON-over-HTTP with bounded retries, plus record/replay of sanitized responses
 * so tests and backfills are reproducible without network or API keys.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: unknown,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

/** Minimal transport. Implementations must never include secrets in thrown messages. */
export type Transport = (url: URL) => Promise<JsonResponse>;

const SECRET_PARAMS = new Set(['key', 'api_key', 'apikey', 'token']);

/** URL with secret query parameters removed and the rest sorted; safe to log and to use as a fixture key. */
export function sanitizeUrl(url: URL): string {
  const clean = new URL(url.toString());
  for (const name of [...clean.searchParams.keys()]) {
    if (SECRET_PARAMS.has(name.toLowerCase())) clean.searchParams.delete(name);
  }
  clean.searchParams.sort();
  return clean.toString();
}

export function liveTransport(timeoutMs = 15_000): Transport {
  return async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    const text = await res.text();
    let body: unknown;
    try {
      body = text.length ? JSON.parse(text) : null;
    } catch {
      body = { nonJson: text.slice(0, 200) };
    }
    return { status: res.status, body };
  };
}

function fixtureFile(dir: string, url: URL): string {
  const key = sanitizeUrl(url);
  const host = url.hostname.replace(/[^a-z0-9]+/gi, '_');
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(dir, `${host}-${hash}.json`);
}

export function recordingTransport(inner: Transport, dir: string): Transport {
  fs.mkdirSync(dir, { recursive: true });
  return async (url) => {
    const res = await inner(url);
    fs.writeFileSync(fixtureFile(dir, url), JSON.stringify({ url: sanitizeUrl(url), ...res }, null, 1));
    return res;
  };
}

export function replayTransport(dir: string): Transport {
  return async (url) => {
    const file = fixtureFile(dir, url);
    if (!fs.existsSync(file)) throw new Error(`No recorded fixture for ${sanitizeUrl(url)}`);
    const { status, body } = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonResponse;
    return { status, body };
  };
}

function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

/** GET JSON with bounded retries for network errors, 429 and 5xx. Non-2xx responses throw HttpError. */
export async function getJson(
  transport: Transport,
  url: URL,
  { retries = 2, backoffMs = 500 }: { retries?: number; backoffMs?: number } = {},
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
    try {
      const res = await transport(url);
      if (res.status >= 200 && res.status < 300) return res.body;
      lastError = new HttpError(res.status, sanitizeUrl(url), res.body);
      if (!isTransient(res.status)) break;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // Network errors and timeouts: rethrow without leaking the raw (keyed) URL.
      lastError = new Error(`Request failed for ${sanitizeUrl(url)}: ${(err as Error).name}`);
    }
  }
  throw lastError;
}
