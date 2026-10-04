# Soccer Integration
## Eligibility
Selected clubs/national teams across competitions.
## Sources
Competition and US-region rights matter. EPL may use an authorized US broadcaster such as NBC Sports when appropriate; other competitions need their own mappings. FIFA/UEFA official channels may be useful for some events.
## Rule
Resolve competition + region before video discovery. Never assume one soccer channel covers all competitions.

## Implementation (2026-10-03)
- **Eligibility:** every match of a followed club, in any competition (Arsenal `359`, Real Madrid `86`, ESPN team IDs).
- **Events:** ESPN `soccer/all/teams/{id}/schedule` (completed matches, all competitions) plus `?fixture=true` (upcoming); `league.slug` is the competition key. League scoreboards reject date ranges (HTTP 400). Scores are never parsed.
- **Sources (US):**

  | Competition | Source | Title format |
  | --- | --- | --- |
  | Premier League (`eng.1`) | NBC Sports `UCqZQlzSHbVJrwrn5XvzrzcA` | `<Home> v. <Away> \| PREMIER LEAGUE HIGHLIGHTS \| M/D/YYYY \| NBC Sports` |
  | LaLiga (`esp.1`) | ESPN FC `UC6c1z7bA__85CIWZ_jpCK-Q` | `[hype] <Home> vs. <Away> \| LALIGA Highlights \| ESPN FC` |
  | Champions League, League Cup, friendlies | none | — (highlight unavailable) |

  No US-accessible Champions League match highlights were found on UEFA, CBS Sports Golazo, Paramount+, CBS Sports or TNT Sports US (2026-10-03); CBS Golazo posts reactions whose titles carry results. League-official channels were not used (scores in titles; US geo-restriction). NBC also posts goal clips with result language ("stuns Arsenal"); only the full `PREMIER LEAGUE HIGHLIGHTS` format matches.
- **Matching:** home team first (swapped order is flagged, not rejected); ESPN FC hype text may precede the home team; team names from ESPN display/short names plus an alias table (Wolves, Spurs, Man United…); NBC's title date must be the kickoff's US Eastern date ±1 day (separates repeat fixtures); Spanish-language copies are ignored; published after kickoff and within 72h; ≥2 min.
- **Spoilers:** soccer terms catch ESPN FC hype such as "LATE DRAMA", "LATE WINNER", "2 GOALS FOR …". The Real Betis–Real Madrid highlight is excluded from playlists by default for this reason.
- **Backfill (Sep 4–Oct 3, 2026):** 10 matches; 7/7 with a trusted source found and audited correct; 3 unavailable by design (2 Champions League, 1 League Cup); 23 YouTube units (NBC posts ~20 uploads/day, so a 30-day scan is ~13 pages; hourly 7-day scans are ~3).
- **Gap:** Arsenal and Real Madrid Champions League matches will show as unavailable until a US source is verified.
