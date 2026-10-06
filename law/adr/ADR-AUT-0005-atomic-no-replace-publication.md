---
id: ADR-AUT-0005
title: A governed atomic no-replace publication among the authority effects
type: adr
status: accepted
date: 2026-10-05
authority: Architect
supersedes: []
provenance:
  - ADR-AUT-0001
  - ADR-MDL-0005
  - ADR-MDL-0007
  - law/constitution.md Articles 6 to 10
  - packages/authority/src/boundaries/host-effects.ts
  - packages/cli/src/authority/broker-paths.ts
  - the Owner decision of 2026-10-05 on follow-up issues aarusso-nyx/devai#287, #286 and #293
affected_rules:
  - packages/authority/src/boundaries/host-publish.ts
  - packages/authority/src/boundaries/host-effects.ts
  - packages/authority/src/boundaries/index.ts
  - packages/effects-check/src/program.ts
  - packages/cli/src/authority/broker-paths.ts
  - packages/loop/src/loop/durable-files.ts
  - packages/loop/src/loop/worktrees.ts
  - packages/loop/src/loop/experimental-activation.ts
  - packages/loop/src/loop/state-root.ts
  - packages/cli/src/commands/init/apply.ts
  - packages/cli/src/commands/round/dispatch-agents.ts
  - docs/reference/cli/round-task-executors.md
inspector_acceptance:
  - IA-001 -- A publication to a path that exists refuses with EEXIST and leaves the existing bytes and no staged file; of two interleaved publishers of one path exactly one succeeds and the other never replaces it.
  - IA-002 -- A crash between the link and the staged unlink leaves the complete bytes at the target and a stray staged link that no `.json` reader lists, and a retry refuses rather than replacing the target; a failed staged unlink or directory fsync after the link refuses as an indeterminate publication with the staged name recovered, and a lock holder removes its own lock.
  - IA-003 -- The publication crosses the authority seam as one filesystem effect that the broker classifies as a `create` of its target alone, inside the action's declared path domain; a refused effect applies nothing.
  - IA-004 -- Two worktree registry writers interleaved at the first one's checkout never exceed the worktree cap and never drop an entry; a lock left by a gone process on this host refuses as stale and is never taken over.
  - IA-005 -- `round dispatch` refuses before any lock until `init apply harness` has fsynced the repository directory (when it created `.devai`) and `.devai` and published the state-root marker; a marker that is not a regular file with the exact bytes refuses dispatch and initialization, and a re-application keeps a valid marker byte for byte.
---

# A governed atomic no-replace publication among the authority effects

## Status

Accepted on 2026-10-05 under the Owner's decision on follow-up issues #287, #286 and #293,
which directed this effect and the three uses below. Resource-lock creation adopts the same
effect in a follow-up commit once the concurrent lock-protocol change has merged.

## Context

The authority effects offered no way to create a file only when its path is absent and to make
it appear with its complete bytes:

