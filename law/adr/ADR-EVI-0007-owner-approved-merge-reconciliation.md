---
id: ADR-EVI-0007
title: Owner-approved merge reconciliation uses distinct protected host and proof-index boundaries
type: adr
status: accepted
date: 2026-10-24
authority: Architect
supersedes: []
provenance:
  - ADR-GOV-0027
  - ADR-EVI-0006
  - ADR-AUT-0008
  - law/constitution.md Article 6 (canonical selection and one-entry index publication)
  - docs/dev/operations/u1-b1-recovery-20261024/release-280/authorization.json
affected_rules:
  - law/policy/action-registry.json/evidence-reconcile
  - law/policy/action-registry.json/sense-bootstrap-inventory
  - packages/authority/src/boundaries/reconciliation-resources.ts
  - packages/authority/src/boundaries/reconciliation-host.ts
  - packages/authority/src/boundaries/proof-index-authority.ts
  - packages/cli/src/commands/evidence/reconcile.ts
  - packages/cli/src/commands/sense/bootstrap-inventory.ts
inspector_acceptance:
  - IA-001 -- Existing authority targets, action roles, binding modes and historical checks preserve their meanings; neither new resource accepts a physical Git path, arbitrary proof entry, wildcard selector or unknown field.
  - IA-002 -- Forged plans, receipts, Owner labels, cloned serialized reports, mismatched package or bindings and foreign worktrees cannot create an issuer handle, approve a phase or publish an index; shape validation grants no authority.
  - IA-003 -- Direct Architect provisioning and direct Owner approval require exact original argv, role, all three terminal streams, explicit write consent, exact confirmation and fresh actual authority; EOF, SIGINT, expiry or drift cannot apply a cloned preview.
  - IA-004 -- Every complete displaced parent and base chain, epoch and ancestry object is durably preserved before selecting the whole approved published-parent prefix; a distinct normal-writer selection event exists before active publication.
  - IA-005 -- Recovery uses the separately supported U1 and newest-line actions with immediate expected heads; selection cannot replay payloads, fabricate historical anchors, bypass epoch checks or replace a source event.
  - IA-006 -- Real direct and linked-worktree index tests preserve every other semantic entry, refuse unsupported representations and foreign locks, and publish only one verified proof entry under the real index.lock with exact blob-object effects.
  - IA-007 -- Actual concurrent process and crash schedules cannot create a second phase consumption, reap a live or successor lock, duplicate an event or turn partial or indeterminate output into completion; expiry, renewal and revocation follow the explicit intent matrix.
  - IA-008 -- Seven native diagnostic bodies read one admitted immutable staged snapshot, including all config and checksum inputs; no unresolved catalogue input, third conflict, mixed live source or forged clean commit can acquire native readiness.
  - IA-009 -- Installed public commands, generated registry and schema consumers, exact-head required checks and protected release gates must qualify the completed feature; pure codecs, fixtures and interim tarballs establish no integration or publication.
---

# Owner-approved merge reconciliation uses distinct protected host and proof-index boundaries

## Status

Accepted for the internal DEVAI v2.8.0 work explicitly authorized in the release
authorization record. This decision adds the implementation contract for the
Constitution 1.2.0 exception. It does not report implementation or independent
qualification. It supersedes no earlier ADR and permits no DETRAN operation or
downstream adoption. Historical authoring-only approvals and their evidence stay
preserved as historical records.

## Context

A valid unresolved merge can preserve both proof epochs while retaining only one
parent's active evidence chain. U1 recovers individual custody-proven anchors; it
does not select a canonical chain, authenticate an Owner approval, resolve an
index conflict or produce diagnostic inventory from a staged merge. Treating
these operations as ordinary filesystem grants would widen Article 6.

A digest, self-consistent receipt or caller-supplied Owner label proves no origin.
An exact index codec proves no permission to touch the real index. Readiness and
authority must therefore come from separate trusted boundaries with fresh actual
bindings and independently tested public behavior.

## Decision

### Registered actions and initiation

Add five registered actions, with exact JSON output contracts and closed grammar:

- `evidence reconcile plan`: Architect-initiated read-only planning; writes only
  stdout and grants no authority.
- `evidence reconcile approve`: direct human Owner approval, renewal, revocation
  or exact dead-lease recovery. These mutually exclusive modes change only the
  protected host's approval state and require explicit write consent.
- `evidence reconcile materialize`: Inspector-initiated machine custody and
  canonical selection, with explicit write consent.
- `evidence reconcile stage-proof`: Inspector-initiated machine publication of
  the exact final verified proof entry, with explicit write consent.
- `sense bootstrap-inventory`: Architect-initiated diagnostic generation from one
  exact admitted staged snapshot, with explicit write consent.

Provision the issuer only through an opt-in `init bind --reconciliation-host`
selector. The existing Architect initiation boundary of `init bind` stays intact;
the new Owner action does not add Owner to other binding modes. Every write needs
ordinary actual policy approval in addition to the protected B1 eligibility
checks. The general effect-authorization ledger remains unchanged.

