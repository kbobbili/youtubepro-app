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

## Implementation (2026-10-03)
- **Eligibility:** men's ODI and T20I involving India (must), Australia, England, South Africa, New Zealand, Pakistan, Sri Lanka or West Indies (ESPN team IDs 6, 2, 1, 3, 5, 7, 8, 4). ICC events are followed (`includeIcc`), identified by series name. **Test cricket is deferred** (the one-primary-highlight-per-event model cannot represent daily parts of an ongoing Test).
- **Events:** ESPN `cricket/scorepanel?dates=YYYYMMDD` per day; matches are grouped by series (`leagues[0]` id/name); `class.internationalClassId` 2 = men's ODI, 3 = men's T20I (women's, youth and domestic classes are ignored). Completed = `state: post` with a result; "No result"/abandoned = cancelled. Result text is never parsed.
- **Willow identity resolved:** willow.tv links `@willow` → `UC2V_LHwvaNS2XWZ5l8x3jLQ` ("Willow by Cricbuzz"); the `@WillowTVCricket` handle does not exist.
- **Sources per series, not per format:** Willow is trusted only for series where it was observed publishing highlights (`series:<id>` in `config/sources.yaml`): West Indies tour of India (24289), Australia tour of South Africa (24203), Sri Lanka tour of England (23802), Afghanistan tour of India (24677). Any other series is reported `no_trusted_source:series:<id>` (highlight unavailable) — e.g. Australia tour of Zimbabwe, Namibia v South Africa, Japan v India, the Asian Games. **Maintenance:** add a series ID when Willow is seen covering it. ICC is verified but disabled until a men's ICC event is in scope; ICC titles often carry results.
- **Matching:** `Highlights: <n>th <ODI|T20I>[,|-] <A> vs <B> [| …]`; format and match number must equal the event's; both nations must be exact (India ≠ India Women ≠ India A), either order — Willow lists India's home series as "Afghanistan vs India", so order earns no confidence bonus. Published after the start and within 72h of estimated end (ODI 8h, T20I 3.5h); ≥2 min. Test day highlights ("Day 4 Highlights: 3rd Test …") and franchise leagues don't parse.
- **Spoilers:** Willow titles observed are neutral; cricket terms (by N runs/wickets, century, seal series, chase, collapse, "run … close") flag result-style titles.
- **Backfill (Sep 10–Oct 3, 2026):** 25 followed matches; 10/10 covered matches found and audited correct (~5–6 min packages); 10 unavailable (series without a trusted source); 4 unavailable because Willow never uploaded them (England v Sri Lanka 2nd T20I, 1st and 3rd ODI; South Africa v Australia 3rd ODI); 1 still searching. 4 YouTube units plus ~26 ESPN calls.
