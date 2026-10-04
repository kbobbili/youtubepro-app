import { describe, expect, it } from 'vitest';
import { markQuotaExhausted, quotaDay, quotaExhausted } from '../src/quota.ts';
import { Store } from '../src/store.ts';

describe('quota day', () => {
  it('an exhausted quota stops YouTube work for the rest of the Pacific day and resumes automatically after midnight Pacific', () => {
    const store = new Store(':memory:');
    markQuotaExhausted(store, '2026-10-04T02:00:00.000Z', 'publish'); // Oct 3, 7 PM Pacific
    expect(quotaExhausted(store, '2026-10-04T06:59:00.000Z')).toMatchObject({ day: '2026-10-03', source: 'publish' });
    expect(quotaExhausted(store, '2026-10-04T07:00:00.000Z')).toBeUndefined(); // midnight Pacific: new quota day
    expect(quotaDay('2026-10-04T07:00:00.000Z')).toBe('2026-10-04');
  });
});