### Logical resources

Use two distinct closed logical target kinds: `reconciliation-host`, admitted only
by its protected host adapter, and `proof-index`, admitted only by its one-entry
index adapter. Both bind actual repository/worktree identities and exact plan and
binding digests. The proof target fixes `record/proofs/chain.json`, `chain-cas`,
the authenticated approval/phase, before-index and unchanged-other-entry witnesses,
and final verified chain digest. Neither target accepts physical administrative
paths. The trusted host resolves the actual worktree administration paths.

These resources use exact plans. No bounded-batch selector or wildcard can widen
them. Classification, schema validation and policy matching are necessary inputs;
they cannot manufacture the host-issued invocation-local operation handle. The
final adapter rechecks that handle, actual original argv, action, initiation,
consent, bindings and fresh state before its exact effect.

### Protected approval and concurrency

The issuer and authenticated immutable approval, grant, intent and completion
records live in the private trusted worktree host namespace. A fixed private
publisher must use `0600` before its first byte. It never changes the ordinary
publisher's mode or grants arbitrary Git-directory access.

Owner approval binds exact source and plan bytes, original parents and base,
published selected parent, full custody, index witnesses and output/effect bounds.
Printed previews cannot be applied as handles. A live private handle expires on
bounded monotonic time; a grant is additionally boot and wall-clock bound. Renewal
retains scope and may resume the exact already-consumed intent; revocation is
terminal. Expired or revoked partial output cannot continue domain writes.
Already complete durable output may settle its exact completion without reviving
permission or producing another domain output.

Every phase and lease transition must share an independently qualified admission
mechanism. The mutable admission-file recovery proposal is rejected: the preserved
stale-reaper counterexample can quarantine a successor mutex. The immutable SQLite
kernel-lock anchor remains a candidate until its bootstrap, descriptor lifetime,
same-process exclusion, exact typed effects and actual adapter tests are closed.
No implementation may fall back to reaping a shared filesystem mutex or taking
over a lease based on age. Missing admission qualification blocks the dependent
operation, not unrelated read-only work.

### Custody, selection, recovery and index order

Preserve and read back the complete exact parent, common-base and original direct
anchor histories, complete epochs and ancestry before selecting an active chain.
The selected parent must be observed as actually published by the trusted host;
an input label is insufficient. Append one distinct canonical-selection event to
that entire selected prefix through the normal machine writer before publishing
the active result. Do not expose a selected prefix without its selection event.

The historical checker may recognize only the exact authenticated selection and
its preserved custody; ordinary chain and epoch modification checks remain
effective. U1 and newest recovery run separately with current expected heads.
Never stage the chain and then append behind the staged witness.

The index boundary owns the real index lock and exact content-addressed verified
blob publication. It rereads actual parents, phase and index under that lock,
preserves all other entries, and replaces only the proof path's entries with one
verified stage-zero entry. Unsupported formats or extensions refuse. The boundary
grants no ref, commit, push, release or business-source staging permission.
Post-publication uncertainty preserves exact ownership and durability evidence;
it is neither success nor an ordinary clean refusal.

### Diagnostic staged inventory

Build all seven native bodies from one immutable staged source reader, including
every config and checksum input. Reject unsupported modes, dirty or untracked
executable inputs, unresolved producer inputs, additional conflicts and drift.
The unresolved catalogue must not become a producer input. Report the actual
parents and staged witnesses as diagnostic provenance. Publish no canonical
inventory pointer, native reading, scorecard or forged clean/readiness claim.

## Consequences

- The remaining B1 implementation has explicit host and index authority surfaces.
  Existing U1, ordinary binding, inventory and historical checks keep their scope.
- Every new action, schema, adapter, capability, error and intermediate must enter
  its exact consumer/effect census before live operation is qualified.
- Independent Inspector counterexamples precede implementation and qualification
  of each newly frozen boundary. Source qualification is followed by actual
  installed command, integration and release verification.
- v2.8.0 publication uses the existing protected release lane, exact candidate
  artifacts and immutable registry/Release readback. This ADR is not publication.

## Alternatives Considered

Generic filesystem or Git grants are rejected because they exceed the one-entry
exception. Caller JSON, human labels and digest strings are rejected as approval
origins. A fake clean checkout is rejected as staged provenance. Shared mutable
lock-file reaping is rejected by the successor-quarantine counterexample. A DAG
history format or payload replay is a separate feature and is not this design.

## Affected Rules

The frontmatter names the added reconciliation action subjects and dedicated
runtime modules. The action subjects identify only the added registry entries;
they do not supersede release or other existing action decisions. Existing source
contracts, runtime union/schema consumers, policy compiler, command adapters and
generated views need deliberate corresponding implementation changes.

## Inspector Adversarial Acceptance

Discharge IA-001 through IA-009 against the real boundary concerned. Keep the
exact historical test inputs and meanings. A shape or pure-codec test does not
discharge host origin, process exclusion, real index publication, public command,
native readiness, source integration or release acceptance.
