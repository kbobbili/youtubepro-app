# SportsCenter — Official Source Registry

## Policy
SportsCenter displays highlights only from explicitly trusted official or authorized publishers, identified by immutable platform IDs (e.g. YouTube channel ID), not display names.

## Tiers
### Tier 1 — League / governing body / event owner
Preferred whenever suitable highlights exist. Candidates to verify/register: NFL, MLB, NBA, Formula 1, ICC for ICC events, WWE if included.

### Tier 2 — Official tour / tournament / competition
Candidates: Tennis TV / official ATP coverage, Australian Open, Roland-Garros, Wimbledon, US Open Tennis Championships, FIFA/UEFA where suitable.

### Tier 3 — Authorized broadcaster / rights holder
Use where event owner does not provide suitable regional highlights. Examples to validate: NBC Sports for relevant US soccer coverage, Willow for relevant cricket, host-board/broadcaster channels for bilateral cricket.

### Untrusted
Never display unknown reupload/fan/piracy channels, lookalike branding, or unclear-rights compilations.

## Registry concept
```yaml
- id: nfl-youtube
  sport: nfl
  tier: 1
  platform: youtube
  channelId: <verified-id>
  regions: [US]
  competitions: [NFL]
  includePatterns: [highlights]
  excludePatterns: [shorts, interview, press conference]
```

## Resolver patterns
- NFL/MLB/NBA/F1: usually league/event → official channel.
- Tennis: regular tour vs each Grand Slam requires different mappings; WTA needs validated mapping.
- Soccer: competition + region may resolve to an authorized broadcaster.
- Cricket: most complex; ICC events → ICC first; bilateral series → host board and/or authorized broadcaster, region-dependent.

## Operational rules
- Verify channel IDs manually before adding.
- Record region/competition scope and last verification date.
- Prefer recent uploads lookup before constrained search.
- Periodically audit rights/source mappings.
- A missing trusted source is a normal state, not permission to broaden to arbitrary channels.
