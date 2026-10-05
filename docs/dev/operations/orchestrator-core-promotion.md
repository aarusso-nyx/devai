---
title: Orchestrator core promotion design and acceptance
---

# Orchestrator core promotion design and acceptance

> The raw evidence these documents cite (receipts, logs, fixture output, manifests) is kept
> out of the repository; it is retained with the archived `orchestrator/s1-admission` branch.

## Decision and scope

Promote the standalone pilot in stages. The first local integration, **S1**, moves
deterministic task admission into `packages/loop` and makes the existing
`runRoundTasks` runner consume it. Execution stays serial and human initiated.
The pilot's private controller, provider processes, worktree ownership, journal,
review protocol, and integration branch are not copied into the supported harness.

This is a concrete core integration of the admission mechanism, not activation of
an autonomous controller. The supported action registry and existing authority,
resource acquisition, lifecycle, dispatch, and evidence boundaries remain in force.
No public action, consent flag, law schema, policy permission, model default,
release process, or historical record changes in S1.

The user authorized this design and bounded local integration on 2026-10-03.
Historically, S1 was implemented on the dedicated `codex/orchestrator-core-promotion`
branch, starting at commit `180a122787193f9bdfce9b7f4cd5600e85ae7854`; that branch is
superseded by the merged S1 to S4 history on `main` and is not a current reference.
The source pilot is read-only. Merge, publication, deployment, and live paid
provider invocations were outside the S1 integration scope.

The completed pilot delivery has source-population SHA-256
`5a3203c8b09b8edc7e52821a893ce11eb22352307f9cf69211169da3d121b37e`.
Its 117-test result, independent review, and bounded live workflow are useful
upstream evidence. They do not establish correctness of this core adapter.
The full live workflow preceded the final accounting repair; the later live probe
proved that repair separately. Pilot crash recovery, external host enforcement,
and universal provider-accounting guarantees remain partial.

## Canonical model and authority

The governing references are Constitution Articles 1, 3, 6–10, 18–19, 24–28,
35, 37–39, and 41; `law/policy/round-execution.json`;
`law/schemas/task.schema.json`; `law/schemas/task-execution-evidence.schema.json`;
ADR-GOV-0002; ADR-GOV-0023; ADR-CHK-0004; and ADR-MDL-0002.

| Pilot concept                      | Core representation                                                      | Promotion rule                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Private plan wave                  | Canonical `TaskRecord` owned by exactly one active round                 | No second queue or alternate task identifiers                                                  |
| Private round                      | Explicit `R-NNNN` round argument and active authorization                | Validate before resource acquisition                                                           |
| `dependsOn`                        | `upstream_task_id`, coupled group/position, and declared composite edges | Expand same-round closure; reject missing/cross-round/cyclic edges                             |
| Private checkpoint                 | Core persisted lifecycle state and exact execution evidence              | S1 requires `completed` before dependent dispatch; a successful callback alone is insufficient |
| Write scopes and resources         | Declared substrate/module pairs and existing runtime locks               | Pure admission metadata does not confer locks or path authority                                |
| Worker/review capacity             | Existing supported serial runner in S1                                   | No implicit parallelism or reviewer reserve in supported execution                             |
| Author and reviewer profiles       | Task discipline and explicit runtime/model resolution                    | Model capability never supplies governance authority                                           |
| Private trace/journal              | Canonical task-execution and governance evidence                         | No replay or mutation of historical core records                                               |
| Private integration/closure branch | Human ratification and existing serialized integration policy            | No automatic merge or production-readiness claim                                               |

There is one canonical task contract. The planner receives validated task records,
does not rewrite them, and has no filesystem or process effects. The live runner
continues to parse records and check active-round authorization. The planner cannot
grant consent, acquire resources, start a provider, write a task, ratify a gate, or
merge a branch.

## S1 interface and integration seam

The typed API is package-local core code, exported through `@devai-nyx/loop`.
The following shapes describe the contract; implementation may add internal
identity-binding fields without changing serialized law schemas.

