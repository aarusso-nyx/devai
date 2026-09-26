---
id: ADR-REL-0028
title: Declare a prerelease channel ladder with per-rung verification capabilities
type: adr
status: proposed
date: 2026-09-26
authority: Architect
supersedes: []
provenance:
  - law/policy/release-lifecycle.json
  - law/policy/release-verification.json
  - scripts/release-channel.mjs
  - docs/dev/operations/versioning-policy.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-intent.schema.json
  - scripts/release-channel.mjs
inspector_acceptance:
  - IA-001 -- A prerelease identifier outside the declared ladder is blocked with invalid-semver precedence, never defaulted to a rung.
  - IA-002 -- A promotion that skips a rung or moves backward along the ladder is blocked as a downgrade.
  - IA-003 -- A stable version cannot be published to a prerelease dist-tag and an alpha cannot be published to latest.
---

# Prerelease channel ladder

## Status

Proposed. Extends the release lifecycle policy; the kernel identifier is
unchanged because the change adds a rung table without altering existing
transition semantics.

## Context

The lifecycle policy already declares semver 2.0 grammar, a transition order,
and per-transition verification capabilities, so verification depth per
version level exists. Prerelease is one undifferentiated transition, and the
channel script knows only two dist-tags, `next` and `latest`. The history has
one release-candidate tag. Nothing states which prerelease identifiers are
valid, in what order they may be promoted, or what depth each requires.

## Decision

Law declares a prerelease ladder of `alpha`, `beta`, and `rc`, in that
order, each with a numeric suffix in the semver 2.0 dot form, for example
`1.6.0-alpha.1`. Each rung declares its dist-tag and its required
capabilities. Alpha requires the unconditional floor and affected checks.
Beta adds the full unit and integration closure. The `rc` rung requires the
complete RC coverage closure and is the only rung from which a stable version
may be promoted. Promotion moves forward along the ladder or increments the
suffix within a rung; any other movement is a downgrade. Stable versions
publish to `latest` only; rungs publish to their own dist-tag only.

## Consequences

The release intent gains an optional channel field derived from the version
string; the kernel blocks when the field and the version disagree. The
channel script emits the rung's dist-tag. Adopters inherit the ladder through
the materialized policy and may narrow which rungs they use, never widen the
identifier set.

## Alternatives Considered

Keeping one prerelease transition is rejected because an alpha and a release
candidate carry different claims and should carry different depth. Free-form
prerelease identifiers are rejected because the kernel cannot order them.
Letting adopters define their own rung names is rejected because dist-tags
and promotion order must be portable across the trusted verifier.

## Affected Rules

The lifecycle policy and its schema gain the rung table, the release intent
schema gains the derived channel field, and the channel script maps rungs to
dist-tags.

## Inspector Adversarial Acceptance

Submit `1.6.0-nightly.1` and confirm an invalid-semver block. Submit a beta
after an rc for the same version and confirm a downgrade block. Attempt to
resolve an alpha to the `latest` tag and confirm refusal. Confirm existing
stable transitions and the existing `v1.5.0-rc.1` lineage resolve exactly
as before.
