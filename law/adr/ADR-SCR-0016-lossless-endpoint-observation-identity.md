---
id: ADR-SCR-0016
title: Lossless endpoint observation identity and explicit legacy resolution
type: adr
status: accepted
date: 2026-10-10
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0015
  - law/schemas/api-map.schema.json
  - law/schemas/coverage-matrix.schema.json
affected_rules:
  - law/schemas/api-map.schema.json
  - law/schemas/coverage-matrix.schema.json
  - law/schemas/use-cases.schema.json
  - law/policy/sensor-notes/inventory_api.md
  - law/policy/sensor-notes/inventory_rbac.md
  - packages/sensors/src/inventory-endpoint-identity.ts
  - packages/sensors/src/inventory-api.ts
  - packages/sensors/src/inventory-coverage-inputs.ts
  - packages/sensors/src/inventory-coverage.ts
  - packages/sensors/src/inventory-rbac.ts
  - packages/cli/src/commands/sense/readings-rebuild.ts
inspector_acceptance:
  - IA-001 -- Preserve all distinct method/path/controller/evidence tuples, including same method/path handlers in alternative source compositions, while deduplicating only identical tuples.
  - IA-002 -- API, coverage, RBAC and HTTP-evidence consumers agree on identity; input order, object-key order and portable path separators do not change a qualified identity.
  - IA-003 -- A unique legacy method/path alias resolves once; an ambiguous alias credits no endpoint and reports AMBIGUOUS_ENDPOINT_REFERENCE while preserving every variant as unmapped.
  - IA-004 -- Exact qualified and unique explicit IDs resolve, conflicting IDs refuse, and a qualified reference whose source evidence moved remains unresolved until migrated explicitly.
  - IA-005 -- Successful complete regeneration publishes every planned body atomically; a failing inner producer publishes none and preserves concrete finding codes and messages alongside its aggregate failure.
  - IA-006 -- A protected endpoint with a conditional permission guard remains protected and authorization-unresolved; absent static permission metadata never becomes public or an invented unconditional permission set.
---

# Lossless endpoint observation identity

## Status

Accepted for the Owner-authorized STYNX-supported audit interface campaign.
The complete campaign adds supported adopter interfaces and therefore requires
DEVAI 2.5.0 MINOR. This endpoint repair alone is compatible bug remediation.
Published 2.4.0 artifacts and historical observations remain immutable.

## Context

The API producer preserves distinct source declarations with the same HTTP
method and path. Its prior deduplication tuple is method, path, controller and
evidence. Coverage and RBAC independently collapsed that population to method
and path. This both lost source variants and made a valid coverage body violate
its unique-items contract, aborting atomic inventory regeneration. Removing
variants or allowing duplicate coverage IDs would hide the defect.

## Decision

### One observation identity

All API, coverage, RBAC and HTTP-evidence consumers use the same identity
function. For a source-qualified endpoint, the producer emits `api:v1:` followed
by `encodeURIComponent` of the canonical JSON tuple
`[method,path,controller,evidence]`. Canonicalization uses the repository's
canonical JSON implementation, portable forward-slash paths, canonical object
keys and evidence entries sorted by their canonical representation. It does not
use input order, a truncated hash or a generated timestamp. No tuple member is
discarded. Auth and other measured annotations do not replace source identity.

The controller's file/class/method and source evidence distinguish declarations;
line numbers are not the sole identity. Lines remain in this observation-bound
tuple to preserve the producer's existing equivalence relation. Consequently
these IDs are candidate-bound observation references, not stable public route
identifiers: moving source lines may change an ID. A stale qualified reference
is unresolved and needs explicit regeneration or authored migration. No silent
alias bridges changed source evidence. This record does not invent a stable
composition resolver or claim that alternative source declarations are mounted
simultaneously in one runtime.

Existing explicit IDs remain readable when unique and nonconflicting. The
legacy minimal input shape lacking controller/evidence remains readable through
its method/path identity when that identity is unique. It cannot represent two
distinct variants with one ID. Duplicate or conflicting identities refuse with
`ENDPOINT_IDENTITY_COLLISION`; missing source identity where qualification is
required refuses with `ENDPOINT_SOURCE_IDENTITY_MISSING`.

### References and coverage

Qualified endpoint references resolve by exact identity. A legacy `METHOD path`
reference is an alias only when precisely one endpoint in the complete current
population owns it. Two or more candidates produce
`AMBIGUOUS_ENDPOINT_REFERENCE`, credit no endpoint for that reference and keep
the distinct endpoints visible as unmapped. Unrelated route-only coverage may
still be reported. Neither an array order nor a cross-product selects a variant.
Unknown or stale references earn no endpoint credit.

The API schema already admits optional `id`; its instance version stays 1.0.0.
Coverage retains unique IDs and all existing cardinality rules. Existing valid
unique legacy references remain compatible. Authored use cases can migrate to
exact IDs after reviewing the complete inventory.

### Authentication and conditional authorization

Static API auth declarations and resolved permission semantics are distinct.
`auth.required: true` preserves an observed protected declaration; it does not
prove a guard's complete permission policy or runtime enforcement. Guard names
and synthetic `guard:<Name>` RBAC bindings remain declaration references, not
concrete permissions. Missing static permission metadata never means public.
Only a recognized explicit public marker supplies `auth.required: false`.

A guard whose permission semantics are conditional or unresolved retains its
auth/guard facts and reports `RBAC_AUTHORIZATION_UNRESOLVED`. Do not invent a
static permission or flatten conditional branches into an unconditional AND/OR.
For example, a guard may require one permission for absent/true `dryRun`, another
for false, and reject malformed input. This contract records uncertainty rather
than guessing its meaning from the absence of a decorator. A future resolved
conditional-policy representation requires an additive schema/extractor
contract and source/test evidence; it is not inferred here.

### Atomic failure visibility

Regeneration retains its full planned-body transaction. Any producer failure
prevents publication of every staged body and preserves historical files. The
aggregate reports concrete inner findings with their original codes/messages
alongside the producer/status/error count; a summary must not discard the
diagnostic that explains an atomic refusal. This changes new diagnostics, never
historical recorded bytes.

## Consequences

Same-path source variants remain independently reviewable and coverage is no
longer inflated by ambiguous references. References bound to exact observations
may require migration after source movement. An inventory is static evidence,
not proof of a complete runtime mount population. The demonstrated subset
collision does not establish complete STYNX executable or endpoint census.

## Alternatives Considered

Method/path-only identity, selecting the first handler, dropping alternative
compositions and weakening unique-items validation all lose measured facts.
Ordinal IDs depend on walk order. Truncated hashes are not a lossless reference
encoding. Treating changed qualified IDs as stable aliases would silently bind
authored intent to different source evidence.

## Affected Rules

The three inventory schemas document compatible identity and resolution rules.
The shared identity module and its API, coverage, RBAC and HTTP-evidence callers
implement them. Regeneration preserves concrete failure diagnostics and atomic
publication. Recorder custody, thresholds, source containment and the public
action set remain mandatory.

## Inspector Adversarial Acceptance

Discharge IA-001 through IA-006 with direct and installed-package fixtures,
including shuffled order, object-key order, portable paths, duplicate explicit
IDs, unique and ambiguous legacy aliases, exact qualified references and source
line movement. Assert both complete success and no partial writes on failure;
preserve all assertions and historical evidence.
