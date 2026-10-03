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

## Live registry
`config/sources.yaml` is the live registry; this document defines its policy. Only entries with `enabled: true` **and** `verification.status: verified` are trusted, scoped by sport, competition, and region. Title include/exclude patterns live in each sport's matcher, not the registry.

## Verification standard
A source is `verified` only with:
- authoritative ownership evidence: an official publisher website linking to the channel (or equivalent),
- the stable channel ID that link resolves to,
- the evidence URL, verification method, and date,
- competition and region scope.

Agreement between a handle, channel ID, and RSS title proves identity consistency only, not authorization. Such entries stay `candidate` and disabled. Each matched video's `channelId` is re-checked against the registry at discovery time.

| Source | Status (2026-10-02) | Evidence |
| --- | --- | --- |
| NFL `UCDVYQ4Zhbm3S2dlz7P1GBDg` | verified, enabled | nfl.com footer links `youtube.com/user/NFL/`; `channels.list(forUsername=NFL)` resolves to this ID |
| NBA, MLB, F1, ICC, Tennis TV, 4 Grand Slams, NBC Sports, FIFA, UEFA | candidate, disabled | desk research (handle → ID → RSS title); ownership evidence not yet recorded |
| Willow | candidate, disabled | ambiguous: two handles resolve to different IDs |

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
