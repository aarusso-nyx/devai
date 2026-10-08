---
id: ADR-CHK-0007
title: The check runner executes independent plan nodes on a bounded worker pool and reports in plan order
type: adr
status: accepted
date: 2026-10-07
authority: Architect
supersedes: []
provenance:
  - ADR-CHK-0001
  - ADR-CHK-0003
  - ADR-CHK-0006
  - ADR-SCR-0010
  - packages/cli/src/services/check-runner/runner.ts
  - .github/workflows/pull-request-checks.yml
affected_rules:
  - packages/cli/src/services/check-runner/runner.ts
  - packages/cli/src/services/check-runner/runner-execution.ts
  - packages/cli/src/services/check-runner/types.ts
  - packages/cli/src/commands/check/facade.ts
  - law/schemas/test-task-descriptor.schema.json
  - law/schemas/test-task-exclusivity.schema.json
  - docs/adopters/test-tasks.md
inspector_acceptance:
  - IA-001 -- The same plan run with one worker and with four workers yields the same planned node set and, for every node in plan order, the same nodeId, taskKey, disposition, outcome, reason, exit code and signal, the same blocked list, the same receipt-or-refusal presence, and the same report exit code; the fixture includes a FAIL node, an extrinsic BLOCKED probe with a blocked-environment dependent, an ABORTED dependent of a FAIL, and a reused node.
  - IA-002 -- With an executor that records start and finish instants and finishes nodes in reverse plan order, no node starts before every one of its dependencies has a terminal outcome, and the execution array of the report is in plan order, not completion order.
  - IA-003 -- The number of node processes running at once never exceeds the effective worker count, and with one worker the start order equals plan order and no two nodes overlap.
  - IA-004 -- Two nodes where one holds exclusively a key the other holds in either list, a declared node and a node with no declaration, two nodes whose declared output paths are equal or one a path prefix of the other, and two nodes that both allowlist DEVAI_DB_URL never overlap in time, and the earlier one in plan order always starts first; two nodes that only share a key overlap, and with no test-task-exclusivity.json every plan runs one node at a time.
  - IA-005 -- A FAIL in one node does not cancel or shorten any running node, every independent node still starts, and only its dependents are recorded ABORTED with reason dependency-not-pass without being started.
  - IA-006 -- A node that waits in the ready queue longer than the per-task timeout still runs and is timed out only by its own timeout measured from its own start; the timeout default and the --task-timeout-ms flag are unchanged.
  - IA-007 -- --task-workers wins over DEVAI_CHECK_TASK_WORKERS; 0, 17, a fraction, or a non-numeric value from either source is refused with CHECK_RUNNER_WORKERS before any node starts; under --rc, --release-intent, or a protected execution identity the effective count is one, the environment value is ignored, and an explicit --task-workers above one is refused with CHECK_RUNNER_WORKERS.
  - IA-008 -- The plan document, every task key and input digest, the descriptor and task-policy digests, and the receipt are byte-identical for the same inputs whatever the worker count and whatever test-task-exclusivity.json declares, so neither is an input of reuse or attestation; an exclusivity file that fails test-task-exclusivity.schema.json or names a node the descriptor does not declare is refused before any node starts.
---

# Bounded parallel execution of check plan nodes

## Status

Accepted on 2026-10-07 by the Architect for campaign CMP-0007, round R-0701.
The Owner approved the CMP-0007 recommendations on 2026-10-07; decision D1
chooses in-runner parallel workers first and job sharding of `test:cli` only
if the gate median is still above 600 s afterwards. This record extends
ADR-CHK-0001: probes stay DAG nodes, the `BLOCKED` outcome and its
never-reusable rule are unchanged, and the local preflight stays the "ready
for a pull request" condition. It changes how the runner schedules the nodes
of a plan, never which nodes a plan holds or what verdict it reaches. No
invariant changes: INV-CORE-003 already requires a deterministic gate and
INV-CORE-004 the blocked-environment rule, and both hold under the rules
below. Scheduling declarations live in their own file,
`test-task-exclusivity.json`, and never in `test-tasks.json`. The
package-owned evidence verifier (1.9.0) reconstructs the RC policy from the
committed descriptor and refuses any task property it does not know
(ADR-CHK-0006), so the descriptor bytes, its digest, the task-policy digest,
release export, and certification are unchanged by this record.

