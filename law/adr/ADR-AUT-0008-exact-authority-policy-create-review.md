---
id: ADR-AUT-0008
title: Exact authority-policy create review in one live invocation
type: adr
status: accepted
date: 2026-10-24
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Articles 6, 9 and 10
  - ADR-AUT-0001 (a receipt is not authority)
  - ADR-AUT-0003 (actual bound source authority)
  - ADR-AUT-0005 (guarded atomic no-replace publication)
  - REC-B1-A-P1 bounded implementation and disposable-fixture approval on 2026-10-24
  - REC-B1-A-P1 two-path output-boundary amendment approval on 2026-10-24
affected_rules:
  - packages/cli/src/action-output.ts
  - packages/cli/src/command-router.ts
  - packages/cli/src/commands/init/index.ts
  - packages/cli/src/commands/init/shared.ts
  - packages/cli/src/commands/init/review-authority-policy.ts
  - packages/cli/src/authority/command-capabilities.ts
  - packages/cli/src/authority/broker.ts
  - packages/cli/src/authority/policy-review.ts
  - packages/cli/src/authority/policy.ts
  - packages/cli/src/authority/policy-support.ts
  - docs/reference/cli/index.md
inspector_acceptance:
  - IA-001 -- The public route rejects the unavailable review mode before implementation; the completed route emits exact prospective policy bytes before any persistent or transient filesystem effect, while legacy plans remain unchanged.
  - IA-002 -- Only a real terminal and direct Architect declaration with write consent admit the paired review selectors; every conflicting selector, role, replay path, unknown flag and automatic fallback refuses before preparation or mutation.
  - IA-003 -- An admitted installed canonical constitution and registered project reconciliation project the exact successor inputs without writing them; the current pin, pointer, project, receipt and source remain unchanged while ready.
  - IA-004 -- The ready base64 decodes to the frozen size and whole-byte SHA256; mutable buffer aliases, altered plan fields, semantic-only hashes and reserialization cannot change the artifact eventually published.
  - IA-005 -- A serialized or cloned report is not a live host-owned handle; foreign issuer or invocation, wrong confirmation, cancellation, expiry and disposal cannot publish or resume an apply.
  - IA-006 -- Only the exact two-file approved precursor transition is permitted; partial or changed source, package, receipt, pointer, host mode, directory, HEAD, index or lock state prevents publication.
  - IA-007 -- Prospective data never authorizes filesystem effects; the final create receives fresh ordinary authority from actual current bindings without holding or extending a pre-wait mutation decision TTL.
  - IA-008 -- One exact confirmation publishes the retained bytes once through the existing guarded no-replace effect, without rebuilding timestamp or invocation provenance; no file other than the declared target changes semantically.
  - IA-009 -- Existing targets and two-process contention never overwrite or delete a winner; real pre-link failures leave no target and post-link uncertainty preserves complete bytes and owner identity without a durability claim or unsafe rollback.
  - IA-010 -- Existing default, full, constitution, adopter, host and upgrade branches retain their original authority, consent, output and transaction meanings, with all historical checks preserved.
  - IA-011 -- The real action-output boundary emits one schema-valid READY before waiting, shows the exact prompt immediately on stderr, emits one terminal envelope and restores streams/exit/scope on every settlement; unowned or foreign transport access refuses.
---

# Exact authority-policy create review in one live invocation

## Status

Proposed under the human's 2026-10-24 instruction:

> Approve REC-B1-A-P1 for bounded implementation and disposable-fixture tests. Preserve historical checks; return exact preview evidence before live use. Keep binding, integration, U1/B1 runtime, release and DETRAN effects held.

The human additionally approved the two-path output-boundary amendment:

> Approve the two-path output-boundary amendment and disposable-fixture tests. Preserve historical checks; return exact public preview evidence before live use. Keep binding, integration, U1/B1 runtime, release and DETRAN effects held.

Those instructions originally authorized bounded implementation and disposable
fixtures. The human subsequently expressly authorized all listed DEVAI internal
work, binding, integration and publication as v2.8.0. This record is now accepted
under that instruction. Real installed-package terminal qualification and exact
DEVAI self-binding evidence are retained additively under
`docs/dev/operations/u1-b1-recovery-20261024/release-280/` and
`docs/dev/operations/u1-b1-recovery-20261024/v2.8.0-qualification/`.
It supersedes no record and changes no constitutional text, authority policy
schema, action effect/capability or runtime target kind. Earlier packets remain
historical; DETRAN execution and adoption remain outside the authorization.

## Context

The ordinary no-write `init bind` reports an advisory authority-policy plan. Its
materialized output contains an actual invocation, declaration/context digest and
construction timestamp, so rebuilding in a later invocation changes the whole
artifact digest. A semantic no-op comparison is not an exact-byte preview.

The successor constitution must also be planned before it is bound. Reading only
the held predecessor pin would preview a policy for the wrong constitution.
Previewing trusted canonical after-state inputs must therefore remain distinct
from granting authority under actual current bindings.

## Decision

Add an opt-in, paired `--review-authority-policy --after-constitution` mode on
existing `init bind`. It is an armed local-write invocation with direct Architect
identity, existing write consent, JSON output and a real terminal. Its preparation
and wait phases have zero persistent or transient filesystem effects. A second
case-exact `CREATE <plan_sha256> <artifact_sha256>` confirmation is required before
publication. Neither printed data nor `--write` alone publishes in this mode.

The initial supported population has a contained existing target/config directory,
absent authority-policy target, cli-only host mode, and no declared/bound adopter
authority extension. Existing no-extension receipt/source remain validated and
preserved. Unsupported modes, selectors, replay/output paths and unknown inputs
refuse; no existing extension is omitted or downgraded.

