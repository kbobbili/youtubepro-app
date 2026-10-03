# SportsCenter Project Knowledge Pack

Start with `docs/00-product-vision.md`, then the PRD, discovery, and decisions docs.

Publisher examples and rights mappings are candidates to validate, not blanket rights claims.

## Current state
Phase 0 content proof for NFL is running. The engine discovers official NFL highlights for followed teams (49ers, Bills) and writes a spoiler-free library snapshot. Hourly prospective runs started 2026-10-02. No TV app exists yet; target-TV playback is untested.

## Engine commands
Requires Node 24.19+ and pnpm 11 (`pnpm install`), and a YouTube Data API key in `.env` (see `.env.example`).

```sh
pnpm discover nfl --days 7               # followed teams; add --all-teams for the diagnostic cohort
pnpm discover nfl --from 2026-09-24 --to 2026-09-30 --kind backfill
pnpm report --kind prospective           # coverage, latency, audits, quota
pnpm snapshot                            # writes data/library.json (TV contract)
pnpm review <eventId> <videoId> correct  # record a manual match audit
pnpm migrate                             # back up, then upgrade the database schema (required after upgrades)
pnpm catalog                             # writes data/catalog.json (collections; revalidates retained videos)
pnpm youtube-login                       # one-time OAuth for the playlist experiment
pnpm sync-playlists [--apply]            # dry run by default; see docs/08 (SmartTube experiment)
pnpm test && pnpm typecheck
```

Hourly runs: `scripts/register-task.ps1` registers a Windows Task Scheduler task running `scripts/run-hourly.ps1` (logs in `data/logs/`).

## Starting points
- [Project brief](intro.md) — onboarding context and original assignment.
- [Agent guidance](CLAUDE.md) — working rules and documentation map.
- [Decision log](docs/07-decisions.md) — accepted decisions and unresolved questions.
- [Validation plan](docs/08-validation-plan.md) — event-to-playable-highlight evidence to collect.
- [Roadmap](docs/09-roadmap.md) — implementation phases.

Begin with Phase 0 content proof for one sport. NFL is the first candidate in the validation plan; provider choice and verified channel IDs still need to be established. Decided: engine on the home laptop (ADR-014), US viewer region (ADR-015), initial NFL teams 49ers and Bills. Keep proposals separate from accepted decisions.
