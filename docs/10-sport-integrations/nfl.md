# NFL Integration
## Eligibility
Selected teams.

Initial preferences (configuration, not code): San Francisco 49ers, Buffalo Bills.
## Event data
ESPN scoreboard (ADR-016): `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=YYYYMMDD`.
- Observed 2026-10-02: `dates` is a US Eastern calendar date; ranges (`YYYYMMDD-YYYYMMDD`) return HTTP 400; a day without games returns `events: []`.
- Fields used: event ID, start time, season/type/week, status (`pre`/`in`/`post` + `completed`), home/away team abbreviation and names. Scores are not parsed.
- No end time is provided. The engine estimates start + 3h15m (hypothesis) and records observation bounds prospectively.
- Fallback candidate (unvalidated): nflverse `games.csv`.

## Source
Official NFL YouTube channel `UCDVYQ4Zhbm3S2dlz7P1GBDg`, verified 2026-10-02 (nfl.com footer → `youtube.com/user/NFL/` → channel ID). See `config/sources.yaml`.

## Title patterns (observed 2026 Weeks 3–4)
`{Away} vs[.] {Home} Game Highlights[ from {City}] | {2026 NFL Season | NFL 2026 Season} Week {N}`
- Examples: `Arizona Cardinals vs. San Francisco 49ers Game Highlights | NFL 2026 Season Week 3`; `Baltimore Ravens vs Dallas Cowboys Game Highlights from Rio | 2026 NFL Season Week 3`.
- Durations observed 10:34–23:42; the 8–20 minute range is a scoring hint only.
- The channel posts ~45–50 uploads per day, mostly clips and Shorts; matching requires full team identity, season, and week.
- Not yet observed: preseason and postseason naming (currently unmatched by design).

## Results log
| Date | Run | Window (event start) | Eligible | Metadata eligible | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-10-02 | backfill, all teams | Sep 24–30 | 16 | 16 | All 16 Week 3 games; titles audited against events (videos not watched). ~12 units. |
| 2026-10-02 | backfill, personal | last 7 days | 2 (LAC@BUF, ARI@SF) | 2 | Target-TV playback NOT_TESTED. |

Known misses: none yet. Prospective hourly observation started 2026-10-02 (Task Scheduler).
## Why early
Relatively simple source mapping and structured schedule; good candidate for first end-to-end adapter.
