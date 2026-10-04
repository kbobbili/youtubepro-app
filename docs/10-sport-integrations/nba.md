# NBA Integration
## Eligibility
Selected teams.
## Source
Prefer verified official NBA YouTube channel when it provides suitable game highlights.
## Validation
Measure consistency, duration, publication latency, and embeddability/playback behavior.

## Implementation (2026-10-03)
- **Eligibility:** Knicks (`NY`), Warriors (`GS`), Thunder (`OKC`), 76ers (`PHI`); regular season and postseason by default (`seasonTypes`; add `preseason` to include exhibition games). The 2026-27 regular season starts Oct 20, so the team playlists start empty.
- **Events:** ESPN `basketball/nba/scoreboard?dates=YYYYMMDD` per US Eastern day (ranges return HTTP 400); `season.slug` preseason / regular-season / post-season (play-in counts as postseason). Scores are never parsed.
- **Source:** NBA (`UCWJ2lWNubArHWmf3FIHbfcQ`), verified via nba.com → `youtube.com/user/NBA`.
- **Matching:** `[EXTENDED: ][#seed ]<AWAY> at [#seed ]<HOME> | <… HIGHLIGHTS> | <Month D, YYYY>` — preseason ("NBA PRESEASON FULL GAME HIGHLIGHTS"), playoffs ("FULL GAME 7 HIGHLIGHTS"), Finals ("NBA FINALS GAME 5 HIGHLIGHTS"). Teams by nickname ("76ERS"); the title date must be the tip-off's Eastern date ±1; season phase and playoff game number must agree. "EXTENDED:" copies also match (flagged); the standard cut wins ties by earlier publication. Summer League, All-Star, throwbacks and clips never match. The regular-season label has not been observed yet (expected "FULL GAME HIGHLIGHTS"); verify on the first regular-season games.
- **Validation so far:** the pipeline found the official Heat at Raptors preseason highlight (Oct 3) in a recorded test run; no followed team has completed a game yet.
