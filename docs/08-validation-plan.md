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

## Exit criteria
Proceed to deeper TV polish when:
- event ingestion is stable for initial sports,
- source registry is producing mostly correct matches,
- missing content is understandable rather than random,
- playback path works reliably,
- generated Catch Me Up queues feel useful.
