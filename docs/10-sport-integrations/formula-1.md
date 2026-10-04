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

## Implementation (2026-10-03)
- **Eligibility:** race only (user preference); qualifying, sprint and practice are not followed.
- **Events:** ESPN `racing/f1/scoreboard?dates=YYYYMMDD-YYYYMMDD` (ranges work). One event per weekend with one competition per session; the race is `type.abbreviation = "Race"`. Status comes from the race competition, because the weekend status was observed as `STATUS_FINAL` while its race was still scheduled. Results and standings are never parsed.
- **Neutral title:** sponsor-free Grand Prix name derived from the ESPN name with a known-GP list ("Tag Heuer Spanish Grand Prix" → "Spanish Grand Prix"; "Gulf Air Bahrain Grand Prix in Malaysia" → "Bahrain Grand Prix in Malaysia").
- **Source:** FORMULA 1 (`UCB_qr75-ydFVKSF9Dmo6izg`), verified via formula1.com → `youtube.com/c/f1`. All three September race highlights passed the US region screen.
- **Matching:** title must start `Race Highlights |`; Grand Prix name must equal the event's (diacritics/case-insensitive, alias table for Spanish ↔ Barcelona-Catalunya, Mexican ↔ Mexico City, Brazilian ↔ São Paulo); year must equal the season when present (missing year is flagged, not rejected); published after the race start and within 72h of estimated end; at least 2 minutes long. F2/F3, sprint, qualifying, practice and "Extended Highlights | <older year>" uploads never match.
- **Spoilers:** race titles observed are neutral. Extra F1 terms (pole, podium, crash, DNF, retired, crowned) flag result-style titles.
- **Backfill (Sep 1–Oct 3, 2026):** 3/3 races found and audited correct — Italian `uptj3to1l7o`, Spanish `NK7AfP_wi8M`, Azerbaijan `I9oahfzac0I` (~8 min each); 6 YouTube units.
- **Quota:** one ESPN call; the F1 channel posts ~35 uploads/week, so a 7-day scan is 1–2 pages.
