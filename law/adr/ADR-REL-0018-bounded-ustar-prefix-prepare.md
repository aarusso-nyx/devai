---
id: ADR-REL-0018
title: Support deterministic USTAR prefixes and bounded multi-package prepare
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 6 (bounded authority)
  - law/constitution.md Article 41 (exact evidence identity)
  - law/adr/ADR-REL-0007-pure-sink-mediated-prepare.md
  - law/adr/ADR-REL-0011-finalize-spdx-document-vocabulary.md
  - law/adr/ADR-REL-0015-close-certification-provenance-and-sink-ambiguity.md
  - law/adr/ADR-REL-0017-package-owned-release-policy-resolution.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/policy/action-registry.json
  - law/schemas/action-registry.schema.json
inspector_acceptance:
  - IA-001 -- The real 102-byte archive template path is retained exactly using the canonical USTAR split; valid UTF-8 boundary cases reproduce exact headers and extraction paths, while unsplittable or unsafe paths refuse before sink.begin.
  - IA-002 -- Pack v4 canonical bytes and SHA-256 agree exactly across policy, schema and implementation; v3 remains historical and cannot silently select v4 packing or current publication.
  - IA-003 -- Before sink.begin the live invocation has at least 3N+33 remaining batches and targets for exactly N certified packages; missing, forged, stale, cross-invocation or insufficient capacity refuses without artifact exposure.
  - IA-004 -- The 38-package cohort completes within prepare-only 256 batches, while one-less-than-required remaining capacity refuses; complete success, abort, unknown-commit and append-failure paths preserve their bounded bookkeeping and no-abort-after-commit rules.
  - IA-005 -- Store-directory identity drift refuses instead of recreating directories after capacity checking; no counter reset, concurrent reserve theft, generic batch-limit increase, extra capability or publication grant is introduced.
---

# Support deterministic USTAR prefixes and bounded multi-package prepare

## Status

Accepted as a forward, narrowly bounded prepare correction. Lifecycle policy
`2.8.0` selects `devai.kernel.release-prepare.v4` and
`devai.pure-npm-compatible-pack.v4`. The opaque state wire format stays
`2.1.0`, and the named sink interface stays `trusted-artifact-sink-v3`:
an archive format revision does not grant another effect. Prior accepted ADRs,
pack specifications, artifacts and receipts remain unchanged historical data.

## Context

The real DEVAI archive contains
`package/dist/resources/operations/scaffold/templates/api/controllers/__kebabEntity__.controller.ts.tpl`,
whose UTF-8 encoding is 102 bytes. Pack v3's 100-byte name-only limit cannot
represent it, although the ordinary USTAR prefix field can. Excluding or
renaming a required product template would misrepresent the certified package.

The real STYNX cohort contains 38 packages. Prepare exposes three artifacts
per package plus one complete commit-manifest object. Even with one protected
effect per logical sink operation, 128 batches cannot cover its full sink and
state-completion obligations. A remaining-target limit is not permission to
exceed a separate batch limit.

## Decision

### One deterministic USTAR representation

For each certified entry, the logical archive path remains exactly
`package/<entry.path>`, encoded as valid UTF-8 without normalization. Existing
regular-only selection, sorted complete population, modes, sizes, zero
timestamps, stored DEFLATE, checksums, SPDX fields and absent optional metadata
are preserved. No source file is renamed, omitted or synthesized.

If the full archive path is at most 100 UTF-8 bytes, store it in `name` and
leave `prefix` empty. Otherwise choose the rightmost slash for which the
prefix before that slash is nonempty and at most 155 UTF-8 bytes, and the
remaining name after it is nonempty and at most 100 UTF-8 bytes. Both are
complete UTF-8 strings; the separator itself is not stored in either field.
Reconstruction is exactly `prefix + '/' + name`. Refuse if no such slash
exists. This is a byte constraint, not a JavaScript character-count limit.

Write name at header offset 0 with width 100, and prefix at offset 345 with
width 155. Zero-pad unused bytes; a field that fills its width needs no extra
NUL. Never truncate, normalize Unicode, substitute invalid Unicode scalar
values, split a multibyte encoding, or add an extension record. Paths remain
relative and normalized with no empty, dot, dot-dot or NUL segments and no
backslash. PAX, GNU long-name records, links, directories, devices, FIFOs,
external pack tools and shell execution remain forbidden.

The entire v4 canonical byte string and its SHA-256 are pinned by lifecycle
policy and schema. Its sole SPDX creator names v4; all other SPDX semantics
are unchanged. Package and commit manifests bind that exact specification
identity/digest. Current prepare and downstream semantic verification require
the current exact specification, not a version prefix or a self-consistent
caller-selected digest. Historic v3 artifacts remain observable under their
original specification and never acquire current authority by repacking,
relabeling, rehashing or wrapping them as v4.

### Exact capacity before exposure

Only `release prepare` changes `max_batches` from 128 to 256. Its
`max_targets_per_batch` stays 64 and `max_total_targets` stays 8192. The schema
fixes the complete prepare planner, with its existing id, target kinds and
recovery behavior. Other actions, capabilities, roles, consent and adapters
are unchanged. No bound may be reset, replaced, silently bypassed or credited
from another invocation.

The trusted host supplies a read-only, non-transferable budget reader bound
to the live prepare invocation and its exact bounded plan. It reports actual
remaining batches and total targets from the same authority account that will
charge every later effect. It is not a CLI field, candidate callback, receipt
assertion or caller-supplied numeric allowance. Missing, malformed, stale or
cross-invocation capacity returns `release-prepare-capacity-unavailable`.

