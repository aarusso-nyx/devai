# DEVAI 1.4.0 implementation session

## Entry and authority

The Architect revalidated repository `aarusso-nyx/devai`, base commit
`d8629c86f83b5741ffd56dc4dc1ec5648c13b7e4`, tree
`98c1f76155ddf0e18f0ea64a2fc84b3bcb88154b`, and the dedicated
`codex/devai-1.4.0-release-profiles-local` worktree. The human Owner authorized
implementation and the separately protected remote effects required to reach
publication. No authority was inferred from DEVAI itself.

## Role transitions

1. **Architect:** recorded ADR-014, froze additive schema and implementation
   paths, preserved the public action set and legacy task targets, and rejected
   ordered profiles and a second cache.
2. **Inspector:** specified SemVer, support promotion, capability union, risk,
   explicit skip, exact preflight, mutation invalidation, materialization,
   compatibility, and workflow boundaries.
3. **Engineer:** implemented the pure resolver, runner integration, schemas,
   materializer, self-profile, hook, and CI selection.
4. **Inspector:** ran focused, full, workflow, package, documentation, and
   clean-room verification; findings were corrected without weakening tests.
5. **Architect:** reconciled version, migration, adopter, release, and generated
   contracts.
6. **Auditor:** binds the final verdict to the final commit/tree and exact gate
   results; incomplete or superseded evidence is not a pass.

## Frozen architecture and path set

The release decision is the union of two axes plus changed-path task impact,
risk mappings, and Owner escalation. A cheap exact receipt is mandatory before
certification. Existing task keys, cache records, candidate receipts, selectors,
toolchain identities, and sanitization remain authoritative. Release profiles
are opt-in adopter configuration materialized through existing policy binding.
DEVAI consumes the same resolver through `law/policy/release-verification.json`;
this changes verification economy, not constitutional human authority.

The intended changes are limited to ADR/policy/schema, check-runner and adopter
services, their tests, task descriptors, root hygiene scripts/hooks, the two
existing workflows, and version/adopter/release documentation. No new stable
action, credential surface, workflow permission, protected-resource writer, or
publication bypass is introduced.

## Rejected alternatives

- One ordered profile loses the difference between MAJOR targeted mutation and
  LTS full-roster assurance.
- A second cache or evidence store would create conflicting truth and weaker
  reuse identity.
- Automatic risk inference inside generic DEVAI would invent adopter semantics;
  profiles declare mappings and DEVAI fails closed on unknowns.
- Treating hooks as release evidence would not bind an exact candidate and is
  rejected; CI and receipts rerun lint independently.
