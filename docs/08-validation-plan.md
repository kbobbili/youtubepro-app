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
- The `embeddable === true` rule is inherited from the in-app player and stays fail-closed; embedding-disabled exclusions are reported separately because SmartTube may play those videos.

**Onn gate (required before multi-sport expansion and before adding `sync-playlists --apply` to the hourly job):**
1. Inspected dry run, then a manual `--apply` of the single `nfl` collection.
2. On the Onn: SmartTube signed in to the publishing account (private playlists are visible only to it; using unlisted playlists needs an explicit decision). Check visibility, titles, thumbnails, exact order, auto-advance, remote controls, and Back/return behavior.
3. Spoiler surfaces the engine does not control: "Up next"/autoplay suggestions, end screens, related videos, comments, and the duration/progress bar.
4. How quickly playlist changes appear on the device (client caching).
5. A second `--apply` against unchanged input makes zero changes.
6. Record the SmartTube version and settings, and every limitation, in the log below. If the delivery path fails the experiment's needs, resolve that before expansion; do not relax the spoiler-free requirement silently.

**Accepted temporary limitation:** all personal sports share one all-or-nothing hourly chain, so one incomplete sport blocks publishing for every collection. This is not independent per-sport refresh.

**Device log:** _no observations yet._

## Exit criteria
Proceed to deeper TV polish when:
- event ingestion is stable for initial sports,
- source registry is producing mostly correct matches,
- missing content is understandable rather than random,
- playback path works reliably,
- generated Catch Me Up queues feel useful.