### Exact prospective artifact

Use the admitted installed candidate's canonical constitution and existing
registered project reconciliation to project only the successor pin and project
bytes. Do not write them or accept caller-supplied source bytes/paths. Reuse the
same rule builders and canonicalization as actual-source compilation. Prospective
bindings are private non-authorizing data, never a source of mutation permission.

Construct the candidate once through the unchanged materialization checks with
real invocation/Architect/consent and construction-time provenance. Freeze bytes,
size, whole SHA256, input before/prospective-after manifests and complete ready
plan digest in an invocation-local owned handle. Materialization time means actual
artifact construction time; later publication time belongs only in stdout.
There is no public handle constructor, serialized apply token or plan-file replay.

The ready report precedes any binding. A separately authorized operator may apply
the exact registered constitution precursor while the process waits. The preview
never runs or authorizes that precursor. Only its exact two-file transition may
become eligible; every other consumed input is frozen. This is not an atomic
transaction across the two actions, and interruption never rolls back a genuine
separately approved precursor or claims completed binding.

The review lifetime is 300000 monotonic milliseconds. EOF, cancellation, wrong
confirmation, expiry or disposal invalidates the handle without a new file
operation. No mutation decision receipt is retained across the human wait and no
existing receipt TTL or validation timeout is widened.

### Invocation-owned public output

The actual action-output wrapper admits a narrow invocation-local review transport
only for the exact public selection above. It emits one schema-valid READY action
envelope before awaiting terminal input and displays the exact confirmation prompt
immediately on stderr. It emits one terminal completion/cancellation/refusal envelope
and preserves existing refusal classification and publication uncertainty. All
stream/exit handling and authority scope are restored on success, rejection,
interruption, timeout and cleanup failure. Other actions retain ordinary one-result
buffering. Unowned, foreign, cloned or reused transport access cannot activate the
protocol, issue authority, publish files or replay a plan. No raw output bypass or
public release-host constructor is introduced.

### Actual publication authority

On exact confirmation, re-read actual bindings and require the precise successor
pin/project, unchanged pointer/receipt/source/host/package identity, target absence
and no upgrade lock. Recompute trusted actual rules and compare source identities
with the frozen candidate. Issue fresh ordinary publication authority under that
actual state and the same live human identity/consent. Prospective bindings never
authorize filesystem effects.

Re-hash retained bytes and plan, then in a synchronous final-check/publication
section publish that exact buffer through guarded `publishFileNoReplaceSync` at
`.devai/config/authority-policy.json`. Classify one create target only. Do not
rebuild materialization provenance, call a raw writer, replace an existing target,
create another lock/journal/state/proof, or expand a generic host grant.

Use ADR-AUT-0005's primitive and crash semantics unchanged. Its private staged-name
recipe is disclosed, but that publication-time UUID does not affect reviewed
policy bytes. Before link, failure leaves no target. After link, incomplete cleanup
or directory fsync preserves the complete owned target and reports uncertainty;
there is no rollback deletion, foreign cleanup or false durability claim. Two
concurrent confirmations permit at most one no-replace create.

Cooperative final source/lock checks do not claim control over arbitrary external
edits beyond the declared host-enforcement boundary. A need for stronger source
linearizability requires its own exact adapter/lease proposal. No such grant is
inferred here.

### Scope and return

Only the approved twenty-one human-authored path Architect/Engineer/Inspector
envelope and its enumerated generated index/error-reference effects belong to
implementation (twenty-two distinct paths with the additional error reference).
The amendment adds only action-output.ts and its dedicated Inspector test path.
Tests write only disposable fixtures. No live preview, binding, source publication,
integration, U1/B1 operational action, release or DETRAN effect follows.

Return exact fixture preview bytes/digests and before/after evidence, source
identities, independent RED/GREEN and refusal/race/crash findings before live use.
Installed-package qualification, actual preview launch, concrete precursor/confirm
approval and final integration remain separate gates. Historical real binding
failures remain visible until their own authorized effects occur.

## Consequences

- Whole-byte review and publication share one artifact in one live invocation;
  printed JSON never becomes a reusable authority credential.
- Canonical successor projection is possible before binding without pretending
  the prospective pin is an actual current authority source.
- The ordinary advisory/default/update/full/upgrade behavior remains unchanged;
  the new mode handles only a confirmed create into an absent policy target.
- A crash can leave an incomplete two-action binding sequence. Its true state and
  existing history are preserved, and remaining gates stay closed.
- No constitutional amendment, schema migration, general Git/filesystem grant,
  new action or release permission is introduced by this mode.

## Alternatives Considered

- Regenerating policy bytes in a later invocation changes provenance and cannot
  satisfy exact-byte review.
- Omitting volatile fields or using only semantic policy identity changes the
  existing policy/evidence contract and is outside this bounded change.
- Serialized bearer plans or arbitrary projected input paths would confuse data
  with authority and are rejected.
- Existing-target replacement requires a different exact compare-and-swap and
  concurrency packet; it is not added to this create-only mode.
- A read-only no-consent advisory plan remains available, but is not relabelled as
  an exact preview of a future nonce-bearing artifact.

## Affected Rules

The eleven exact subjects in frontmatter are the closed reference/implementation
surfaces. All lower authority runtime, policy schema, publisher, registry,
constitution and release-host contracts remain read-only.

## Inspector Adversarial Acceptance

The eleven obligations above are tested through the approved twenty-four-case
P1 matrix and the two-path amendment's actual-wrapper tests. Inspector owns tests and preserves the original assertions. Public-route
RED must precede Engineer implementation; import/compiler errors alone are not
security evidence. No skip, timeout/threshold change, waiver or fake binding file
may manufacture GREEN. Installed/live standing is separate from fixture results.
