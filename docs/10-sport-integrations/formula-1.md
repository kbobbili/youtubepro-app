# Formula 1 Integration
## Eligibility
Configured/all race weekends; initial event types qualifying and race. Sprint/practice optional.
## Source
Prefer verified official Formula 1 YouTube channel.
## Research notes (2026-10-02, unvalidated)
- ESPN `racing/f1/scoreboard` returned the 2026 calendar with event IDs. Jolpica (`api.jolpi.ca/ergast/f1/...`) returned 2026 results; OpenF1 offers free historical session data.
- Official channel posts per-session titles, e.g. `FP1 Highlights | 2026 <Grand Prix>`. US rights moved to Apple in 2026; check `regionRestriction` per video.

## Model
Event-based rather than team-based. One weekend can yield multiple eligible highlight items.
