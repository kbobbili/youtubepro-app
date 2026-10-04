import { nflAdapter } from './nfl/index.ts';
import type { SportAdapter } from './types.ts';

/** Every sport with an adapter. The order is the order sports are listed in reports. */
export const ADAPTERS: readonly SportAdapter[] = [nflAdapter as SportAdapter];

export function adapterFor(sport: string): SportAdapter {
  const a = ADAPTERS.find((x) => x.sport === sport);
  if (!a) throw new Error(`No adapter for sport "${sport}" (supported: ${ADAPTERS.map((x) => x.sport).join(', ')})`);
  return a;
}

export const SUPPORTED_SPORTS = (): string[] => ADAPTERS.map((a) => a.sport);