Amended on 2026-10-07, before any release carried it, under the
coordinator's ruling on the review of CMP-0007. The first text put an
`exclusivityKeys` field into the descriptor, which the bundled verifier
would refuse. The conflict model is now the `exclusive` and `shared`
declaration of the separate file, and an undeclared node conflicts with every
node.

## Context

`packages/cli/src/services/check-runner/runner.ts` executes the planned nodes
one at a time in plan order. Over the 30 days to main 92526921 the
`pull_request` gate (the `harness_performance` sensor population, F5:T7) has
a median of 710 s against a target below 600 s. `test:cli` takes 58% of job
time with a median of 339 s and runs in 90% of plans, and most of the other
nodes depend only on `generate` or `build`, so they wait for one another
without sharing anything. Install, bootstrap and probes are about 25 s in
total. Replaying the measured node timings with `test:cli` in a lane beside
the rest gives a median of about 344 s; sharding `test:cli` into two jobs
with the rest serial gives about 432 s and needs a second job and an
aggregator. Running independent nodes concurrently inside the runner keeps
one job, one required check, and one report.

A failure does not stop a plan today. A node whose dependency did not pass is
recorded `ABORTED` with reason `dependency-not-pass`, a node downstream of a
`BLOCKED` probe is recorded `blocked-environment`, neither is started, and
every other node still executes. Parallel execution keeps exactly that rule.

## Decision

The check runner may execute independent nodes of one plan concurrently on a
bounded worker pool, under the following rules. Each rule is normative for
the implementation and its tests.

1. **Every planned node is accounted for.** The plan, its node set, and the
   selection that produced it are computed exactly as before. Every planned
   node receives exactly one execution entry. A node is started, reused,
   recorded `ABORTED`, or recorded `blocked-environment` by the same
   per-node rules as the sequential runner; no node is skipped, dropped, or
   started twice because of scheduling.
2. **Bounded worker count.** At most `W` node processes run at once. The
   default is `min(4, os.availableParallelism())`. The `--task-workers <n>`
   flag of `check --run` overrides the environment variable
   `DEVAI_CHECK_TASK_WORKERS`, which overrides the default. `n` is an integer
   from 1 to 16; any other value from either source is refused with
   `CHECK_RUNNER_WORKERS` before any node starts. `W = 1` is the sequential
   behavior of ADR-CHK-0001, byte for byte in the comparable projection of
   rule 9. The runner reads the variable itself; it is never passed to a
   task unless the task allowlists it.
3. **Release selections stay sequential.** Under `--rc`, `--release-intent`
   (both the preflight and the certify stage), or a protected execution
   identity, the effective worker count is 1. The environment variable is
   ignored there, and an explicit `--task-workers` above 1 is refused with
   `CHECK_RUNNER_WORKERS`. Widening parallel execution to receipt-bearing
   release runs needs a later record. A worker count above 1 is admitted
   only for `--affected`, `--preflight`, and `--local`. The probes inside one
   `preflight-v1` node keep their `depends_on` order within that node.
4. **Dependency ordering.** A node becomes ready only when every one of its
   dependencies has a terminal outcome (`PASS`, reused, `FAIL`, `ABORTED`,
   `BLOCKED`, or `blocked-environment`). Its disposition is then decided from
   those outcomes exactly as today: `blocked-environment` when any dependency
   is blocked, otherwise `ABORTED` with reason `dependency-not-pass` when any
   dependency did not pass, otherwise cache inspection with the dependency
   result digests, then execution. A ready node is admitted in plan order:
   among ready nodes that may start, the one earliest in plan order starts
   first.
