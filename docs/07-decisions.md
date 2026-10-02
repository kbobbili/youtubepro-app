# SportsCenter — Decision Log (ADR-lite)

## ADR-001 — Custom React Native TV client
**Decision:** Build a purpose-built React Native TV app.  
**Why:** The differentiated product is the lean-back discovery UX.  
**Alternatives considered:** TiviMate (IPTV/EPG abstraction), Jellyfin (owned-library abstraction), Kodi (flexible but media-center UX), WebView (viable prototype, native TV preferred).

## ADR-002 — Event-first, not YouTube-first
Sports data determines what happened; YouTube supplies video after an event is selected.

## ADR-003 — Official/authorized sources only
No arbitrary YouTube results. Prefer missing content over questionable content.

## ADR-004 — Source registry by immutable IDs
Trust channel IDs, not names/logos.

## ADR-005 — Rolling 7-day Home
Unwatched content survives day boundaries. History metadata can persist ~90 days.

## ADR-006 — Spoiler-free by default
Do not lead with scores/winners. Use neutral generated event titles when source metadata spoils results.

## ADR-007 — Thin TV client
Keep intelligence in SportsCenter Engine. Do not build media-server/transcoding infrastructure.

## ADR-008 — Sport-specific eligibility and source resolution
Cricket, tennis, soccer, US leagues, and F1 have materially different rules; implement adapters rather than one generic heuristic.

## ADR-009 — No Shows/Movies/Live TV in V1
The earlier “personal TV hub” idea is deferred. First prove a focused sports-highlight product.

## ADR-010 — Catch Me Up is the primary action
Quick/Standard/Everything queues support lean-back use; browsing is secondary.

## ADR-011 — Known uploads before search
Check approved channel uploads first; constrained channel-specific search is fallback.

## ADR-012 — Content reliability gates development
Before heavy polish, validate eligible-event-to-playable-highlight coverage over 7–14 days.

## ADR-013 — SportsCenter application name
**Decision:** The application is named SportsCenter.  
**History:** Pulse / PulseTV were brainstorming names, superseded by the final name in `intro.md`. Existing product and architecture decisions remain unchanged.  
**Note:** Private, sideloaded use only. "SportsCenter" is an existing ESPN brand; revisit the name if distribution is ever considered.

## ADR-014 — Engine runs on the home laptop
**Decision:** For now the SportsCenter Engine runs on the user's always-on home laptop and serves the TV over the LAN.  
**Why:** Simplest setup for one user and one TV; no cloud infrastructure before content coverage is proven.  
**Consequences:** The TV caches the last library so laptop sleep/outage degrades to stale content rather than an empty app. Hosting can move later without changing the library contract.

## ADR-015 — Viewer region is the US
**Decision:** Source resolution, rights mapping, and playability checks target a US viewer.  
**Why:** The TV and user are in the US; regional rights (e.g. US soccer broadcasters, US cricket rights) and region-blocked uploads depend on it.  
**Consequences:** Playability checks evaluate US availability. Region stays a configuration value so registry entries keep their `regions[]` scope.

## Open decisions
These are unresolved questions, not replacements for accepted ADRs or the current architecture. In particular, ADR-007 and `05-architecture.md` currently assign queue generation and persistent watch state to the engine; a client-owned alternative would require an explicit decision.

- Sports data providers per sport.
- Exact YouTube playback integration in RN TV.
- Engine runtime/database (hosting decided in ADR-014).
- Exact retry intervals and confidence thresholds.
- Initial preferences beyond NFL (NFL: 49ers, Bills — see `10-sport-integrations/nfl.md`).
- Whether WWE belongs in V1.
- Where watch state and queue assembly live for a single-device setup (engine vs TV client).
- Spoiler policy for thumbnails, video duration, and YouTube player chrome (title overlay, end screens), not just titles.
- Source-tier precedence: `intro.md` lists four preferred categories, including a separate streaming/service tier; `04-source-registry.md` defines three tiers. Reconcile before encoding fallback precedence; publisher examples remain unverified.
- Seven-day window anchor: event completion, video publication, or discovery time, including treatment of late highlights.
- Watch-state identity and completion threshold: `06-data-model.md` keys progress by highlight; define whether watching one video also satisfies the event when an alternate source is selected.
- Ranking snapshot used for tennis eligibility (at event time vs latest available) and handling of stale or missing rankings.
- Queue behavior when a video fails: retry, alternate source, skip, or stop; define how the user is informed without silently marking it watched.