```typescript
interface RoundTaskAdmissionNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly generation: number;
  readonly resourceKeys: readonly string[];
  readonly taskDigest: string;
  readonly executionContextDigest: string;
}

interface RoundTaskAdmissionPlan {
  readonly roundId: string;
  readonly orderedTaskIds: readonly string[];
  readonly tasks: readonly RoundTaskAdmissionNode[];
}

planRoundTaskAdmission({
  roundId,
  tasks,
  selectedTaskIds,
}): RoundTaskAdmissionPlan;

decideRoundTaskAdmission(plan, {
  taskId,
  tasks: liveTaskRecords,
  failedTaskIds,
  activeTaskIds,
}): { admitted: boolean; blockers: readonly string[] };
```

The implementation belongs in `packages/loop/src/loop/round-task-admission.ts`.
The planner replaces the runner's private graph/order logic. It derives explicit
dependencies and topological generation before sorting. The sort is generation
ascending, coupled authority position ascending (`architect`, `inspector`,
`engineer`), priority descending, then task identifier by UTF-8 byte order.
A newly unlocked higher-generation task cannot overtake an independent lower-
generation task because it has a greater priority.

Before each dispatch, the runner reads current task records and asks admission
again. A dependency that is failed, escalated, or cancelled blocks the dependent.
A dependency that remains `in_progress`, `checkpoint`, `pre_merge`, or
`awaiting_human_review` does not satisfy `completed_dependency_required`.
The runner does not change an upstream status to make a callback's `ok: true`
satisfy the dependency. Independent tasks may continue after a blocked branch when
the immutable population remains bound. Ordinary status changes and escalation
branch renames alone do not invalidate that population.

Initial and live storage reads use the existing record-classification API rather
than the convenience list that omits unsupported or invalid records. Any malformed
or unsupported stored task refuses execution with its exact classification error;
the invalid bytes remain intact and read/status APIs retain their historical
behavior. An unrelated invalid record cannot silently disappear from the execution
population and make a narrowed subset executable.

The existing `dispatch(task)` callback still validates and executes the immutable
request through the B3A boundary. The runner still acquires resources through
`startRoundTask`, persists its ordinary lifecycle transitions through `saveTask`,
and escalates according to existing services. Evidence identifiers returned by
dispatch retain their existing meaning; admission is not acceptance evidence.

Resource keys are canonical combinations of the task's declared substrate and
module. They support conservative resource-disjoint admission decisions. S1 does
not replace existing lock acquisition or prove that a shell can write only those
paths. In particular, metadata about all substrates does not establish a repaired
multi-substrate lock implementation. Serial execution avoids claiming unproved
concurrent resource containment.

`taskDigest` binds the requested record while excluding mutable lifecycle fields:
status, iteration count, spawn/completion times, branch/worktree identity, actual
diff, and iteration trail. Legitimate lifecycle progress cannot manufacture a
different executor request. The pure admission API has a fixed one-worker cap;
its optional active-task input models contention without enabling concurrency.

`executionContextDigest` separately binds the planned task's branch and worktree
identity. Admission checks this context for the current dispatch candidate before
resource allocation, so a stored ready task cannot redirect execution by changing
its branch or worktree between plan and admission. The subsequently authorized
resource allocation may assign context normally. An upstream task's legitimate
escalation branch rename does not block an independent task; context checks do not
turn ordinary lifecycle changes elsewhere into spurious request drift.

Tags remain part of the requested-record binding. `pauseTaskForRgr` adds the
reserved `rgr_pause:<id>` tag; this deliberately invalidates the current plan,
including independent tasks, until a human invokes a new plan against the new
population. S1 neither exempts all tags nor grants itself permission to replan or
resume paused work. This conservative reference-change boundary is distinct from
ordinary mutable lifecycle status and escalation context.

Preflight retains current errors such as `TASK_DEPENDENCY_MISSING`,
`TASK_COMPOSITE_CROSS_ROUND`, `TASK_COMPOSITE_CYCLE`, `TASK_ROUND_MISMATCH`, and
`TASK_NOT_READY`. `TASK_DEPENDENCY_NOT_COMPLETED` reports the repaired durable
prerequisite boundary. Duplicate records use `TASK_ID_DUPLICATE`; task drift,
malformed live records, and resource conflicts must be refused, with implementation
errors recorded in the acceptance evidence. S1 orders by declared coupled position
but does not infer discipline from that position or reject historical records merely
because discipline and position differ. A future semantic consistency rule would
need a separate compatibility assessment.

## Bounded implementation and proof