After verifying the complete certified package population and exact packed
artifact count, immediately before `sink.begin`, require remaining batches
and remaining targets independently to be at least `3 * N + 33`, where `N`
is the complete request-bound certified package count. Each value and the
arithmetic must be a nonnegative safe integer. No subset, truncated roster or
estimated package count is acceptable. Insufficient capacity returns
`release-prepare-capacity-insufficient` before begin or any artifact exposure.
Startup directory initialization, lock acquisition and the attempt record
have already been charged when the reader is consulted; they are never
assumed free or subtracted a second time.

The frozen conservative reserve is derived from the current effect boundary:

| Obligation after the check                 | Batches and targets |
| ------------------------------------------ | ------------------: |
| Sink begin                                 |                   1 |
| Three package objects per package          |                  3N |
| Complete commit-manifest put               |                   1 |
| Commit                                     |                   1 |
| Pre-commit abort allowance                 |                   1 |
| Completion/state/head/lock-cleanup reserve |                  29 |
| Total reserved                             |             3N + 33 |

A logical begin, put, commit or abort consumes exactly one protected sink
batch/target under its existing owner-bound synchronous operation. Its
root-confined internal filesystem calls do not mint further sink capabilities.
The ordinary lifecycle filesystem calls remain separately counted; grouping
them into the sink token is forbidden. Read-only artifact re-verification
does not mutate or consume a mutation batch. Commit and abort are mutually
exclusive, but reserving both is deliberately conservative, not permission
to abort after commit dispatch.

The 29-batch state reserve has a checkable primitive derivation. An
`exclusiveWrite` consumes seven effects: file open/write/fsync/close, then
directory open/fsync/close. Success consumes completion 7, state 7, temporary
HEAD 7, HEAD rename 1, HEAD-directory sync 3 and execution-lock cleanup 4.
Failure or unknown terminal evidence consumes only terminal 7 plus cleanup 4;
temporary-HEAD cleanup on an append failure remains within the success bound.
No additional prepare-specific disk proof is silently excluded. An added
effect requires a new demonstrated bound or must already have been charged
before the check; it cannot consume an unaccounted allowance.

The campaign and its records/attempts/completions/failures/unknown directories
are initialized and their filesystem identities pinned under the execution
lock before this check. Subsequent append paths verify those identities and
refuse drift rather than recursively recreating missing directories. This is
necessary for the 29-effect bound; mutable ancestor depth must not become an
unbounded post-exposure mkdir obligation. Existing no-follow and root checks
remain mandatory.

The budget observation and completion sequence are exclusive within that live
invocation. No unrelated or concurrent operation may spend its required
capacity between checking and completion; the host must enforce that
sequencing or a protected reservation against the same account. A number
copied out of a previous observation is not a reservation. Every actual effect
still undergoes normal target authorization and final re-verification.

For 38 packages, the check requires 147 remaining batches and targets. A fresh
256-batch invocation has sufficient room only if its already-charged startup
also leaves that reserve. This is not an unconditional promise for arbitrary
state-root depth, extra effects or malformed stores. Budget refusal may append
the existing bounded failure bookkeeping but never exposes artifacts or
appends success. Store I/O failure or unknown commit remains explicit
uncertainty, preserves available transaction/handle evidence and permits no
abort, rollback, retry or publication beyond the existing contract.

## Consequences

Engineer changes the pure header splitter and pack-spec constants, verifies
the digest before packing, and keeps all artifact and downstream comparisons
exact. No package population changes. The broker exposes only the active
prepare account's read-only remaining capacity. The prepare core queries it
before begin; the store pins initialized directory identities and no longer
recreates them during append. Regenerate action views mechanically from law.

Unit tests may supply a genuine scoped authority harness with instrumented
consumption. Arithmetic-only fixtures prove arithmetic, not protected host
execution. There is no production unscoped, infinite-budget or missing-reader
fallback. Installed-host acceptance must exercise the actual broker and
counter consumption through success and all terminal paths.

## Alternatives Considered

**Drop or rename the long template.** Rejected: it weakens the certified
product population to accommodate a packaging defect.

**Use PAX, a tool subprocess or arbitrary split points.** Rejected: these
introduce unnecessary format freedom or execution authority.

**Treat 8192 total targets as permission for more than 128 batches.** Rejected:
both ceilings apply independently. The narrowly increased prepare ceiling
does not change that rule.

## Affected Rules

The lifecycle policy/schema freeze pack v4, the exact reserve, scope and
refusals. The action registry/schema change only the prepare batch ceiling
and close its planner to prevent generic broadening. No state or receipt
wire shape changes are required.

## Inspector Adversarial Acceptance

Cover the real 102-byte template; 100/101-byte full names; 155/156-byte prefixes;
100/101-byte suffixes; a valid 256-byte split; multiple slash choices; UTF-8
boundaries; invalid Unicode and unsafe/unsplittable paths. Verify exact header
padding/checksum, deterministic gzip, package population and SPDX creator.
Exercise the actual 38-package sink count, exact reserve and one-less reserve,
absent/cross-scope readers, competing budget consumption, directory replacement,
pre-commit abort, unknown commit and post-commit append failure. Preserve every
existing sink/signature/metadata check and prove all other planner bounds stay
unchanged.