- **Create-only records** were published by checking for absence and then renaming a staged
  file into place. Two writers of one record could both pass the check, and the second rename
  replaced the first record (#287).
- **Exclusive lock files** were created with `open(..., 'wx')` and then written, so a reader
  could see an empty or partial lock and had to treat it as held for a grace period.
- **The worktree registry** was replaced atomically, but its read-modify-replace was not
  serialized across processes. Two concurrent rounds could each read one registry and each
  replace it, losing an entry and letting live checkouts exceed the cap (#286).
- **The state root** `.devai/state` could be created by a writer that holds only state
  authority. Such a writer fsyncs directories at and below the root, never its entry in
  `.devai`, so a power loss could remove a new root together with records whose own files were
  fsynced (#293).

## Decision

1. **The effect.** `publishFileNoReplaceSync(path, data)` joins the guarded authority effects:
   - It writes the complete bytes to a fresh staged file beside `path`, named
     `.<name>.<pid>-<uuid>.publish-staged`, and fsyncs it.
   - It hard-links the staged file to `path`. link(2) fails with EEXIST when `path` exists, so
     nothing is ever replaced. On any failure the staged file is removed.
   - It unlinks the staged name and fsyncs the directory. A returned call is durable.
   - A failure after the link (the staged unlink or the directory fsync) is an indeterminate
     publication: the target holds the caller's complete bytes but durability is not
     established. The effect removes the staged name if it can and refuses with
     `AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE`, which the loop reports as
     `DURABLE_PUBLICATION_INDETERMINATE`. The caller owns what it published: a create-only
     writer never reports success, and a lock holder removes its own lock before refusing.
2. **Authorization.** The publication crosses the seam as one filesystem effect. The broker
   classifies it as a `create` of `path` alone, whether or not `path` exists, so it needs only
   the create permission and path domain that writing `path` already needs. The staged name
   lives in the same directory and is chosen by the effect, never by the caller, so it cannot
   alias another file. The direct-mutator inventory and the effects check now treat `link` and
   `linkSync` as host writes, so a raw hard link outside the seam is refused.
3. **Create-only records** (`writeCreateOnlyDurableSync`) publish through the effect and map
   EEXIST to `DURABLE_RECORD_EXISTS`. The activation lock publishes its complete owner record
   the same way.
4. **The worktree registry** is changed only under `.devai/state/worktrees.lock`, a lock
   published through the effect. Admission (the cap check, the checkout and the registry
   replace), retention, release, destruction and reaping all hold it, and the owner's release
   unlinks the lock and fsyncs `.devai/state`. A second writer waits up
   to 30 seconds and then refuses with `WORKTREE_REGISTRY_BUSY`. A lock whose owner ran on this
   host and is provably gone refuses with `WORKTREE_REGISTRY_LOCK_STALE` and names its removal;
   like the activation lock, it is never taken over automatically.
5. **The state root.** `init apply harness`, which holds workspace authority, creates
   `.devai/state` when it is missing, fsyncs `.devai`, and publishes
   `.devai/state/state-root.json`. When it created `.devai` itself, it first fsyncs the
   repository directory through `flushDirectoryEntrySync`, an exact flush exception: it opens
   the directory read-only without following a link, changes no bytes, and the
   direct-mutator guard admits it only in the state-root initializer, because the broker
   never targets the repository root itself. The marker carries no time or host, so an init
   replay reproduces the same tree, and a re-application keeps it. Only a regular file (not a
   symbolic link) holding exactly the marker bytes is valid. `round dispatch` refuses before
   anything else with `EXPERIMENTAL_STATE_ROOT_UNINITIALIZED` while the marker is absent and
   with `EXPERIMENTAL_STATE_ROOT_MARKER_INVALID` while anything else is at its path, and
   initialization refuses such a path with `INIT_STATE_ROOT_MARKER_INVALID`.

## Consequences

- Two writers of one create-only record can no longer replace each other, and no reader sees
  an empty or partial lock or record.
- Concurrent rounds share one worktree cap. A crash while holding the registry lock needs a
  person to remove the named file, as a stale activation lock already does.
- An adopter that adopted DEVAI before this record runs `init apply harness` once more before
  experimental dispatch. Nothing else changes for a repository that never dispatches.
- A crash between the link and the staged unlink leaves a hidden staged link to the complete
  record. It holds no partial bytes, and removing it is always safe.

## Alternatives Considered

- **Exclusive open of the target, then write.** Rejected: readers can see the empty or
  partial file, which is the defect for locks.
- **A rename that refuses to replace (renameat2 `RENAME_NOREPLACE`).** Rejected: Node.js does
  not expose it, and it is not portable to macOS; link(2) is.
- **Serialize the registry through the record-claim protocol.** Rejected for now: that protocol
  serves records replaced by observed identity, while the registry needs mutual exclusion
  across a whole read-modify-replace that includes a checkout.
- **Let dispatch fsync `.devai` itself.** Rejected: dispatch would need workspace authority
  over `.devai`, widening its declared path domains.

## Amendment: publication-bound identity removal (issue #317)

Proposed on 2026-10-06 for issue #317. It narrowly widens what the broker authorizes, and it
takes effect only with the Owner's sign-off.

- **The effect.** `removeEntryIfIdentitySync(path, identity)` joins the guarded effects. It
  renames the entry to a fresh private quarantine name beside it and checks that entry against
  the caller's identity (device, inode and birth time). It unlinks the entry, or removes it with
  a non-recursive rmdir, only on a match. Anything else is put back without replacing whatever
  holds the path by then; if the path is occupied, the entry stays in quarantine and the effect
  refuses with `AUTHORITY_REMOVE_RESTORE_INCOMPLETE`. The broker classifies it as a `delete` of
  the entry itself, resolving only the parent.
- **The widening.** In one invocation, a removal that names exactly the path and the identity a
  `publishFileNoReplaceSync` of that invocation returned is authorized against the target that
  publication was authorized for, and keeps the containment that publication established. It is
  admitted even when the file now resolves outside the repository because an ancestor was
  swapped for a link after the publication was authorized. Nothing else is widened: the removal
  can act only on an entry carrying that identity, which only that publication created.
- **Every other identity-bound removal** keeps repository containment. The broker pins the
  parent with a no-follow directory descriptor at effect time and checks the parent's realpath
  and identity immediately before and after the effect. On a mismatch it refuses with
  `AUTHORITY_REMOVE_PARENT_ESCAPED`. Node has no directory-relative rename, so an ancestor that
  is swapped and swapped back between those two checks remains a residual window.

## Affected Rules

As listed in the frontmatter, together with `packages/authority/src/boundaries/host-remove.ts`
and `packages/cli/src/authority/broker.ts` for the amendment above.

## Inspector Adversarial Acceptance

The five counterexamples in the frontmatter must fail against an implementation that omits
the corresponding rule and pass against the candidate. They run against constructed
interleavings and crash states in temporary directories; no provider runs.
