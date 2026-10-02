# Sport Integration Notes

Each sport gets its own adapter/spec because eligibility, event data, rights, source mapping, naming, and publication latency differ.

Each file should evolve to contain:
- Event/ranking data source(s)
- Eligibility rule
- Trusted source registry entries (immutable IDs)
- Region/rights notes
- Candidate matching patterns
- Retry/publication behavior
- Test fixtures
- Known failures

Never assume an example publisher covers every event/region; validate before registering.
