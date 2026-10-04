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

## Implementation (2026-10-03)
- **Eligibility:** ATP men's singles main draw where either player is ranked ≤ 30 (WTA deferred). Qualifying rounds are excluded.
- **Ranking policy (experimental, not the resolution of the open decision in `07-decisions.md`):** use the latest complete ESPN ATP snapshot whose provider update time is within `maxRankingAgeDays` (10; ATP updates weekly). Each run stores the snapshot (`ranking_snapshots`) and every event's eligibility outcome with the ranks it used (`run_events.reason`, e.g. `ranks 6/>list (snapshot …)`). A fetch failure may use a stored snapshot only while it is complete and still fresh (reported as a run note). Stale, missing or partial snapshots make eligibility unknown: the run is incomplete and no event is treated as "not followed". A player absent from a complete snapshot is a known rank outside the list, not a missing rank. TBD participants are pending.
- **Events:** ESPN `tennis/atp/scoreboard?dates=YYYYMMDD` per day (each response carries the active tournaments' full draws); `groupings[slug=mens-singles].competitions[]`; city from `venue.fullName`; draw order (`order`), never result, sets participant order. `winner`/linescores are never parsed. Walkovers count as cancelled (no match played).
- **Source:** ATP Tour `UCY_5h5zaSwN7Or4kIJDYNXA` (atptour.com footer link) for tour events. Grand Slams resolve to their own competition key and stay unavailable until a slam channel is verified. Tennis TV is not used (titles announce results).
- **Matching:** `<A> vs <B> Highlights | <City> [year] <Round>`. Players must resolve to the event's two participants in either order: same words in any order ("Yunchaokete Bu" = "Bu Yunchaokete"), or a shortened name of ≥ 2 words contained in the full name ("Coleman Wong" → "Chak Lam Coleman Wong"). Surnames alone never match, so shared surnames cannot collide. City must match (trailing "Open" ignored; China Open ↔ Beijing, Japan Open ↔ Tokyo); round must match (R2 = Round 2, QF = Quarter-Final = Quarterfinal); year must equal the season when present. Repeat matchups are separated by tournament, round and year. ATP packages run ~2–3 minutes, so the clip floor is 60 s for tennis. Shorts ("Djokovic vs Borges Beijing R1 Highlights 🤩 #ChinaOpen") and exhibitions ("| Laver Cup 2026 Day 1") don't parse.
- **⚠ Spoiler — name order:** ATP Tour titles list the match winner first more often than not: in 64 titles matched to finished matches, the winner was named first in 39 (61%) (offline check against ESPN results, 2026-10-03; results never enter the engine). SmartTube shows raw titles, so name order leaks a biased hint the title screen cannot detect. The user accepted this hint for the SmartTube playlist experiment (2026-10-03); tennis is published, capped at 10 in `this-week`.
- **Backfill (Sep 26–Oct 3, 2026; Chengdu, Hangzhou, Tokyo, Beijing):** 45 eligible matches; 35 found and audited correct; 1 unavailable (Medvedev–Royer was never uploaded); 9 still within the 72h window (the ATP Tour does not post every match). 5 YouTube units plus ~12 ESPN calls.
- **Volume:** a busy week yields 30–50 eligible matches; `this-week` caps tennis at 10 and the tennis collection at 30.
