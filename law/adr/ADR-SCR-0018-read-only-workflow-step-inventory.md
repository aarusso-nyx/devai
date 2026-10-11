---
id: ADR-SCR-0018
title: Installed read-only workflow step review inventory
type: adr
status: accepted
date: 2026-10-11
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0017
  - ADR-SCR-0003
affected_rules:
  - law/policy/round-execution.json
  - law/schemas/round-execution.schema.json
  - law/schemas/workflow-step-inventory.schema.json
  - law/policy/adopter-migrations.json
  - packages/sensors/src/harness/workflow-parser.ts
  - packages/cli/src/commands/sense/inventory.ts
  - docs/reference/cli/render-generated-reference.mjs
inspector_acceptance:
  - IA-001 -- The installed public bin extracts the workflows slice without executing workflow commands or writing repository, policy, reading or proof bytes; unsupported syntax remains visible.
  - IA-002 -- Preserve every physical zero-based step occurrence, including equal-digest duplicates, with separate whole-file and canonical-step SHA-256 identities and complete path-sorted file digests.
  - IA-003 -- Missing workflows, invalid YAML, stale or invalid bound reviews, unsupported selection and incomplete import closure cannot become complete; path escapes and links never earn closure credit.
  - IA-004 -- Reuse the actual adopter execution-selection and closure rules; computed reachability covers require the current verified binding and exact occurrence bijection, with no caller-injected review or package-owned effect override.
  - IA-005 -- Keep every old slice and the all population unchanged, retain the existing public read action and show the new opt-in slice in canonical help and generated reference.
---

# Installed read-only workflow review inventory

## Status

Accepted within the Owner-authorized DEVAI 2.6.0 additive MINOR campaign.
This decision defines the contract; implementation and independent installed
acceptance remain separate release prerequisites.

## Context

Published DEVAI 2.5.0 requires exact canonical workflow step digests, occurrence
bijections and complete executable/import closure for reviewed adopter effects.
Its installed CLI does not expose those extraction facts. Reimplementing the
internal extractor in each adopter risks differing digests and incomplete file
populations.

## Decision

DEVAI 2.6.0 adds the explicit `workflows` slice to the existing stable
`sense inventory` action. Its sole member is `workflow-step-inventory`.
The action remains read-only, with no new dispatcher, public action, execution,
persistence, configuration mutation or effect grant. Every existing slice,
including the ordered member population of `all`, remains unchanged.

The slice reads the contained regular `.github/workflows/*.yml` and `*.yaml`
population in deterministic path order. It preserves each job's physical YAML
step order and emits one row per zero-based occurrence. It never deduplicates by
step digest. Source and census rechecks must detect changes during extraction;
links, escapes and unreadable inputs cannot earn complete closure.

The typed member value conforms to
`law/schemas/workflow-step-inventory.schema.json`. It contains `schemaVersion`,
`status`, `reason` and `workflows`. Each workflow contains its portable `path`,
raw-byte `sha256`, `status`, `reason` and `steps`. A step contains `job`, `index`,
`occurrence`, `name`, canonical `sha256` and `closure`. The occurrence is exactly
`<repository-relative workflow path>#<job>[<zero-based index>]`; its fields must
agree with the enclosing workflow. Job/step enumeration is deterministic.

The whole workflow digest hashes raw YAML bytes. A step digest uses the existing
`workflowStepDigest` algorithm: recursively sort mapping keys, preserve sequence
order and parsed scalar values, serialize the resulting step object with
`JSON.stringify`, then hash its UTF-8 bytes. Whitespace and mapping order do not
substitute for this canonical identity. These are separate identities.

A complete closure contains unique path-sorted `{path, sha256}` rows for every
contained regular executable/import/config file required by the actual adopter
closure checker. Each file digest hashes its raw bytes. The extractor shares
execution-selection semantics with reviewed adopter validation, including
working-directory, shell, inherited defaults, environment, action and command
limitations. It must not substitute the weaker legacy package-step file walker.
Package-owned effect dispositions cannot override an unprovable adopter closure.

Computed import covers may come only from the current verified registered
reviewed-workflow projection, with exact occurrence bijection and pinned files.
There is no new CLI argument for authored covers, effect classifications or
review injection. Missing or invalid binding leaves affected reachability
unknown; it never grants a fallback. Complete extraction does not author the
review rationale, select an effect or validate execution permissions.

`complete` requires every selected workflow and step identity and closure to be
complete. Its reason is null. An unknown closure has `files: null` and a nonempty
reason; partial files are never represented as a complete population. Unknown
workflow/YAML reads retain a workflow row, with available identity and a reason,
even when steps cannot be extracted. Unavailable digests are null. Any nested
unknown makes the top status `unknown` and reason
`WORKFLOW_INVENTORY_INCOMPLETE`. An absent or empty workflow population is
`unknown` with `WORKFLOW_INVENTORY_EMPTY`, never vacuous completion. Structural
path/binding violations may refuse with the existing structured error boundary.

The existing inventory envelope maps an unknown member to REVIEW and exit 1;
complete maps to PASS and exit 0. Invalid invocation or hard refusal remains exit 2. No output establishes readiness, execution origin, custody or reviewed effect.

Full-path occurrences already match the adopter reviewed-workflow input grammar.
The package-owned reviewed registry's basename occurrence notation is a separate
internal contract. No automatic conversion, aliases or omitted path prefixes are
admitted. Grouping equal step digests for an authored review requires the exact
complete occurrence roster after independent review.

## Compatibility and migration

This is an additive MINOR interface. Installation exposes the opt-in slice;
using it requires no new binding or policy-writing operation. Existing reviewed
effects, thresholds, permissions, native versions and readiness gates remain in
force. The migration manifest records this optional capability.

No native compatibility is added here. STYNX's declared `@swc/core ^1.15.41`
range does not establish its installed version: the inspected lock/install uses
1.16.2 with unplugin-swc 1.5.9, Vitest 4.1.11, Vite 7.3.6 and esbuild 0.28.1.
Its actual Vite-resolved Rollup 4.60.4 differs from admitted 4.64.5, and its
privacy config still uses `__dirname`. Those facts require explicit migration
and installed verification; matching SWC alone proves no standing. An actual
SWC 1.15.41 installation remains outside the finite admitted matrix.

## Consequences

An installed adopter can obtain the exact review inputs through the public
read route. Incomplete reachability remains visible and cannot become an effect
approval. Keeping `all` unchanged avoids adding workflow prerequisites to existing
callers.

## Alternatives Considered

A new action or private source import would fragment the stable interface.
Raw YAML hashing cannot replace canonical step identity. Digest-only deduplication,
legacy weak file walking and invented read-only effects would lose the exact
population or overstate authority.

## Affected Rules

The listed round-execution vocabulary and schemas define the opt-in payload.
The actual adopter selector/closure implementation supplies its facts, while
canonical documentation describes their limits. Existing action/effect policy,
reviewed-workflow input ownership and native contracts remain unchanged.

## Inspector Adversarial Acceptance

Discharge IA-001 through IA-005 using the real installed package and public
bin. Include repeated equal-digest steps, map-order/whitespace canonicalization,
raw-byte changes, literal/transitive/computed imports, package scripts/config,
invalid bound covers, missing/empty workflow directories, malformed YAML,
selection inheritance, links/escapes/unreadable files and mid-read changes.
Prove byte inventories unchanged and sentinel commands never run. Preserve all
existing slice/all expectations.
