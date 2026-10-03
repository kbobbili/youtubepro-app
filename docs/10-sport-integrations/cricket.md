# Cricket Integration
## Eligibility
Configurable prominent Test-playing nations; ICC events; per-nation priority.
## Source resolution
ICC event → ICC first. Bilateral series → determine host/competition/region, then host board and/or authorized broadcaster (e.g. candidates such as Willow or official board channels must be verified for the specific rights context).
## Risk
Highest source complexity. Google may curate some major events but absence of a Google video carousel does not imply no official YouTube highlight exists.
## Research notes (2026-10-02, unvalidated)
- ESPN's generic cricket scoreboard path returned 404; league-specific and `scorepanel` endpoints returned data but their coverage of bilateral series and host context is unverified.
- CricketData.org advertises a free tier (100 requests/day); unvalidated.
- Willow channel identity is ambiguous: `@willow` → `UC2V_LHwvaNS2XWZ5l8x3jLQ` ("Willow by Cricbuzz") vs `@WillowTVCricket` → `UCg_FrRwaLBTjxPuUFas4j9w`. Confirm from willow.tv before registering.

## Validation
Separate ICC tournament coverage from bilateral-series coverage. Record series host, rights context, source checked, publish latency, and missing events.
