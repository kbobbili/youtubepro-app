# SportsCenter — Content Discovery & Matching

## Core rule
**Determine events first. Find video second.** Sports schedule/event/ranking data determines eligible events. YouTube is queried only after SportsCenter knows the exact event.

## Pipeline
```text
SPORTS DATA
 schedules / completed events / rankings
             ↓
PERSONAL ELIGIBILITY
 teams / nations / rank thresholds / event types
             ↓
ELIGIBLE EVENTS
             ↓
SOURCE RESOLVER
 approved channels plausible for this event
             ↓
DISCOVERY
 recent uploads first; constrained search fallback
             ↓
MATCH + VALIDATE
             ↓
7-DAY SPORTSCENTER LIBRARY
             ↓
QUEUE GENERATION
```

## Event ingestion
Each sport adapter provides stable event identity, participants, competition, start/end time, and status. Scores may be ingested but need not be displayed.

## Eligibility examples
- Cricket: configured nation/competition participates.
- Tennis: at least one singles participant rank <= threshold.
- Soccer/NBA/NFL/MLB: followed team participates.
- F1: configured weekend/session type.

## Discovery
### Primary — known channel uploads
Inspect recent uploads for resolved trusted channels around event date. This is controlled, cheap, and avoids global search noise.

### Secondary — constrained YouTube search
When needed, constrain by approved channel ID, event terms, publication window, video type, and embeddability/playability where supported.

**Never surface unrestricted global YouTube results.** Broad search may be a developer diagnostic only; a channel must be explicitly trusted before content is eligible.

## Candidate matching signals
Participant names, competition/round, highlight naming patterns, publication time, source tier, plausible duration; reject/penalize preview, prediction, press conference, reaction, interview, Shorts, simulation, etc. Tune weights empirically.

## Duplicates
If multiple trusted sources cover one event, choose a primary by source priority, region/playability, duration/quality, and match confidence. Keep alternates internally for fallback.

## Retry lifecycle
States and transitions are defined once in `06-data-model.md` (Discovery status).

Initial retry hypothesis after event end: +1h, +4h, +12h, +24h, +36h, then a final attempt around +72h before marking `UNAVAILABLE`. Measure and tune per source/sport.

Because the primary method scans each trusted channel's recent uploads, every scan can match *any* eligible event still inside the 7-day window. Per-event retry timing therefore mainly governs the quota-expensive constrained-search fallback, and a late upload can still move an `UNAVAILABLE` event to `FOUND`.

## Retention
Found metadata stays on Home ~7 days. Watch/history metadata can persist ~90 days or longer. No video bytes are stored.

## Failure philosophy
False negative > false positive. If source trust or match confidence is insufficient, keep pending/unavailable.
