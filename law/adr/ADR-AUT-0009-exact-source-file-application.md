---
id: ADR-AUT-0009
title: Role-bound exact source-file application through the runtime
type: adr
status: proposed
date: 2026-10-28
authority: Architect
supersedes: []
provenance:
  - AGENTS.md maintainer-governed source and dispatched worker scope
  - law/constitution.md Articles 6 to 10
  - ADR-AUT-0003 (actual bound adopter source authority)
  - ADR-AUT-0004 (registered role-specific class write verbs)
  - ADR-AUT-0005 (guarded atomic no-replace publication)
  - ADR-AUT-0008 (cooperative final checks do not control arbitrary external edits)
  - STYNX S10 continuation and bounded upstream source-write implementation preparation on 2026-10-28
affected_rules:
  - law/policy/action-registry.json
  - law/schemas/source-apply-manifest.schema.json
  - law/schemas/source-apply-result.schema.json
  - packages/authority/src/boundaries/host-effects.ts
  - packages/authority/src/boundaries/host-source-publish.ts
  - packages/cli/src/authority/broker.ts
  - packages/cli/src/authority/policy-support.ts
  - packages/cli/src/authority/policy-core-rules.ts
  - packages/cli/src/command-manifest.ts
  - packages/cli/src/commands/source/apply.ts
  - packages/cli/src/commands/source/manifest.ts
  - packages/cli/src/generated/action-registry.ts
  - packages/effects-check/src/generated/action-catalog.ts
  - packages/sensors/src/generated/action-kinds.ts
  - docs/adopters/path-authority.md
  - docs/reference/cli/index.md
inspector_acceptance:
  - IA-001 -- Actual installed public invocations admit only the matching declared role and its bound source path class; wrong role, missing write consent, missing or stale policy, and wrong path class refuse before target mutation.
  - IA-002 -- Protected Git administration, record and .devai paths, traversal, symlinks, special files, multiple hard links and malformed manifests refuse; no source action writes a second caller-selected target or invokes a process.
  - IA-003 -- A stale preimage hash, mode or identity, including changed bytes with identical length and restored mtime, refuses at the final check; a changed parent observed before publication also refuses.
  - IA-004 -- Concurrent absent-file creates use actual no-replace publication and never overwrite the winning target; replacement exposes complete bytes and preserves the checked ordinary permission bits.
  - IA-005 -- Failures before publication preserve the original target; failures or uncertainty after publication preserve visible files and report an indeterminate result without rollback, deletion of another writer's data, or automatic retry.
  - IA-006 -- Mutable manifest aliases, changed content digests, borrowed callbacks, extra guarded effects and a role or action mismatch cannot expand the one-target operation; stale real policy cannot be replaced by caller-supplied authority.
  - IA-007 -- Added raw mutation sites fail the mechanical denominator; the new action groups preserve existing class precedence, admit exactly the three reviewed role-specific verbs, and require supported policy rebinding.
  - IA-008 -- A disposable installed adopter reproduces admitted and refused cases under actual bindings; tests distinguish cooperative final-check conflict detection from unsupported filesystem compare-and-swap and hostile parent-swap guarantees.
  - IA-009 -- The two native Inspector source rules do not shadow declared adopter test classes; original backend check allowances and matched rules survive, while the measured native task-start permission narrowing remains explicit and actual task lifecycle checks pass.
  - IA-010 -- Historical pre-B1 and B1 fixtures, hashes and exact action populations remain intact; current tests admit exactly three additional contracts and their reviewed policy deltas without replacing historical evidence.
---

# Role-bound exact source-file application through the runtime

## Status

Proposed for the authorized bounded upstream implementation. This record does
not claim acceptance, completed qualification, package publication, or adopter
binding. DEVAI's own source is maintainer-governed under AGENTS.md. An adopter's
constitution does not create an upstream authoring bootstrap restriction.

The new runtime operation is intended to support ordinary governed source work.
Existing STYNX product approvals retain their exact scope. This proposal does not
merge STYNX #211, authorize publication, alter release classification, or establish
formal DEVAI or downstream DETRAN/PORM acceptance.

## Context

Article 6 requires runtime writes to respect actual path authority and requires
external editors to have a declared host adapter. Existing post-merge and GitHub
adapters do not control arbitrary editors or shells. A registered runtime source
operation supplies a concrete writing surface without claiming to intercept those
external tools or borrowing an unrelated action's authority.

