You are joining a new personal software project called **SportsCenter**.

SportsCenter is a private, personal-use Google TV application. I will sideload it onto my own Google TV/Onn device. It is not currently intended for public distribution.

The repository is intentionally almost empty. I have already created the project documentation under `docs/`, along with [`CLAUDE.md`](CLAUDE.md) and [`README.md`](README.md).

## First task: understand the project

Before writing application code, thoroughly read:

- [`CLAUDE.md`](CLAUDE.md)
- [`README.md`](README.md)
- every relevant Markdown document under `docs/`
- all sport-specific documents under `docs/10-sport-integrations/`

Treat these documents as the current source of truth for the product vision, requirements, UX, architecture, content-discovery model, source policy, decisions, validation strategy, and roadmap.

The project was previously referred to as **Pulse** / **PulseTV** during brainstorming. The final application name is now **SportsCenter**.

As you review the documentation, update terminology from Pulse/PulseTV to SportsCenter where appropriate. Do not change the underlying product decisions merely because the name changed.

---

# Product in one sentence

SportsCenter is my **personalized, spoiler-free sports-highlight DVR for Google TV**.

It should determine which sporting events I care about, locate high-quality highlights from trusted official or authorized YouTube publishers, retain those highlights in a rolling library, and provide an effortless lean-back TV experience where I can simply press **Catch Me Up** and watch.

The experience is inspired by what I like about XITE on Google TV:

- launch the app
- immediately see useful content
- minimal browsing
- excellent D-pad navigation
- visually polished TV interface
- press something and start watching
- continuous playback
- very little decision fatigue

SportsCenter is NOT intended to become a generic media center.

I already use **TiviMate** for:

- live TV
- movies
- TV shows

Do not expand SportsCenter into those areas unless I explicitly change that decision later.

---

# Core product model

Keep these three questions separate:

## 1. What happened?

Sports/event data tells us which games, matches, races, tournaments, etc. occurred.

YouTube is NOT our source of truth for determining what sporting events happened.

## 2. Do I care?

Apply my sport-specific personalization rules.

Examples:

### Cricket

I may want highlights involving prominent Test-playing cricket nations, with configurable preferences and potentially higher priority for specific countries such as India.

ICC tournaments may have their own rules.

### Tennis

A match should generally qualify when at least one player is within a configured ATP/WTA ranking threshold, initially Top 30.

The ranking should come from current ranking data rather than a hard-coded list.

Grand Slams may require different official sources from regular ATP/WTA events.

### Soccer

Only matches involving teams or national teams I explicitly follow.

### NBA

Only selected teams.

### NFL

Only selected teams.

### MLB

Only selected teams.

### Formula 1

Generally follow selected/all F1 race weekends, with appropriate handling of qualifying/race highlights.

These rules must remain configurable rather than being deeply hard-coded into UI components.

## 3. Where is the trusted highlight?

Once SportsCenter knows an eligible event occurred, find the corresponding highlight from an approved official or authorized publisher.

This ordering is fundamental:

Sports data  
→ event  
→ preference filtering  
→ eligible event  
→ trusted-source resolution  
→ highlight discovery  
→ validation  
→ SportsCenter library

Do NOT invert this into:

YouTube search  
→ random sports videos  
→ attempt to decide what is interesting

---

# Trusted-source principle

This is one of the strongest requirements in the project.

SportsCenter should prefer:

1. official league/governing-body channels
2. official competition/tournament channels
3. official streaming/service channels
4. known authorized broadcasters

Examples we have discussed include sources such as:

- NFL
- MLB
- NBA
- Formula 1
- ICC
- WWE, if that sport/content is later enabled
- Tennis TV
- Wimbledon
- Australian Open
- Roland-Garros
- US Open Tennis
- FIFA
- UEFA
- NBC Sports
- Willow
- cricket boards / authorized cricket broadcasters

Do NOT assume that every example above owns rights to every event or every region.

Source resolution can vary by:

- sport
- competition
- tournament
- host country
- broadcaster
- viewer region
- season

Cricket in particular is expected to require more sophisticated source resolution than NFL/MLB/NBA/F1.

Use stable YouTube channel IDs rather than trusting display names.

An arbitrary YouTube channel calling itself something official-looking must never become trusted merely because its name matches.