S1 changes only the typed orchestration kernel/adapter, its consumption in the
existing round runner, additive Inspector-owned tests, package exports, and this
Architect-authored documentation. It keeps the existing supported serial entry
point and does not import the pilot's standalone package or its dependencies.

The local proof uses a disposable adopter fixture with an explicit active round
and canonical tasks. An existing deterministic routine adapter executes literal
argv; canonical evidence is validated against exact task/executor/candidate
identity. The fixture explicitly performs any required task-completion transition
through the existing authorized service boundary. It must show actual execution
and evidence, rather than merely an `ok` callback. It also shows that an upstream
callback returning `ok` without durable completion cannot dispatch a dependent.

Independent Inspector counterexamples must fail on the baseline before the repair
and pass on the candidate. Run changed-file lint, affected type integrity,
focused loop/CLI/evidence tests, package exports/build checks, documentation
validation where affected, and `git diff --check`. Full RC coverage is a later
release gate, not a prerequisite for claiming this narrowly bounded local proof.
An Auditor assesses the exact resulting diff and evidence; its verdict recommends
readiness for review and does not authorize merge.

## Acceptance matrix

`PASS S1` means the local requirement has passing candidate evidence, as bound
below. `Deferred` means a later promotion gate; it cannot be inferred from S1 or
from the standalone pilot's proof.

| ID    | Requirement and counterexample                                                                                                            | Evidence required                                                                                                                                                                                                | Stage                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| CP-01 | Kernel is consumed by the existing core runner, not an orphan planner                                                                     | Runner calls the exported typed plan/admission functions; end-to-end core fixture executes                                                                                                                       | **PASS S1**                                         |
| CP-02 | Task/round identity is canonical; unknown, missing, duplicate, cross-round, malformed, and unsupported stored inputs fail before dispatch | Additive direct-kernel and runner counterexamples with zero dispatch/resource mutation on invalid plans; invalid bytes preserved and exact classification error retained                                         | **PASS S1**                                         |
| CP-03 | Full selected dependency closure rejects cycles and missing prerequisites                                                                 | Explicit selection imports only same-round prerequisites; missing/cycle fixtures refuse                                                                                                                          | **PASS S1**                                         |
| CP-04 | Generation precedes role/priority/identifier order                                                                                        | A high-priority newly unlocked generation-1 task cannot overtake remaining generation-0 work                                                                                                                     | **PASS S1**                                         |
| CP-05 | Coupled order is Architect → Inspector → Engineer                                                                                         | Reversed Inspector/Architect baseline counterexample; unrelated coupled groups remain independent                                                                                                                | **PASS S1**                                         |
| CP-06 | Only durable `completed` prerequisites unlock dependents                                                                                  | `ok: true` with persisted `in_progress` blocks downstream; failed/cancelled/escalated upstream blocks; unrelated branch continues only while immutable population remains bound                                  | **PASS S1**                                         |
| CP-07 | Admission reflects current inputs and the planned execution context rather than a stale plan                                              | Missing, changed, malformed, or wrong-round live records refuse; current candidate branch/worktree redirection refuses before allocation; normal allocation and upstream escalation context changes remain valid | **PASS S1**                                         |
| CP-08 | Resource planning is deterministic and conservative; no new parallel execution                                                            | Declared substrate/module keys and conflict tests; unchanged serial runner behavior and existing lock-ownership regressions                                                                                      | **PASS S1**                                         |
| CP-09 | Request, discipline, executor, and evidence bindings remain intact                                                                        | Existing B3A boundary/evidence regressions plus actual routine fixture with canonical binding validation                                                                                                         | **PASS S1**                                         |
| CP-10 | Registered action/consent and runtime activation defaults remain unchanged; historical records stay preserved and readable                | Action registry/policy/schema byte preservation, existing serial tests, no provider launches or new CLI commands                                                                                                 | **PASS S1**                                         |
| CP-11 | Changes preserve tests and pass affected hygiene                                                                                          | Additive counterexamples, focused test results, typecheck, changed-file lint, diff check, no skips/weakening                                                                                                     | **PASS S1**                                         |
| CP-12 | Local integration has exact independent review and reversible removal                                                                     | Auditor report bound to candidate; tested baseline behavior after restoring baseline source and sensor patches in a disposable checkout                                                                          | **PASS S1**                                         |
| CP-13 | Parallel runtime capacity, review reserve, and session mutexes enforce bounds                                                             | Same-generation disjoint execution, contention and reserve exhaustion tests with canonical lock/evidence integration                                                                                             | S2; reviewer reserve not implemented                |
| CP-14 | Core provider adapter uses exact registry selection and preserves authority                                                               | Explicit experimental policy/action consent, prompt hashes, resolved runtime identities, host-enforcement boundary tests, fresh review contexts                                                                  | S3 (ADR-MDL-0005; live probe passed)                |
| CP-15 | Durable restart is safe after every dispatch boundary                                                                                     | Fault injection before/after intent, process spawn, evidence append, completion and cleanup; uncertain work requires explicit disposition, never blind retry                                                     | S3; recorded dispositions in ADR-MDL-0007           |
| CP-16 | Usage accounting reports attributable observations and explicit unknowns                                                                  | Session cumulative-counter normalization, missing/regressed counters, cache inclusion/missingness and billing uncertainty, and budget overshoot tests                                                            | S3 (version-2 usage; missing never zero)            |
| CP-17 | Full governed controller has no alternate task queue or automatic human gate                                                              | Backlog/campaign materialization, role-pure sessions, ratification/merge separation, no remote effects without exact Owner consent                                                                               | S4 (ADR-GOV-0025; ratification separate from merge) |
| CP-18 | Core runtime can replace legacy components without losing behavior/evidence                                                               | Caller inventory, adopter compatibility fixtures, migration/rollback rehearsal, retained historical evidence, exact release gates                                                                                | S4; declarative retirement, legacy paths kept       |

