# MLB Integration
## Eligibility
Selected teams.
## Source
Prefer verified official MLB YouTube channel for game highlights.
## Research notes (2026-10-02, unvalidated)
Postseason titles vary (e.g. `PHILLIES vs. BRAVES: Full 2026 Wild Card Series Highlights`, `EVERY PLAY from ...`); expect fuzzier matching than NFL.

## Queue concern
High game volume makes personalization essential; only followed teams should enter normal mixed queue.

## Implementation (2026-10-03)
- **Eligibility:** Yankees (`NYY`), Dodgers (`LAD`), Braves (`ATL`); regular season and postseason (`seasonTypes`; spring training not included).
- **Events:** ESPN `baseball/mlb/scoreboard?dates=YYYYMMDD` per US Eastern day (ranges return HTTP 400). `season.slug` gives the phase; postseason `notes[0].headline` ("NLWC - Game 2") gives the game number. Doubleheaders (same teams, same Eastern day) are numbered by start time. Scores, series summaries and status details ("Final/10") are never parsed.
- **Source:** MLB (`UCoLrcjPV5PbUrUyXq5mjc_A`), verified via mlb.com → `youtube.com/mlb`.
- **Matching:** only the full-game formats — `<AWAY> vs. <HOME>: Official Full Game [n] Highlights (<Month D>)` (regular season; `n` only in doubleheaders) and `<AWAY> vs. <HOME>: <Round> Full Game <n> Highlights (<Month D>)` / `<Round> Game <n> Full Game Highlights` (postseason). Teams by ESPN display/short name plus aliases (D-BACKS); title date = first pitch's Eastern date ±1; season phase must agree; a numbered title must name this game, and an unnumbered title never picks between doubleheader games. The channel's many clips and series recaps (often with results: "… to take a 1-0 series lead", "Braves take Wild Card Series…") never match.
- **Spoilers:** full-game titles are neutral. ⚠ Result clips on the same channel may appear in SmartTube's "Up next".
- **Backfill (Sep 15–Oct 3, 2026):** 41/41 games found and audited correct (regular season, two doubleheaders, Wild Card, Division Series game 1); 18 YouTube units. The audit caught the D-BACKS alias and the doubleheader numbering before publishing.