The broker's ordinary target preparation/application boundary can authorize one
filesystem effect. Its captured exact-plan path uses generic snapshot rollback;
restoring that snapshot after failure could overwrite another writer's intervening
change. Existing filesystem snapshots also inspect metadata rather than binding
the actual preimage bytes. A source operation therefore requires its own content
checks and preservation semantics.

## Decision

### Public operation and data

Add `source apply architect`, `source apply engineer` and
`source apply inspector`. Each takes `--manifest <file> --write --as-role` with
the matching role through the normal public command and declaration mechanisms.
Register only `fs:workspace`, human subject restricted to that one role, the
filesystem authority boundary, required current binding, and independent
acceptance. Use one bounded batch with one target and preserve-and-report recovery.

The version 1.0.0 manifest contains exactly `schemaVersion`, `target`, `expected`,
`content_utf8` and `content_sha256`. The target is one normalized repository-relative
POSIX path. Expected state is either `{kind: absent}` or a regular file described
by `kind`, whole-byte SHA-256 and ordinary permission mode. Validate exact keys,
UTF-8 round trips, path grammar and content digest; bind immutable candidate bytes.
The manifest cannot choose the root, action, subject, receipt or policy.

Create one absent regular file with mode 0644, or replace one existing regular
file while preserving its checked ordinary permission bits. Parents must already
exist. Refuse symlinks, special permission bits, nonregular entries and multiple
hard links. Exclude Git administration, `.devai` and `record` targets regardless
of a caller's role. Existing path-class and forbidden-action protections remain
in force. No new test-authoring exception or executable-documentation authority
is granted. No delete, directory creation, independent chmod, user-file rename,
Git operation, process, network effect or multi-file transaction is admitted.

### Final guarded effect

The command requests one immutable operation-specific guarded host effect. The
broker binds that request to the parsed invocation and manifest, verifies its
registered role and action, refreshes actual bound provenance, denies other
mutations, and calls its one-target authorization boundary. A handler never gets
a raw filesystem writer after an advisory allow.

Immediately before publication, verify the resolved target and parent identities,
read the actual expected file through no-follow handling where supported, compare
identity and ordinary mode, and hash the bytes. Metadata equality is insufficient.
Create uses the existing guarded no-replace publication. Replace uses a new
operation-specific same-directory staged publication: write and fsync the complete
bytes, preserve the checked mode, recheck expected target and parents, and rename
the stage atomically. Private staging is part of the one logical operation and
cannot be selected by the caller as an additional target.

Do not route this operation through `commitCapturedExact`,
`applyAuthorityHostEffectsAtomically`, or
`runAuthorityHostEffectsWithRollback`. Existing callers of those helpers retain
their contracts. Before publication, failure preserves the target and may clean
up only a verified owned stage. After publication or an ambiguous outcome,
preserve visible files and report uncertainty with available identities and
observations. Never restore an old snapshot, delete a target to recover, or retry
an indeterminate application automatically. Verify resulting identity/content
and handle directory durability before claiming success.

### Concurrency and host boundary

The supported population is an ordinary cooperative checkout with stable parent
topology during application, consistent with the existing path-based host effects.
Final checks detect conflicts observed before publication; atomic rename prevents
partial-file visibility. They do not implement an OS-level compare-and-swap.
An uncooperative concurrent writer can change the target after the last check.
Node path-based publication also cannot prevent a hostile same-user process from
swapping a parent between validation and its syscall. Pre/post identity checks
must not be presented as eliminating either race.

No global writer exclusion, cryptographic human consent protocol, hostile-process
containment, or control over arbitrary editors is claimed or inferred as a
constitutional requirement. A stronger descriptor-relative native primitive would
be additional reviewed implementation scope. Tests must assert only guarantees
the implementation actually provides and preserve indeterminate outcomes.

### Registration and adoption

Generate the three existing registry views using the official generator. Add only
`source apply engineer` to the explicit Engineer subject-group list; Architect
and Inspector human groups continue deriving from registered allowed roles.
Update exact action-set expectations for these additions while retaining path
selectors, class precedence and all historical assertions about forbidden paths.
The role-specific class derivation of ADR-AUT-0004 remains intact.