## Later promotion stages

**S2: bounded concurrent admission.** Extend the same canonical API only after
multi-substrate/module locking, database/worktree identities, current-state drift,
controller exclusivity, and reviewer capacity have passing counterexamples.
The existing serial path remains available. No cross-round controller is enabled
until policy explicitly permits its population and capacity limits.

S2 landed in three slices on 2026-10-04. S2a locks every declared substrate and
module pair in canonical order, all-or-nothing, with a takeover that cannot remove
a fresh lock and renewal during dispatch. S2b gives each round one controller and
re-queues lock-denied tasks, escalating repeated denials. S2c adds the
`round-execution.json` capacity block (serial by default, `--workers` opt-in up to
`max_workers`) and a scheduler that overlaps only same-generation, resource-disjoint
tasks. Reviewer reserve stays with S3, where review steps become tasks; the
cross-round controller stays forbidden.

**S3: opt-in experimental execution.** Add a versioned F5 experimental execution
contract and explicit activation through registered action/consent boundaries.
Bind provider adapters to canonical requested/resolved executor records, governed
prompt composition, discipline restrictions, owned worktrees, and declared host
enforcement. Integrate restart and usage telemetry with core append-only evidence;
retain uncertainty instead of synthesizing PASS or precise billing. Human review
ratification and merge remain separate unless a later explicit governing decision
changes their contracts. This stage requires new concrete design and tests before
runtime activation; the current user instruction does not silently supply future
provider-call budgets or remote-effect consent.

S3 landed under ADR-MDL-0005 and ADR-MDL-0006 on 2026-10-04:

- the governed asynchronous process effect;
- the experimental-execution law;
- the dispatch journal;
- the prompt composer;
- the claude-cli and codex-cli adapters;
- `--experimental` consent with the Owner-only activation;
- the `round dispatch` engine.

The S3c live probe ran the packed CLI against a disposable adopter within the Owner's budget
(at most 8 provider runs and 1M tokens). A claude-cli Engineer task (`sonnet`) and a codex-cli
Inspector task (`gpt-6-sol`) each passed on the first attempt. Each wrote exactly its task's
file inside its own attempt worktree, journalled a complete chain, and ended
`awaiting_human_review` with experimental version-2 evidence. That evidence held all four
counters, and claude's provider-reported cost; codex reports no cost, so its cost is unknown.

The probe found five integration defects that the permissive-scope unit tests could not:

- authority batch bounds too small for the new actions;
- no policy rule for experimental attempt worktrees;
- no broker target for the exact agent CLI process;
- host user configuration (hooks and MCP servers) running inside attempts;
- cache reads and writes left out of the token budget.

All five were fixed on `main` before S3 closed; no published release carried them.

