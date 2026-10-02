# SportsCenter

SportsCenter is a personalized, spoiler-free sports-highlight experience for Google TV.

## Read first
- `docs/00-product-vision.md`
- `docs/01-prd.md`
- `docs/02-ux-spec.md`
- `docs/03-content-discovery.md`
- `docs/04-source-registry.md`
- `docs/05-architecture.md`
- `docs/07-decisions.md`

As relevant: `docs/06-data-model.md`, `docs/08-validation-plan.md`, `docs/09-roadmap.md`.

Use `docs/10-sport-integrations/` when working on a sport.

## Critical guardrails
- TV-first and D-pad-first.
- React Native TV.
- Official/authorized highlight sources only.
- Never surface arbitrary/untrusted YouTube search results.
- Sports data determines events; YouTube provides highlights.
- Spoiler-free by default.
- Rolling 7-day Home/Catch-Up experience.
- Prefer “highlight unavailable” over questionable content.
- Keep the TV client thin.
- Do not turn SportsCenter into a general media center.
- Shows/Movies/Live TV are out of V1 unless an explicit product decision changes this.
- Treat exact retry timings, vendor choices, and rights mappings as hypotheses/configuration until validated.

## Keep documentation aligned
Update the relevant specification when product or architecture decisions change; record durable decisions in `docs/07-decisions.md`. Keep unresolved proposals in its open-decisions section until resolved, preserve existing work from other agents, and keep this file concise.
