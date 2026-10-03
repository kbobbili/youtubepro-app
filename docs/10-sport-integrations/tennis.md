# Tennis Integration
## Eligibility
Singles match eligible if at least one player is within configurable ATP/WTA ranking threshold; initial concept Top 30.
## Data
Need current rankings plus completed tournament matches.
## Sources
Regular ATP coverage: validate Tennis TV/official tour channel IDs. Grand Slams: tournament-specific official channels (Australian Open, Roland-Garros, Wimbledon, US Open). WTA mapping must be validated separately.
## Research notes (2026-10-02, unvalidated)
- ESPN returned ATP scoreboard and ATP rankings responses (`site.api.espn.com/.../tennis/atp/scoreboard`, `sports.core.api.espn.com/v2/sports/tennis/leagues/atp/rankings`). WTA equivalents are not yet checked.
- `github.com/JeffSackmann/tennis_atp` and `tennis_wta` returned 404 when checked on 2026-10-02. This shows they were unreachable on that date, not when or why they were removed. No open fallback for current results/rankings is confirmed.

## Queue concern
Many eligible matches can occur daily; mixed queues need caps/priority (Top 10, Grand Slam, later rounds, etc.).