Exclude only `source apply inspector` from the legacy human Inspector group used
by the broad `core-inspector-tests` and `core-inspector-tests-plural` rows. Retain
every other previously registered Inspector action. The new source action remains
in the registry-derived adopter test-class verbs. Instead of activating a global
wildcard test row, add exactly two immutable-core rules at precedence 800:

- `core-inspector-source-tests` selects `tests/**`.
- `core-inspector-source-package-tests` selects `packages/*/tests/**`.

Both admit only `source apply inspector`, a human Inspector subject, and create
or update operations. They implement Article 6's native test locations. Declared
adopter test roots retain precedence 700 and architecture classes retain 750;
no resolver fallback or precedence change is introduced. In particular the
existing harness-Inspector `check` allowance on
`backend/domains/ops/tests/example.test.ts` remains decided by its original
adopter test rules. A global precedence-800 row initially broke that allowance;
the original failure evidence is retained and is not a new expected result.

This introduces a deliberate policy narrowing on native tests. A baseline broker
probe permitted Engineer `task start` at
`packages/x/tests/example.test.ts` through the broad package rule; the candidate
denies it under the native Inspector rule. Root test targets change from
unclassified to denied for that action. `round run` and `task finish` lack
`fs:workspace`; no new grant is made for them or for `check`. This record does not
claim that every prior broker decision is unchanged.

The measured probe supplies a constructed filesystem target to the real broker.
It does not establish a failure of the public task-start lifecycle: that command
accepts task/round and worktree/database provisioning inputs, delegates through
`startRoundTask` to `spawnTask`, and exposes no arbitrary source-file target or
content. Preserve lifecycle behavior and verify it independently. The old generic
Engineer test allowance is not an implementation of the later constitution's
bounded focused-regression exception, and this source operation does not claim
to implement that exception. No blanket Engineer permission is added to preserve
an allowance contrary to the native Inspector mapping.

Preserve the pre-B1 and B1 byte fixtures, hashes, exact populations and original
policy assertions as historical evidence. Qualify the candidate separately:
exactly 77 actions comprise the unchanged 74 B1 contracts plus the three source
contracts, with stable 41, preview 25 and internal 11. Assert the exact new role
sets and full policy-row deltas, including these two native rules and changed
package-extension digest. Never overwrite a B1 hash with candidate bytes or
remove an old assertion to claim compatibility.

New action membership changes resolved policy. Installed adopters must use the
supported qualified-package upgrade and policy/adopter binding flow. Do not
hand-edit `.devai/config`, copy registrations into an old runtime, substitute
prospective policy for actual authority, or invoke another verb as a workaround.
No constitution amendment or external-editor adapter is introduced by this record.

## Consequences

Ordinary role-bound source writes acquire an explicit public runtime path. Each
file is independently applied and reported; a sequence of files is not atomic.
The caller must inspect an indeterminate result before any continuation. Source
staging and committing remain separate operations. Existing approvals describe
allowed product changes and do not replace current bound path authority.

The portable implementation has the documented cooperative concurrency boundary.
It cannot be advertised as safe against arbitrary same-user filesystem attackers.
Registration, native checks, installed qualification, publication and adopter
rebinding remain distinct delivery steps.

## Alternatives Considered

A full external-editor adapter would cover a broader surface and is unnecessary
for this explicit runtime operation. Reusing unrelated write verbs would disguise
a new effect. Generic rollback can destroy intervening work. Requiring global
writer exclusion or cryptographic confirmation adds mechanisms not required by
the cited constitutional text. A native descriptor-relative primitive may support
a stronger future host guarantee but is not silently claimed by this increment.

## Affected Rules

The frontmatter names the registry, manifest/result schemas, operation-specific
boundary, broker, role groups, command implementation, generated views and public
documentation. The immutable core path mapping and existing accepted ADR bytes
remain unchanged. Catalogue regeneration and its existing digest bindings must
follow the official documented renderer as part of integration.

## Inspector Adversarial Acceptance

Discharge IA-001 through IA-010 with genuine public command and guarded boundary
execution in disposable fixtures, including a packed installed package. Cover
wrong roles and paths, real stale byte checks, no-replace races and failures before
and after publication. Assert preservation rather than synthetic rollback success.
Retain existing tests and compare the exact action-set changes. No native,
installed, integration or release pass is asserted by this proposed record.
