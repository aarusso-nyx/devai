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
  - IA-002 -- A crash between the link and the staged unlink leaves the complete bytes at the target and a stray staged link that no `.json` reader lists, and a retry refuses rather than replacing the target.
  - IA-003 -- The publication crosses the authority seam as one filesystem effect that the broker classifies as a `create` of its target alone, inside the action's declared path domain; a refused effect applies nothing.
  - IA-004 -- Two worktree registry writers interleaved at the first one's checkout never exceed the worktree cap and never drop an entry; a lock left by a gone process on this host refuses as stale and is never taken over.
  - IA-005 -- `round dispatch` refuses with `EXPERIMENTAL_STATE_ROOT_UNINITIALIZED` before any lock until `init apply harness` has fsynced `.devai` and published the state-root marker, and a re-application keeps the first marker byte for byte.
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
   replace), retention, release, destruction and reaping all hold it. A second writer waits up
   to 30 seconds and then refuses with `WORKTREE_REGISTRY_BUSY`. A lock whose owner ran on this
   host and is provably gone refuses with `WORKTREE_REGISTRY_LOCK_STALE` and names its removal;
   like the activation lock, it is never taken over automatically.
5. **The state root.** `init apply harness`, which holds workspace authority, creates
   `.devai/state` when it is missing, fsyncs `.devai`, and publishes
   `.devai/state/state-root.json`. The marker carries no time or host, so an init replay
   reproduces the same tree, and a re-application keeps it. `round dispatch` refuses with
   `EXPERIMENTAL_STATE_ROOT_UNINITIALIZED` before anything else until the marker exists.

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

## Affected Rules

As listed in the frontmatter.

## Inspector Adversarial Acceptance

The five counterexamples in the frontmatter must fail against an implementation that omits
the corresponding rule and pass against the candidate. They run against constructed
interleavings and crash states in temporary directories; no provider runs.
