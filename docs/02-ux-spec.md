# SportsCenter — TV UX Specification

## Thesis
SportsCenter should feel closer to XITE than YouTube, ESPN, Kodi, or TiviMate. It answers **what is worth watching** instead of presenting a database.

## Primary flow
`Launch → Home → Catch Me Up → duration (optional) → continuous playback → Back → previous focus restored`

## Home hierarchy
1. Catch Me Up hero: unwatched count + runtime.
2. New For You.
3. Continue Watching.
4. Earlier This Week.
5. Your Sports.

New For You / Earlier This Week age boundaries are defined in `01-prd.md` (Content windows).

```text
GOOD EVENING
18 new highlights this week

[ ▶ CATCH ME UP · ~45 MIN ]

NEW FOR YOU
[ IND v AUS ] [ Liverpool v Chelsea ] [ Alcaraz v ... ]

CONTINUE WATCHING
[ F1 █████░ ] [ Cricket ███░░ ]

EARLIER THIS WEEK
[ ... ] [ ... ]

YOUR SPORTS
🏏 Cricket  ⚽ Soccer  🎾 Tennis  🏀 NBA  🏈 NFL  ⚾ MLB  🏎 F1
```

## Catch Me Up
- Quick (~20m), Standard (~45m), Everything.
- Preview without scores.
- Start immediately; detailed queue editing is secondary.
- Balance sports/priorities, not simple chronological dumping.

## Sport view
- Sport-specific Catch Up / Just Play.
- New, Earlier This Week, Continue Watching.
- Optional competition/team filters.
- Provider/source complexity stays secondary.

## Cards
Show neutral event title, competition, relative date, duration, trusted source, subtle Official/Authorized marker, progress. Avoid scores, winner-revealing copy, comments/views/likes, and generic YouTube metadata.

## Player
Full-screen first. Minimal previous/play-pause/next/progress. Automatic queue advance. Up Next available but not dominant. Back restores originating focus. Persist progress. Playback failures must be explicit.

## D-pad
- Strong focus state.
- Predictable spatial movement.
- Shelves retain position after returning.
- Back should not unexpectedly exit.
- No touch/mouse assumptions.
- Key content should start within ~2–3 remote actions.

## Settings / My Sports
Sport-specific configuration: cricket nations/priorities; tennis ATP/WTA + rank threshold; soccer/NBA/NFL/MLB teams; F1 event types; spoiler toggle.

## Missing state
`India vs West Indies — Official highlight not available yet.` Never fill gaps with arbitrary search results.

## Visual direction
Dark, cinematic, high contrast, spacious, image-led, large type, minimal chrome. Inspired by XITE's lean-back simplicity without cloning proprietary UI/assets.
