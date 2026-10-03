/** NFL team identities used to resolve team names in highlight titles. Keyed by ESPN abbreviation. */
export interface NflTeam {
  abbr: string;
  name: string;
  nickname: string;
  /** Extra spellings seen or expected in titles. */
  aliases?: string[];
}

export const NFL_TEAMS: readonly NflTeam[] = [
  { abbr: 'ARI', name: 'Arizona Cardinals', nickname: 'Cardinals' },
  { abbr: 'ATL', name: 'Atlanta Falcons', nickname: 'Falcons' },
  { abbr: 'BAL', name: 'Baltimore Ravens', nickname: 'Ravens' },
  { abbr: 'BUF', name: 'Buffalo Bills', nickname: 'Bills' },
  { abbr: 'CAR', name: 'Carolina Panthers', nickname: 'Panthers' },
  { abbr: 'CHI', name: 'Chicago Bears', nickname: 'Bears' },
  { abbr: 'CIN', name: 'Cincinnati Bengals', nickname: 'Bengals' },
  { abbr: 'CLE', name: 'Cleveland Browns', nickname: 'Browns' },
  { abbr: 'DAL', name: 'Dallas Cowboys', nickname: 'Cowboys' },
  { abbr: 'DEN', name: 'Denver Broncos', nickname: 'Broncos' },
  { abbr: 'DET', name: 'Detroit Lions', nickname: 'Lions' },
  { abbr: 'GB', name: 'Green Bay Packers', nickname: 'Packers' },
  { abbr: 'HOU', name: 'Houston Texans', nickname: 'Texans' },
  { abbr: 'IND', name: 'Indianapolis Colts', nickname: 'Colts' },
  { abbr: 'JAX', name: 'Jacksonville Jaguars', nickname: 'Jaguars' },
  { abbr: 'KC', name: 'Kansas City Chiefs', nickname: 'Chiefs' },
  { abbr: 'LV', name: 'Las Vegas Raiders', nickname: 'Raiders' },
  { abbr: 'LAC', name: 'Los Angeles Chargers', nickname: 'Chargers' },
  { abbr: 'LAR', name: 'Los Angeles Rams', nickname: 'Rams' },
  { abbr: 'MIA', name: 'Miami Dolphins', nickname: 'Dolphins' },
  { abbr: 'MIN', name: 'Minnesota Vikings', nickname: 'Vikings' },
  { abbr: 'NE', name: 'New England Patriots', nickname: 'Patriots' },
  { abbr: 'NO', name: 'New Orleans Saints', nickname: 'Saints' },
  { abbr: 'NYG', name: 'New York Giants', nickname: 'Giants' },
  { abbr: 'NYJ', name: 'New York Jets', nickname: 'Jets' },
  { abbr: 'PHI', name: 'Philadelphia Eagles', nickname: 'Eagles' },
  { abbr: 'PIT', name: 'Pittsburgh Steelers', nickname: 'Steelers' },
  { abbr: 'SF', name: 'San Francisco 49ers', nickname: '49ers', aliases: ['Niners'] },
  { abbr: 'SEA', name: 'Seattle Seahawks', nickname: 'Seahawks' },
  { abbr: 'TB', name: 'Tampa Bay Buccaneers', nickname: 'Buccaneers', aliases: ['Bucs'] },
  { abbr: 'TEN', name: 'Tennessee Titans', nickname: 'Titans' },
  { abbr: 'WSH', name: 'Washington Commanders', nickname: 'Commanders' },
];

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const LOOKUP = new Map<string, string>();
for (const t of NFL_TEAMS) {
  for (const label of [t.name, t.nickname, ...(t.aliases ?? [])]) LOOKUP.set(normalize(label), t.abbr);
}

/** Resolve a team label from a title to an ESPN abbreviation. Unknown or ambiguous labels return undefined. */
export function resolveNflTeam(label: string): string | undefined {
  return LOOKUP.get(normalize(label));
}
