---
id: ADR-REL-0031
title: The evidence exporter reconstructs the expected task policy from the pinned release intent
type: adr
status: proposed
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-GOV-0013
  - ADR-REL-0022
  - docs/dev/operations/harness-convergence-proposals.md
  - packages/cli/vendor/evidence-verification/src/policy-builder.js
  - law/schemas/release-intent.schema.json
affected_rules:
  - packages/cli/vendor/evidence-verification/src/policy-builder.js
  - packages/cli/vendor/evidence-verification/src/export.js
  - packages/cli/vendor/evidence-verification/src/export-cli.js
  - packages/cli/vendor/evidence-verification/test/policy-builder.test.js
  - packages/cli/vendor/evidence-verification/test/export.test.js
  - packages/cli/vendor/evidence-verification/provenance.json
inspector_acceptance:
  - IA-001 -- Export the certify receipt of a release-intent run and confirm it succeeds without a second --rc execution and its task policy digest equals the digest the run pinned.
  - IA-002 -- Alter one field of the pinned intent after the run and confirm the export is refused with its rejection code rather than trusting the receipt's claimed task set.
  - IA-003 -- Present a receipt whose stage differs from the intent's stage and confirm refusal; present one built against a stale policy digest and confirm refusal.
  - IA-004 -- Present a receipt whose base or candidate differs from the intent's and confirm refusal, and present one whose node population is a strict subset and confirm refusal for an incomplete population.
  - IA-005 -- Pass a file path where a profile id is expected and confirm the code distinguishes it from an unknown id, while a profile-driven receipt still exports through its unchanged path.
---

# Export reconstructs intent policy

## Status

Proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Binds nothing until the Architect sets it to accepted
before the round that implements it opens. Adds a release-intent path to the
vendored evidence exporter beside the unchanged profile path and re-vendors
the verifier with a new provenance.

## Context

`devai-evidence-export` derives the expected task policy through
`buildExpectedTaskPolicy` in
`packages/cli/vendor/evidence-verification/src/policy-builder.js`, which
resolves a profile id against the task descriptor and throws
`PROFILE_UNKNOWN` for anything else. A certify receipt produced by a release
run is built from a release intent, not from a descriptor profile: the intent
pins the policy, descriptor, toolchain, environment, base, candidate, and
stage, and the task set follows from them. The exporter has no path that
accepts such a receipt, so the adopter report against 1.4.5 that a release
certify receipt is rejected on export is unchanged in 1.6.0, and the only
workaround is a second `--rc` execution that reproduces the policy under a
profile (#69). The same error code is thrown when a caller passes a path
where an id was expected, which hides a usage mistake behind a policy
diagnostic. The vendored verifier is copied from the canonical verifier
source that `provenance.json` pins by `sourceCommit`, and every vendored file
carries its SHA-256, so a change to the copy alone would be a provenance
violation.

## Decision

`devai-evidence-export` accepts a receipt whose provenance records a release
intent. For such a receipt the exporter reconstructs the expected task policy
independently from the pinned intent, policy, descriptor, toolchain,
environment, base, candidate, and stage, computes its digest, and compares
the reconstruction to the receipt; it never trusts the task set the receipt
claims. A receipt whose provenance records a profile keeps its current path
through `buildExpectedTaskPolicy` unchanged, so no existing export changes
its result.

Rejection is exact and coded. An intent whose bytes differ from the pinned
intent digest, a receipt whose stage differs from the intent's stage, a
policy whose digest is not the one the intent pinned, a base or candidate
that differs from the intent's, and a node population that is not the
complete population the reconstruction selects are each refused with their
own code, and the exporter emits no bundle on refusal. `PROFILE_UNKNOWN` is
reserved for an id that the descriptor does not declare; a value that is a
path where an id was expected is refused with a distinct code so a usage
error is never reported as a policy error.

The change lands first in the canonical verifier source and is then vendored
into `packages/cli/vendor/evidence-verification` with a new immutable
provenance: `provenance.json` records the new `sourceCommit` and the SHA-256
of every vendored file, and the vendored tests are copied with the source.
The verifier's own `verify.js` path and the evidence chain verification in
`packages/evidence` are outside this record.

## Consequences

A release run's certify receipt exports without a second execution, so the
signed portable closure of a release is built from the run that produced it.
The exporter gains a second reconstruction path whose inputs are all pinned,
which makes an export deterministic for a given intent and refuses any drift
between the intent and the receipt. The vendored provenance changes once,
which the doctor's vendored-copy check must observe as a new pin rather than
as drift. Every rejection is testable by fixture, and the fixtures live in
the vendored test directory beside the source they exercise.

## Alternatives Considered

Trusting the task set the receipt claims when an intent is present is
rejected because the exporter would then certify whatever the producer
wrote. Converting the intent into a synthetic profile before export is
rejected because the profile grammar has no place for base, candidate, or
stage and the conversion would hide the pins the rejection tests need.
Patching the vendored copy directly is rejected because the provenance file
binds every vendored byte to the canonical source commit.

## Affected Rules

- `packages/cli/vendor/evidence-verification/src/policy-builder.js` for the
  intent reconstruction and the split of `PROFILE_UNKNOWN`.
- `packages/cli/vendor/evidence-verification/src/export.js` and
  `packages/cli/vendor/evidence-verification/src/export-cli.js` for the
  intent path and its option.
- `packages/cli/vendor/evidence-verification/test/policy-builder.test.js` and
  `packages/cli/vendor/evidence-verification/test/export.test.js` for the
  rejection fixtures.
- `packages/cli/vendor/evidence-verification/provenance.json` for the new
  source commit and digests.

## Inspector Adversarial Acceptance

Export the certify receipt of a release-intent run and confirm success
without a second `--rc` execution and a policy digest equal to the pinned
one. Alter one intent field and confirm refusal by code. Change the stage,
then the policy digest, and confirm each refusal. Change the base, then the
candidate, then drop one node from the population, and confirm each refusal.
Pass a path where an id is expected and confirm a code distinct from
`PROFILE_UNKNOWN`, then export a profile-driven receipt and confirm its path
is unchanged.