**SportsCenter would rather display "Official highlight unavailable" than surface a pirated, questionable, misleading, or untrusted video.**

Unrestricted YouTube search results must never be directly exposed to the TV UI.

---

# YouTube's role

YouTube is primarily the last-mile highlight provider.

For known trusted channels, prefer inspecting recent channel uploads.

If necessary, perform YouTube searches constrained to approved channel IDs and appropriate publication windows.

The discovery engine should be capable of matching an eligible sporting event to an official highlight based on information such as:

- teams
- players
- competition
- event date
- title
- upload date
- source/channel
- video duration
- highlight-related terminology
- embeddability/playability
- confidence

The system should support retrying discovery because official highlights may appear hours after an event ends.

Exact retry intervals are not yet sacred requirements. Treat values in the documentation as starting hypotheses unless explicitly marked as decisions.

---

# Rolling sports DVR concept

SportsCenter should behave more like a sports-highlight DVR than a news feed.

The normal Home experience should use approximately a **rolling seven-day window**.

Highlights should not disappear simply because midnight passed.

If I haven't watched Tuesday's highlight by Thursday, it should still be available.

Potential organization:

- New For You
- Continue Watching
- Earlier This Week
- Your Sports
- Catch Me Up

Watch/history metadata may eventually be retained substantially longer than seven days, perhaps around 90 days, but seven days is the primary Home/catch-up window.

Again, distinguish between:

- confirmed product decisions
- configurable defaults
- implementation hypotheses

---

# Spoiler policy

The default experience should be **spoiler-free**.

Sports data may internally know:

- final score
- winner
- tournament advancement
- match result

but the TV interface should generally show something like:

`Liverpool vs Arsenal`

rather than:

`Liverpool 3–2 Arsenal`

Avoid titles or metadata that unnecessarily reveal results before playback.

Think carefully about video titles and thumbnails because official YouTube metadata itself may contain spoilers.

Do not casually introduce score/result information into Home cards.

---

# Catch Me Up

This is one of the defining experiences.

The user should be able to launch SportsCenter and quickly start a personalized queue of unwatched highlights.

Potential modes include:

- Quick — roughly 20 minutes
- Standard — roughly 45 minutes
- Everything — all relevant unwatched highlights

These exact durations are defaults, not immutable architecture.

Queue construction should eventually consider:

- freshness
- personal priority
- sport
- team/player importance
- watched/unwatched state
- duration
- diversity
- duplicate events
- available viewing time

The goal is:

Open SportsCenter  
→ press Catch Me Up  
→ start watching  
→ highlights continue automatically

without browsing YouTube.

---

# Google TV UX

This is a TV application, not a mobile app enlarged for television.

The UI must be designed around:

- D-pad navigation
- focus states
- predictable directional navigation
- OK/select
- Back behavior
- large-screen readability
- couch viewing distance
- minimal text entry
- minimal interaction
- continuous playback
- preservation of focus when returning from playback

The UX quality is a major reason for building our own app instead of using TiviMate, Jellyfin, Kodi, or a generic media-center interface.

React Native TV is the chosen client technology.

Do not replace it with a WebView or another framework without discussing the decision with me.

---

# Keep the TV client thin

Do NOT turn the React Native application into the entire SportsCenter intelligence engine.

Conceptually we want:

Sports data adapters  
→ SportsCenter discovery/domain engine  
→ persistence/API  
→ React Native TV client  
→ YouTube playback

The TV application should primarily be responsible for:

- presentation
- navigation
- user interaction
- playback orchestration
- queue UI
- local/session state where appropriate

The domain/backend layer should own things such as:

- event ingestion
- rankings
- preference evaluation
- source resolution
- highlight discovery
- candidate matching
- confidence
- retry lifecycle
- rolling library
- queue generation
- persistent watch state where appropriate

However, do not prematurely create cloud infrastructure simply because this conceptual separation exists.

This is a personal application.

Favor the simplest architecture that preserves clean boundaries.

---

# Current project stage

We have NOT yet proven reliable highlight discovery across all desired sports.

That is the biggest product risk.

Before spending substantial effort polishing the entire TV application, we need to validate:

event  
→ preference match  
→ trusted source  
→ correct highlight  
→ playable highlight

over real sporting events.

The documentation describes a multi-day validation strategy.

Treat content-discovery reliability as a first-class success metric.

We should eventually measure things such as:

- eligible events
- trusted highlights found
- playable highlights
- missing highlights
- incorrect matches
- duplicate matches
- time from event completion to highlight availability
- coverage percentage by sport/source

---

# Engineering philosophy

This is a personal project.

Optimize for:

- simplicity
- maintainability
- excellent UX
- deterministic behavior
- easy debugging
- easy experimentation

Do NOT prematurely introduce:

- microservices
- Kubernetes
- elaborate cloud architecture
- Kafka/event buses
- unnecessary distributed systems
- enterprise authentication
- multi-tenant architecture
- monetization infrastructure
- social features

unless a demonstrated requirement later justifies them.

I am an experienced software engineer, so you can discuss architectural tradeoffs with me directly rather than hiding complexity.

I also want to use this project iteratively.

Prefer vertical slices over building every subsystem upfront.

---

# Desired implementation progression

The documentation contains the authoritative roadmap, but conceptually think in this direction:

1. Understand and reconcile documentation.
2. Validate content-discovery assumptions.
3. Establish a clean project architecture.
4. Get the React Native TV shell running.
5. Perfect basic D-pad navigation.
6. Render a small number of real highlight cards.
7. Play one real trusted-source highlight.
8. Implement next/queue behavior.
9. Preserve focus and playback/watch state.
10. Implement one sport end-to-end.
11. Validate it with real events.
12. Add sports incrementally.
13. Add Catch Me Up.
14. Add the rolling seven-day experience.
15. Polish only after the core discovery loop proves useful.

Do not attempt to implement every sport simultaneously.

---

# Your immediate assignment

Do NOT immediately generate the whole application.

First:

1. Read all existing project documentation.
2. Build a mental model of the system.
3. Identify contradictions, obsolete Pulse/PulseTV terminology, duplicated requirements, missing decisions, and places where brainstormed assumptions are being presented as facts.
4. Update the documentation terminology to **SportsCenter** where appropriate.
5. Preserve useful historical decisions in the decision log.
6. Do not silently change meaningful product requirements.
7. If two documents conflict, call the conflict out rather than arbitrarily choosing one.
8. Examine the proposed architecture critically.
9. Identify the highest-risk assumptions.
10. Recommend the smallest meaningful first vertical slice.

Then give me a concise project-readout containing:

## Your understanding

Explain SportsCenter back to me in your own words.

## Architecture assessment

Tell me whether the documented architecture is appropriate for a personal Google TV project and where you would simplify or change it.

## Product/technical risks

Rank the major unknowns, especially around:

- sports/event data
- rankings
- official-source mapping
- YouTube discovery
- YouTube playback on Google TV
- spoiler handling
- source rights/region differences
- React Native TV behavior

## Documentation issues

List contradictions, unclear requirements, obsolete terminology, or missing decisions you found.

## Proposed first milestone

Define a very small end-to-end milestone that proves something meaningful.

My preferred definition is roughly:

> Install SportsCenter on Google TV, show several real highlight cards from trusted sources, navigate perfectly using the remote, play a real highlight, automatically advance to another highlight, press Back, and return to the correct card/focus position.

But challenge this if you think content discovery should be validated before even that milestone.

## Proposed repository structure

Recommend a practical monorepo/project structure for the TV client, domain/discovery engine, shared types, scripts, tests, and documentation.

Keep it proportionate to a personal project.

## Questions

Ask only questions that materially block the next implementation decision.

Do not ask me to reconfirm things already clearly decided in the documentation.

---

# Important working rule going forward

Treat the documentation as living architecture/product documentation.

When we make a meaningful product or architecture decision during development:

- update the appropriate document
- update `docs/07-decisions.md` when warranted
- keep [`CLAUDE.md`](CLAUDE.md) concise
- do not allow implementation and documentation to silently diverge

Do not turn [`CLAUDE.md`](CLAUDE.md) into a giant copy of the PRD.

The detailed documents under `docs/` should remain the authoritative sources for their respective concerns.

Start by reading the repository documentation now. Do not implement application code until you have completed the project-readout above.