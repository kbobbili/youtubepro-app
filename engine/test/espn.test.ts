import { describe, expect, it } from 'vitest';
import { easternDatesFor, fetchNflEvents } from '../src/adapters/nfl/espn.ts';
import { overriding, w3Transport } from './helpers.ts';

const WEEK3 = { start: '2026-09-24T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' };

describe('ESPN NFL adapter', () => {
  it('covers the window with US Eastern dates, padded a day each side', () => {
    expect(easternDatesFor(WEEK3)).toEqual(['20260922', '20260923', '20260924', '20260925', '20260926', '20260927', '20260928', '20260929', '20260930', '20261001']);
  });

  it('normalizes the recorded Week 3 slate (16 completed games, no scores)', async () => {
    const r = await fetchNflEvents(w3Transport(), WEEK3);
    expect(r.complete).toBe(true);
    expect(r.events).toHaveLength(16);
    expect(r.events.every((e) => e.status === 'COMPLETED' && e.week === 3 && e.season === 2026 && e.seasonType === 2)).toBe(true);
    const buf = r.events.find((e) => e.providerEventId === '401872953')!;
    expect(buf).toMatchObject({ id: 'nfl:espn:401872953', startTime: '2026-09-27T17:00:00.000Z', home: { abbr: 'BUF' }, away: { abbr: 'LAC' } });
    expect(JSON.stringify(buf)).not.toMatch(/score/i);
  });

  it('distinguishes a provider error from a valid empty schedule', async () => {
    const empty = await fetchNflEvents(overriding(w3Transport(), () => ({ status: 200, body: { events: [] } })), WEEK3);
    expect(empty).toMatchObject({ events: [], complete: true, issues: [] });

    const failing = await fetchNflEvents(
      overriding(w3Transport(), (u) => (u.searchParams.get('dates') === '20260927' ? { status: 400, body: { code: 400 } } : undefined)),
      WEEK3,
    );
    expect(failing.complete).toBe(false);
    expect(failing.issues[0]).toMatch(/20260927: HTTP 400/);
    expect(failing.events.length).toBeLessThan(16);
  });

  it('marks malformed responses and events as incomplete', async () => {
    const malformed = await fetchNflEvents(overriding(w3Transport(), () => ({ status: 200, body: { nope: true } })), WEEK3);
    expect(malformed.complete).toBe(false);
    expect(malformed.issues[0]).toMatch(/malformed scoreboard/);

    const badEvent = await fetchNflEvents(
      overriding(w3Transport(), (u) => (u.searchParams.get('dates') === '20260927' ? { status: 200, body: { events: [{ id: '1', date: 'x' }] } } : undefined)),
      WEEK3,
    );
    expect(badEvent.complete).toBe(false);
    expect(badEvent.issues[0]).toMatch(/malformed event 1/);
  });

  it('maps postponed and cancelled games', async () => {
    const r = await fetchNflEvents(
      overriding(w3Transport(), async (u) => {
        if (u.searchParams.get('dates') !== '20260927') return undefined;
        const res = await w3Transport()(u);
        const body = structuredClone(res.body) as { events: { status: { type: { name: string; state: string; completed: boolean } } }[] };
        body.events[0]!.status.type = { name: 'STATUS_POSTPONED', state: 'post', completed: false };
        body.events[1]!.status.type = { name: 'STATUS_CANCELED', state: 'post', completed: false };
        return { status: 200, body };
      }),
      WEEK3,
    );
    const statuses = r.events.map((e) => e.status);
    expect(statuses).toContain('POSTPONED');
    expect(statuses).toContain('CANCELLED');
  });
});
