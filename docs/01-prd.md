# SportsCenter — Product Requirements Document

## Problem
Sports highlights are fragmented across leagues, governing bodies, tournaments, broadcasters, and official YouTube channels. Manual YouTube search creates piracy/clickbait noise and requires knowing what happened before searching. SportsCenter discovers relevant completed events first, then locates trusted highlights and presents them as a personal rolling sports library.

## Target
- Google TV / Android TV, initially an Onn Google TV device.
- React Native TV client.
- External supported video delivery; never download/rehost videos.

## Core user stories
1. Automatically determine completed events matching my interests.
2. Show only official/authorized highlight sources.
3. Hide scores/results until I choose to reveal them.
4. Retain unwatched highlights for roughly a week.
5. One **Catch Me Up** action builds a continuous queue.
6. Quick (~20m), Standard (~45m), Everything queue choices; targets configurable.
7. Continue Watching and playback progress.
8. Browse by sport when desired.
9. Configure different eligibility rules per sport.
10. Show “official highlight unavailable” instead of substituting untrusted video.

## Personalization
### Cricket
- Configurable prominent Test-playing nations.
- Nation priorities; a favorite nation may be MUST/HIGH.
- Broad ICC-event following.
- Bilateral source resolution may depend on host board/broadcaster and region.

### Tennis
- Eligible if at least one singles player meets configured ranking threshold; initial concept ATP/WTA Top 30.
- Rankings refresh automatically.
- Grand Slams use tournament-specific sources; regular tour coverage uses approved tour sources.

### Soccer
- Selected clubs and/or national teams across supported competitions.

### NBA / NFL / MLB
- Selected teams.
- League-operated official YouTube channels preferred where suitable highlights exist.

### Formula 1
- Selected/all race weekends; qualifying/race initially, other sessions configurable.

### WWE / similar
- Selected programs/events; optional depending on V1 scope.

## Content windows
- Home/Catch-Up: rolling 7 days.
- 0–24h: highest prominence.
- 1–3 days: normal catch-up.
- 4–7 days: Earlier This Week.
- Shelf mapping: **New For You** = unwatched highlights 0–3 days old, with 0–24h ordered first; **Earlier This Week** = unwatched highlights 4–7 days old. Boundaries are configurable; what age is measured from (event end, publish, or discovery) is an open decision in `07-decisions.md`.
- History metadata: ~90 days initially; configurable.
- Saved: later feature.

## Discovery lifecycle
Exact retry timing is a hypothesis; see `03-content-discovery.md` (Retry lifecycle) and `06-data-model.md` (Discovery status). Tune from measured publication latency.

## Queue behavior
- Catch Me Up selects unwatched highlights in rolling window.
- Ranking combines recency, user priority, sport balance, event importance, and duration target.
- Prevent high-volume sports from monopolizing mixed queues.
- Watched items leave default Catch Me Up but remain in history/sport views.

## Spoilers
- No final scores on default cards.
- Avoid winner/advancement language; generate neutral event titles where possible.
- Results may be stored internally for identity but hidden in presentation.
- Later setting can reveal scores.

## V1 screens
1. Home
2. Catch Me Up / queue preview
3. Sport
4. Player + Up Next
5. Settings / My Sports

## Non-goals
Movies/shows, live TV/IPTV/EPG, TiviMate integration, rehosting/transcoding, news/social feeds, fantasy/betting, exhaustive worldwide coverage.

## Success criteria
Measure `eligible events → trusted highlight found → playable`, publication latency, false matches, and user usefulness. UI polish alone does not prove viability.
