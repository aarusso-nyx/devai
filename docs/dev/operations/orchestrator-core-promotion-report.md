---
title: Orchestrator core promotion local integration report
---

# Orchestrator core promotion local integration report

> The raw evidence these documents cite (receipts, logs, fixture output, manifests) is kept
> out of the repository; it is retained with the archived `orchestrator/s1-admission` branch.

The bounded S1 integration promotes deterministic admission into DEVAI core's
existing `runRoundTasks` runner. It remains serial and human initiated. The
[design and acceptance matrix](orchestrator-core-promotion.md) distinguish this
completed local slice from later concurrency and experimental-controller stages.

The eight executable source/test files have aggregate SHA-256
`0bd341193ff8f1df898f86d8722d279e0c7242c1d99e3659e41f3b9e3b7fe7da`,
bound in the retained
candidate manifest.
The final delivery manifest
binds the ten-file source/design population to SHA-256
`b2ad4585fd251a9822ca46e4b71f8b790416668fd43545c067d894cf55f0987d`;
its executable eight-file digest is unchanged.
The work starts at `180a122787193f9bdfce9b7f4cd5600e85ae7854` on
`codex/orchestrator-core-promotion`.

Admission now validates the full canonical round graph, orders entire topological
generations before role/priority/identifier tie-breaking, and uses the canonical
Architect → Inspector → Engineer order. A callback reporting success cannot unlock
a dependent until the upstream record is durably `completed`. The runner refuses
malformed/unsupported storage, changed requests, and candidate branch/worktree
redirection. It retains existing authority, dispatch, lock, lifecycle, and evidence
boundaries. RGR pause tags conservatively require a new human-invoked plan.

The verification summary
records 56 additive tests, Inspector's 87/87 focused checks, Auditor's 76/76 focused
checks, and 160/160 caller regressions. These suites overlap and are not additive
counts. Affected project compilation, all repository test types, source/test lint,
action-registry views, error-code references, formatting, and diff checks passed.

The durable routine proof
executed literal routines through the existing core adapter in two disposable
repositories. Verification alone left the upstream at `merging` and correctly
blocked its dependent. An explicit completion through the existing service then
unlocked and executed both tasks. Three exact task-execution receipts, four task
records, and both round results are retained beside that proof. No provider was
called and the source checkout was not the runtime target.

The rollback rehearsal
passed 76 candidate tests, restored the exact baseline source and fixtures in a
disposable checkout, and passed 25 baseline checks. The Auditor independently
passed 19 baseline regression checks. This proves reversible source removal; it
does not establish production-state rollback, and restores the known baseline
admission defects as well.

The final independent-review verdict is recorded separately in
[the review report](orchestrator-core-promotion-independent-review.md).

Remaining boundaries are explicit: there is no global controller exclusivity,
existing F2-only lock acquisition is unchanged, and external shell containment is
not proved. Concurrency, provider execution, durable controller recovery, full
usage/billing guarantees, and governed-controller migration are deferred. The
action registry, law policies/schemas, runtime defaults, historical records, and
root dependencies were not changed. No commit, provider call, remote effect,
release, or deployment occurred.

Evidence under the sibling evidence directory is a byte-preserved local diagnostic
copy, not a new canonical governance ledger or readiness authorization.
The artifact map binds
original temporary paths to retained relative copies and hashes. The operational
report and evidence population are excluded from their source-manifest identity to
avoid self-reference.

The Auditor final documentation rebind is PASS for the final ten-file source/design manifest with unchanged executable bytes. No additional execution proof or test rerun is claimed for these documentation-only amendments.