5. **Shared-resource safety.** Scheduling declarations live in
   `test-task-exclusivity.json` beside `test-tasks.json`, validated by
   `law/schemas/test-task-exclusivity.schema.json`. The file maps a
   descriptor `nodeId` to `{ "exclusive": [...], "shared": [...] }`, each an
   array of distinct keys matching `^[a-z0-9][a-z0-9._-]*$`. `exclusive`
   names state the node mutates; `shared` names state it only reads. Two
   nodes conflict when any of these holds:
   - one holds exclusively a key that the other holds in either list;
   - either node has no declaration in the file, which is the safe default:
     an undeclared node conflicts with every node, so a repository without
     the file runs every plan one node at a time;
   - one declares an `outputContract.paths` entry or a
     `generated_namespaces` prefix that equals, or is a path prefix of, an
     entry or prefix the other declares;
   - both allowlist `DEVAI_DB_URL`.

   Conflicting nodes never run at the same time, and the one later in plan
   order does not start until the earlier one has a terminal outcome, so a
   shared output ends with the bytes the sequential order would leave. Any
   other shared resource a node uses (a fixed scratch directory, a port, a
   lock file) must be declared with a key; a wrong declaration is a defect
   of the file, not a scheduling choice. A file that fails its schema, or
   that names a node the descriptor does not declare, is refused before any
   node starts. The file is read by the runner only. It is never part of the
   descriptor, never read by the package-owned evidence verifier, and never
   an input of a task key, a digest, or a receipt (rule 10), which keeps
   release export and certification byte-identical to a run without it
   (ADR-CHK-0006).

6. **Deterministic report and evidence order.** The `execution` array of the
   report, the `blocked` list, the release verification entries, the receipt
   and the preflight receipt are assembled in plan order, never in completion
   order. Cache writes are per node or content-addressed and are unaffected by
   completion order. Live progress output on stderr may follow completion
   order and is not evidence.
7. **Per-task timeouts unchanged.** Each node keeps the per-task timeout of
   ADR-CHK-0001 (default 30 minutes, `--task-timeout-ms` override), measured
   from that node's own start. Time spent waiting for a worker or for a
   conflicting node is not counted. No plan-level timeout is introduced.
8. **No fail-fast.** A failure stops nothing today, and parallel execution
   adds no stop. A node that ends `FAIL`, `BLOCKED`, or timed out never
   cancels, signals, or shortens a running node, and the runner keeps
   starting every node whose dependencies allow it. Only the dependents of
   the failed node are recorded under rule 4 without being started. The
   runner waits for every started node to reach a terminal outcome before it
   attests and returns. A host error of the runner itself, which is not a
   node outcome, stops new starts, lets running nodes settle, and is then
   raised as it would be in the sequential runner.
9. **Gate guarantee.** For the same base, candidate, descriptor, toolchain,
   and cache state, a run with any admitted worker count yields the same
   planned node set and, node by node in plan order, the same comparable
   projection: `nodeId`, `taskKey`, `disposition`, `outcome`, `reason`,
   `exitCode`, and `signal`. It also yields the same `blocked` list, the same
   presence of a receipt or a refusal, and the same report `exitCode`. Only
   durations, timestamps, and the digests and paths derived from them may
   differ. A node whose own process is nondeterministic, or that interferes
   with another node through an undeclared resource, is a defect of that
   node, recorded to the backlog under ADR-GOV-0019, and never a reason to
   weaken this guarantee.
10. **Scheduling is not an input.** The worker count and the contents of
    `test-task-exclusivity.json` are absent from the plan, every task key and
    input digest, the descriptor digest, the task-policy digest, and the
    receipt. A cached result is reusable or not regardless of the worker count
    or declarations that produced it.

## Consequences

The pull-request gate keeps one job, one required check `devai-release-gate`,
and one report. Its duration approaches the longest dependency chain, which
`test:cli` dominates, instead of the sum of the nodes. Peak CPU and memory
rise with the worker count. A runner with tight resources sets
`DEVAI_CHECK_TASK_WORKERS=1` and gets the sequential behavior unchanged.
Tests that silently shared state while sequential become visible as conflicts
or flakes. Each one is fixed by a declaration in `test-task-exclusivity.json`
or by isolating the test, and a retry never hides it. An adopter gains
parallelism only by declaring its nodes; until then its plans run one node at
a time whatever the worker count. If the gate median is still above 600 s after
this lands, R-0701 shards `test:cli` under decision D1. Release runs keep
their current timing until a later record widens rule 3.

