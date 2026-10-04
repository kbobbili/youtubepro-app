# SportsCenter — Validation Plan

## Goal
Prove the content pipeline before investing heavily in polish.

## 7–14 day experiment
For each day:
1. Ingest actual completed events.
2. Apply real user preferences.
3. Produce expected/eligible event list.
4. Resolve trusted sources.
5. Discover/match highlights.
6. Verify playability.
7. Record missing/false/late results.

## Metrics
```text
Sport | Eligible Events | Trusted Found | Playable | Correct Match | Median Publish Delay
```
Also record:
- false positives
- source/rights failures
- duplicate sources
- embed/playback failures
- time from event end to usable highlight
- queue runtime and sport balance

## Coverage metric
`playable trusted highlights / eligible events`.

Count distinct eligible events with at least one correct, trusted, playable highlight in the numerator, not video count; alternate videos for one event must not inflate coverage. Record the observation window, viewer region, and playback environment so metadata checks are distinguishable from playback verified on the target TV.

Report two coverage levels separately:
- **Metadata-eligible coverage:** distinct eligible events with a correct, trusted, metadata-eligible highlight (API screening only).
- **Playback-verified coverage:** the subset with a `VERIFIED` target-TV playback observation. Browser checks are recorded as browser evidence only.

Match correctness comes from manual audits (`pnpm review`), recorded per event/video with the method used.

## Observation rules
- **Prospective vs backfill:** a historical backfill is a baseline, not days of observation. Prospective coverage counts only games first observed before they ended. Report the number of actual observation days, missed runs, and failures.
- **Incomplete ≠ missing:** failed or incomplete runs are reported as such and never counted as missing highlights.
- **Latency:** publish delay is reported against estimated end (labelled as an estimate) unless prospective observations bound completion. Time from publish to discovery is limited by run cadence (hourly).
- **Cohorts:** the all-teams diagnostic cohort is reported separately and never enters the personalized library.

Do not set a final pass percentage before collecting data. Evaluate usefulness by sport: a lower-coverage sport may still be worthwhile if high-priority events are consistently found.

## Manual benchmark
During validation, compare a sample with Google sports/search highlight curation and official publisher pages. Google is a sanity benchmark, not a dependency or scrape target.

## First integration order
Start with simpler source ecosystems to prove mechanics:
1. NFL
2. MLB
3. NBA
4. Formula 1
5. Tennis
Then add soccer and cricket source-resolution complexity.

## Cricket-specific validation
Test ICC events separately from bilateral series. For bilateral cricket, record host, competition, US rights context, trusted channels checked, and whether an official highlight existed.

## SmartTube/YouTube-playlist delivery experiment
Experimental and under evaluation (open decision in `07-decisions.md`); it does not replace the accepted TV/product ADRs.

**Pipeline:** discover → snapshot → `pnpm catalog` (collections in `config/collections.yaml`, written to `data/catalog.json`) → `pnpm sync-playlists` (dry run by default; `--apply` publishes private playlists to the account authorized with `pnpm youtube-login`). The hourly chain is fail-closed: an incomplete discovery or catalog stops every later step, and the publisher preserves remote playlists whenever its input is incomplete or stale.

**What screening does and does not establish:**
- Title screening is a heuristic (`unflagged` = no warning found). It does not establish the spoiler-free requirement, and it does not check thumbnails, durations, or indirect result language.
- Metadata screening is not playback evidence. Record device playback with `pnpm review --playback <videoId> verified|failed --env target-tv`.
- Embedding-disabled videos are eligible for discovery and collections, because SmartTube does not embed (user decision 2026-10-03). The v1 library export, whose contract means "embeddable", still excludes them.

**Onn gate (required before adding `sync-playlists --apply` to the hourly job):**
Sequencing (user decision 2026-10-03): F1, soccer, tennis and cricket are built and audited first, and the first publish covers all enabled collections at once. The gate below runs on that first publish; device findings may still require changes to every sport.
1. Inspected dry run, then a manual `--apply` of the enabled collections.
2. On the Onn: SmartTube signed in to the publishing account (private playlists are visible only to it; using unlisted playlists needs an explicit decision). Check visibility, titles, thumbnails, exact order, auto-advance, remote controls, and Back/return behavior.
3. Spoiler surfaces the engine does not control: "Up next"/autoplay suggestions, end screens, related videos, comments, and the duration/progress bar.
4. How quickly playlist changes appear on the device (client caching).
5. A second `--apply` against unchanged input makes zero changes.
6. Record the SmartTube version and settings, and every limitation, in the log below. If the delivery path fails the experiment's needs, resolve that before expansion; do not relax the spoiler-free requirement silently.

**Failure isolation (per collection, 2026-10-03):** each sport's discovery runs independently. A failed, incomplete or stopped discovery (latest run older than `maxDiscoveryAgeHours`) marks only that sport's collections, and mixed collections containing it, incomplete; the publisher keeps those playlists as last-known-good and still updates healthy ones. Only a catalog that fails to build blocks publishing. Any failed step makes the hourly run exit non-zero.

**Publish budget:** a safety rail at 8,000 of the project's default 10,000 daily units, reserving headroom for discovery, rather than a throttle.

**Sport status (2026-10-03, live backfills audited match by match):**

| Sport | Source(s) | Backfill result | Notes |
| --- | --- | --- | --- |
| NFL | NFL | 20/20 correct (Weeks 1–4; followed and diagnostic games) | Weeks 1–2 title variants added after the audit caught two misses |
| F1 (race) | FORMULA 1 | 3/3 | — |
| Soccer | NBC Sports (EPL), ESPN FC (LaLiga) | 7/7 sourced; 3 unavailable by design | No US Champions League source; one "LATE DRAMA" title screened out |
| Tennis (ATP, Top 30) | ATP Tour | 35 found, 1 never uploaded, 9 pending | Not published: winner-first name order (open decision) |
| Cricket (ODI/T20I) | Willow (per series) | 10/10 covered; 10 uncovered series; 4 never uploaded | Tests deferred; add series as Willow covers them |

**Design deviations from the engine plan (2026-10-03):** each sport runs its own discovery (one uploads scan per source per sport) instead of a single combined channel scan, matching per-sport failure isolation; spoiler terms live in one per-sport table in `spoilers.ts` rather than behind the adapter interface; backfills may scan up to 60 uploads pages (hourly runs keep 20).

**Device log:** _no observations yet._

## Exit criteria
Proceed to deeper TV polish when:
- event ingestion is stable for initial sports,
- source registry is producing mostly correct matches,
- missing content is understandable rather than random,
- playback path works reliably,
- generated Catch Me Up queues feel useful.