**S4: governed controller and legacy migration.** Map backlog, campaigns, rounds,
coupled tasks, integration, closure, and review onto canonical core identities.
Replace a legacy component only after its callers, durable state, compatibility,
and rollback have exact evidence. Do not delete the pilot or old implementation
because a new API compiles. Complete adopter and release gates independently;
local fixture success carries no production-readiness, merge, or publication
authority.

S4 landed under ADR-GOV-0025 on 2026-10-04:

- `campaign status` projects a campaign onto runtime state and names drift;
- `campaign materialize` writes an open round's tasks through the round task queue, with the
  policy mapping;
- `round ratify` records the Owner's or Architect's decision on reviewed work, separate from
  merge.

`campaign-execution.json` names these as the only materialization, projection and
ratification paths, and records external controllers as retired. Nothing was deleted: the
pilot stays archived, historical ledgers stay evidence, and hand-driven pull requests remain
valid. Rollback is withdrawing the activation and not calling the new actions; no stored
state migrates. All three actions ran end to end through the packed CLI against the S3c
fixture.

ADR-MDL-0007 closed three gaps the S4 review found on 2026-10-05:

- **Completion.** An accepted agent task completes through `task finish` with the
  ratification and merge evidence, and its attempt worktree is released. Merge stays a
  separate human act.
- **Recovery.** `round dispatch dispose` records the Owner's retry or escalation of
  uncertain or blocked work, and can quarantine a damaged journal. `round dispatch
deactivate` withdraws the activation with an audit record. Uncertainty now clears only
  through a recorded disposition.
- **Capacity.** The worktree cap follows `capacity.max_workers`, and retained worktrees hold
  no capacity.

## Rollback and stop conditions

The first slice adds no durable schema or migration. Restoring all S1 source,
exports, and fixture changes to the exact entry commit in a disposable checkout
restores the baseline supported runner; its existing focused tests verify this
reversible code change. Keep the new counterexamples separately as diagnostics:
they should still expose the baseline contract gaps. This is not an
automated revert of merged history. Keep the counterexample/evidence reports as
diagnostics, and use a new authorized corrective commit if the change later merges.

Stop this slice if it requires a constitution/policy permission expansion, public
CLI activation, provider calls, unrelated dependency changes, production state
migration, removal or weakening of existing sensors, main modification, or remote
effects. Report the exact boundary and finish unaffected local work. An incomplete
S1 requirement is an incomplete slice, not a waived gate.

## Candidate evidence and verdict

**S1 to S4 are delivered and the three orchestrator gaps are closed; promotion is not complete.**
The record stands as follows:

| Rows        | State                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP-01–CP-12 | S1. Passing local candidate evidence and an independent Auditor PASS, bound in [the local integration report](orchestrator-core-promotion-report.md) and its [independent review](orchestrator-core-promotion-independent-review.md).                    |
| CP-13       | Partial. S2 delivered bounded concurrent admission, all-or-nothing multi-substrate locks and one controller per round. The **reviewer reserve is not implemented**; `round-execution.json` records it as not applicable until review steps become tasks. |
| CP-14–CP-16 | S3 under ADR-MDL-0005 and ADR-MDL-0006, with fake-provider counterexamples and the bounded S3c live probe. ADR-MDL-0007 adds recorded dispositions, journal quarantine and the durability fixes.                                                         |
| CP-17       | S4 under ADR-GOV-0025: campaign projection, materialization through the single queue, and ratification separate from merge. ADR-MDL-0007 adds the completion path through `task finish`.                                                                 |
| CP-18       | **Declarative.** `campaign-execution.json` records external controllers as retired and nothing was deleted. No caller inventory, adopter migration or rollback rehearsal beyond the fixtures above has run, so this is not a replacement claim.          |

The raw evidence these stages cite (receipts, logs, fixture output, probe transcripts and
manifests) is kept outside the repository. This page and the decision records are the
in-repository account. The S1 report and review keep their original bindings: eight source
and test files under SHA-256
`0bd341193ff8f1df898f86d8722d279e0c7242c1d99e3659e41f3b9e3b7fe7da`, 87 Inspector and
76 Auditor focused tests, and 160 caller regressions. Later stages are evidenced by their
merged tests and the pull-request gate.

None of this is a production-readiness, release or merge claim. Experimental agent
execution stays non-promoting (ADR-MDL-0005 D-9). Release eligibility is decided only by
the release gates.