## Alternatives Considered

Sharding `test:cli` across CI jobs first is rejected for now under D1. It
needs an aggregator to keep one required check and does nothing for local
runs, but it remains the fallback. Completion-order reports are rejected
because they would make the report and the receipt depend on timing. Fail-fast
cancellation of running siblings is rejected because it would change the node
set that reaches a terminal outcome and hide independent failures that the
sequential runner reports. An unbounded pool is rejected because the large
vitest nodes already fan out internally and would oversubscribe the runner.
Inferring conflicts from file-system tracing is rejected because it is
platform-specific and not reproducible from the descriptor. A scheduling
field inside `test-tasks.json` is rejected because the package-owned
evidence verifier refuses unknown task properties when it rebuilds the RC
policy from the committed descriptor (ADR-CHK-0006), so it would break release
export until the verifier is re-vendored. Treating an undeclared node as free
to overlap is rejected because one missing declaration would let two writers
race silently.

## Affected Rules

- `packages/cli/src/services/check-runner/runner.ts`: the scheduler, ready
  queue, conflict rule, and plan-order assembly.
- `packages/cli/src/services/check-runner/runner-execution.ts`: concurrent
  execution of node processes under the per-task timeout.
- `packages/cli/src/services/check-runner/types.ts`: the worker count option
  and the exclusivity declaration type.
- `packages/cli/src/commands/check/facade.ts`: the `--task-workers` flag and
  the `CHECK_RUNNER_WORKERS` refusal.
- `law/schemas/test-task-descriptor.schema.json`: closed objects, so a
  scheduling field or a misspelled property in the descriptor is refused.
- `law/schemas/test-task-exclusivity.schema.json`: the closed schema of
  `test-task-exclusivity.json`.
- `docs/adopters/test-tasks.md`: the declaration file and the scheduling
  rules for adopters.

## Inspector Adversarial Acceptance

- IA-001 -- The same plan run with one worker and with four workers yields the same planned node set and, for every node in plan order, the same nodeId, taskKey, disposition, outcome, reason, exit code and signal, the same blocked list, the same receipt-or-refusal presence, and the same report exit code; the fixture includes a FAIL node, an extrinsic BLOCKED probe with a blocked-environment dependent, an ABORTED dependent of a FAIL, and a reused node.
- IA-002 -- With an executor that records start and finish instants and finishes nodes in reverse plan order, no node starts before every one of its dependencies has a terminal outcome, and the execution array of the report is in plan order, not completion order.
- IA-003 -- The number of node processes running at once never exceeds the effective worker count, and with one worker the start order equals plan order and no two nodes overlap.
- IA-004 -- Two nodes where one holds exclusively a key the other holds in either list, a declared node and a node with no declaration, two nodes whose declared output paths are equal or one a path prefix of the other, and two nodes that both allowlist DEVAI_DB_URL never overlap in time, and the earlier one in plan order always starts first; two nodes that only share a key overlap, and with no test-task-exclusivity.json every plan runs one node at a time.
- IA-005 -- A FAIL in one node does not cancel or shorten any running node, every independent node still starts, and only its dependents are recorded ABORTED with reason dependency-not-pass without being started.
- IA-006 -- A node that waits in the ready queue longer than the per-task timeout still runs and is timed out only by its own timeout measured from its own start; the timeout default and the --task-timeout-ms flag are unchanged.
- IA-007 -- --task-workers wins over DEVAI_CHECK_TASK_WORKERS; 0, 17, a fraction, or a non-numeric value from either source is refused with CHECK_RUNNER_WORKERS before any node starts; under --rc, --release-intent, or a protected execution identity the effective count is one, the environment value is ignored, and an explicit --task-workers above one is refused with CHECK_RUNNER_WORKERS.
- IA-008 -- The plan document, every task key and input digest, the descriptor and task-policy digests, and the receipt are byte-identical for the same inputs whatever the worker count and whatever test-task-exclusivity.json declares, so neither is an input of reuse or attestation; an exclusivity file that fails test-task-exclusivity.schema.json or names a node the descriptor does not declare is refused before any node starts.
