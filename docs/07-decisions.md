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

## ADR-016 — ESPN-first event data behind per-sport adapters
**Decision:** Start each sport with ESPN's public scoreboard JSON (unofficial, undocumented, free), isolated behind a per-sport adapter so any sport can switch providers without touching eligibility, discovery, or the TV contract.
**Why:** Desk research on 2026-10-02 found no affordable aggregator covering all seven sports; tennis and cricket were the gaps for every low-cost option checked. This is a strategy choice, not proven coverage.
**Status:** Validated for NFL only (see `10-sport-integrations/nfl.md`). Coverage, freshness, and ranking quality for other sports remain open per sport. Candidate fallbacks (nflverse, Jolpica, CricketData.org, football-data.org) are unvalidated.
**Risk:** No service guarantee; ESPN can change or block endpoints. Adapters must report failed or incomplete fetches as such, never as "no events".

## ADR-017 — Engine runtime: Node 24 + TypeScript + SQLite
**Decision:** The engine is a TypeScript CLI on Node 24 (`tsx`, no build step) in a pnpm workspace, persisting to Node's built-in `node:sqlite` at `data/sportscenter.db`. The TV ↔ engine contract lives in `packages/contracts` (zod schema).
**Why:** One language across engine and React Native client; no native database dependency; a single file is easy to inspect and back up on the laptop.
**Note:** One YouTube API key (one Google Cloud project) is used. Keys are not rotated to stretch quota; measured usage is ~11 units per run.

## Open decisions
These are unresolved questions, not replacements for accepted ADRs or the current architecture. In particular, ADR-007 and `05-architecture.md` currently assign queue generation and persistent watch state to the engine; a client-owned alternative would require an explicit decision.

- Per-sport event provider validation beyond NFL (ADR-016), including tennis rankings and cricket series context.
- Exact YouTube playback integration in RN TV.
- Exact retry intervals and confidence thresholds.
- NFL preseason/postseason title formats (not yet observed; currently unmatched by design).
- Initial preferences beyond NFL (NFL: 49ers, Bills — see `10-sport-integrations/nfl.md`).
- Whether WWE belongs in V1.
- Where watch state and queue assembly live for a single-device setup (engine vs TV client).
- Spoiler policy for thumbnails, video duration, and YouTube player chrome (title overlay, end screens), not just titles.
- Source-tier precedence: `intro.md` lists four preferred categories, including a separate streaming/service tier; `04-source-registry.md` defines three tiers. Reconcile before encoding fallback precedence; publisher examples remain unverified.
- Seven-day window anchor: event completion, video publication, or discovery time, including treatment of late highlights.
- Watch-state identity and completion threshold: `06-data-model.md` keys progress by highlight; define whether watching one video also satisfies the event when an alternate source is selected.
- Ranking snapshot used for tennis eligibility (at event time vs latest available) and handling of stale or missing rankings.
- Queue behavior when a video fails: retry, alternate source, skip, or stop; define how the user is informed without silently marking it watched.
- **Tennis playlists and ATP title name order (2026-10-03).** ATP Tour titles name the match winner first in 39 of 64 checked titles (61%); SmartTube shows raw titles, so name order leaks a biased result hint that no title screen can detect. Tennis collections are built but not published (and capped at 0 in `this-week`) until the user decides whether that leak is acceptable. See `10-sport-integrations/tennis.md`.
- **Champions League highlights in the US (2026-10-03).** No US-accessible match-highlight source was found (UEFA, CBS Sports Golazo, Paramount+, CBS Sports, TNT Sports US checked); Arsenal and Real Madrid Champions League matches show as unavailable until one is verified.
- **SmartTube/YouTube-playlist delivery experiment — under evaluation (2026-10-03).** The engine can publish catalog collections to the user's private YouTube playlists for viewing in SmartTube on the Onn, as an alternative to building the RN TV client. This does **not** accept the pivot or replace ADR-001, ADR-006, ADR-007 or ADR-010. Known gaps against accepted requirements: SmartTube shows raw publisher titles and thumbnails (the engine's title heuristic is not proof of spoiler safety); playlist membership provides no engine-owned watch state or Catch Me Up behavior. For this experiment, embedding-disabled videos are eligible because SmartTube plays them (user decision 2026-10-03); the v1 library export for the RN client still excludes them. Device observations go in `08-validation-plan.md`; a decision record is required if this becomes the chosen front end.
