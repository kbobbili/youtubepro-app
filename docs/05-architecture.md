# SportsCenter — Architecture

## System view
```text
┌───────────────────────────────┐
│ SPORTS DATA SOURCES           │
│ schedules · events · rankings│
└──────────────┬────────────────┘
               ↓
┌───────────────────────────────┐
│ SPORTSCENTER ENGINE           │
│ event ingestion               │
│ preference filtering          │
│ source resolution             │
│ YouTube discovery             │
│ matching / confidence         │
│ retries                       │
│ 7-day library                 │
│ queue generation              │
│ watch state                   │
└──────────────┬────────────────┘
               │ JSON API
               ↓
┌───────────────────────────────┐
│ REACT NATIVE TV APP           │
│ Home · Sport · Catch Up       │
│ Player · Settings             │
└──────────────┬────────────────┘
               ↓
       supported video playback
```

## Boundaries
### Sport adapters
Normalize schedules/events/rankings. Each sport may use a different provider.

### Preference engine
Deterministic eligibility rules where possible. Avoid AI for logic that can be explicit.

### Source resolver
Maps event context to ordered trusted publisher IDs.

### Video discovery/matcher
Recent trusted uploads first; constrained search fallback; confidence + duplicate handling.

### Library/queue service
Stores metadata/watch state and creates duration-aware queues.

### TV client
Thin presentation/API client with excellent D-pad/focus/player behavior.

## Explicit non-responsibilities
No video hosting, downloading, transcoding, IPTV, EPG, recording, or general media-server functionality.

## Deployment (ADR-014)
The SportsCenter Engine runs on the user's always-on home laptop. It runs discovery on a schedule and serves the library to the TV over the home LAN.

- The TV keeps its last successfully fetched library and stays usable (with cached content) when the laptop is asleep, off, or unreachable.
- Engine runs are idempotent and catch up after sleep: each run scans uploads since the last successful run rather than assuming no gaps.
- The TV needs a stable address for the engine (DHCP reservation or hostname); treat it as client configuration, not a hard-coded value.
- Moving to a small server or scheduled cloud job later should change only the hosting, not the library contract.

## Security/config
Keep API keys outside source control. Separate user preferences from secrets. Respect provider quotas and terms. Log source/match decisions for debugging without storing unnecessary video data.
