# SportsCenter — Conceptual Data Model

Implementation technology is intentionally undecided.

## Core entities
### Sport / Competition
Identity and metadata for a sport and competition.

### Team
`id, sportId, canonicalName, aliases, externalIds`

### Player
`id, sportId, canonicalName, aliases, externalIds`

### RankingSnapshot
`tour, asOf, playerId, rank`

### Event
```text
id
sportId
competitionId
startTime
endTime
status
participants[]   # team/player/driver references
round/session
externalIds{}
resultData?       # internal; spoiler-sensitive
```

### UserPreference
```text
sportId
ruleType          # team, nation, rankingThreshold, competition, eventType
targetId/value
priority          # must/high/normal/low
enabled
```

### Source
```text
id
sportId
platform
platformChannelId
displayName
tier
regions[]
competitions[]
verifiedAt
rules{}
```

### DiscoveryAttempt
`eventId, sourceId, attemptedAt, query/method, outcome, diagnostics`

### HighlightCandidate
`eventId, sourceId, videoId, title, publishedAt, duration, thumbnail, confidence, playable, rejectionReason?`

### Highlight
```text
id
eventId
sourceId
videoId
neutralTitle
thumbnail
duration
publishedAt
discoveredAt
confidence
officialStatus
```

### WatchState
`highlightId, positionSeconds, watched, lastPlayedAt`

### Queue
`id, type, targetMinutes?, createdAt, highlightIds[]`

## State concepts
### Event status (from sports data)
`SCHEDULED → IN_PROGRESS → COMPLETED`, plus `POSTPONED | CANCELLED`. Owned by the sport adapter.

### Discovery status (per eligible event) — initial model, hypothesis
```text
WAITING_FOR_EVENT_END ─▶ SEARCHING ─▶ FOUND
                             │          │ (video removed / no longer playable,
                             ▼          │  no alternate candidate)
                        UNAVAILABLE ◀───┘
                             │
                             └─▶ FOUND   (late upload matched while event is inside the 7-day window)
```
- `FOUND` requires at least one trusted, matched, **playable** candidate.
- A matched but non-embeddable/region-blocked video is a `HighlightCandidate` with `playable=false` and a `rejectionReason`; it never makes the event `FOUND`.
- If the primary highlight becomes unplayable, promote the next alternate; if none, return to `UNAVAILABLE`.

### Watch state
`UNWATCHED → IN_PROGRESS → WATCHED`.

## Retention
7-day Home is a query/presentation rule, not necessarily deletion. Keep metadata/history longer (~90 days initial target).
