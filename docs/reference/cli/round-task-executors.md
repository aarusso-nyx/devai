# Rounds, tasks, and executors

A round is the governed container; a task is subordinate work; an executor is the declared
mechanism for attempting that work. These three layers stay separate so scheduling cannot invent
authority and execution evidence cannot rewrite the request it is meant to prove.

The complete executor-kind and agent-selection populations on this page are generated from
canonical schemas and policies. Narrative outside those blocks explains containment, operation,
and recovery without maintaining another enum.

## Ownership and containment

Every executable task:

- has one `R-NNNN` owner;
- is valid only while that same round is active;
- carries one governance `discipline`, which remains its authority source;
- carries exactly one immutable requested executor contract; and
- is selected for ordinary execution through `devai round run`.

Round validation and complete task-population validation happen before worktree creation, lock
acquisition, or executor dispatch. A direct hidden task command still requires `--round` and cannot
move a task across rounds or bypass the active-round check.

Read the container before running anything:

```sh
devai round status --round R-1000 --repo-root . --format json
```

## Plans, waves, and tasks

The Architect-owned round plan defines the authorized work and may group related task production
into waves. A wave is planning and coordination structure, not an executor kind, lifecycle state,
or grant of parallelism. Runtime dispatch is determined by the canonical task graph, resource
claims, active-round standing, and role order.

Use tasks for independently evidenced units of work. If work crosses authority paths, model it as
coupled role-pure tasks in the policy-declared order rather than one mixed-role task. A role change
requires a new session and commit boundary.

## Selection and dependency closure

`round run` accepts either the default all-ready selection or one or more explicit task IDs. In
both cases the runtime:

1. validates the complete selected population against the requested active round;
2. expands the mandatory same-round dependency closure;
3. rejects a missing dependency, a cross-round edge, or a cycle before dispatch;
4. schedules in the deterministic order declared by the round-execution policy; and
5. permits parallel dispatch only within a dependency generation whose resource claims are
   disjoint.

Implicit task independence is forbidden. Dependency edges can come from the task's upstream
reference, a coupled group position, or a composite executor's declared graph. A failed dependency
keeps its dependants blocked; an independent, resource-disjoint branch may continue.

Select one task deliberately:

```sh
devai round run --round R-1000 --task TASK-7001 --repo-root . --as-role engineer --write --format json
```

The example assumes the task exists, is ready, belongs to `R-1000`, and has Engineer discipline.
If any assumption is false, dispatch must refuse rather than reinterpret the request.

## Lifecycle and checkpoints

A new task begins in the policy-declared initial state and moves only through declared transitions.
The lifecycle distinguishes readiness, resource denial, active work, checkpoints, review,
pre-merge/merge, governed gaps, escalation, completion, and cancellation. Undeclared transitions
are contract errors, and timestamps must remain monotonic and evidenced.

Checkpoints preserve bounded progress without turning partial work into completion. A task paused on
a reference gap releases its locks, preserves the governed branch/evidence needed for repair, and
returns to scheduling only through a declared resolution transition. Terminal state is not inferred
from a process exit or a partial output.

The exact state machine is
[`round-execution.json#/lifecycle`](../../../law/policy/round-execution.json). Action lifecycle
vocabulary is a different concept; see [action lifecycles](./vocabulary.md#action-lifecycles).

## Resources and isolation

Resource claims are task data, not model suggestions. Before dispatch, the scheduler derives
canonical lock keys for the task's target substrate/module, database isolation identity, and
worktree. It acquires the complete set in canonical order or acquires none.

A conflict produces an evidenced lock-denied state and requeue; repeated conflict escalates for
human review. Locks are released at the policy-declared completion, escalation, gap, or cancellation
boundaries. The executor cannot expand a claim after resolution, and model capability cannot claim
a path, database, or worktree.

## Canonical executor-kind descriptors

Choose a kind by the work contract: deterministic registered action or shell-free argv,
provider-backed bounded reasoning, evidenced human checkpoint, or explicit same-round composition.
The generated descriptors below own the complete kind population and every per-kind field.

<!-- devai:generated-reference:start category="executor-kinds" -->

## Executor kinds

<!-- devai:generated-entry category="executor-kinds" id="routine" -->

### `routine` — Routine

- **Stable ID:** routine
- **User-facing label:** Routine
- **Purpose:** `routine` is one closed requested-executor branch; discipline, not executor kind, grants authority.
- **Population or projection:** All schema fields in `#/$defs/routineExecutor` plus the exact `routine` discriminator.
- **Prerequisites:** One active owning round and one schema-valid immutable requested executor contract.
- **Required external tools:** Only the registered action or literal shell-free argv tools.
- **Accepted inputs:** The exact `routine` task-schema branch; fields from other executor branches are rejected. Dispatch uses `--as-role <allowed-role>` or a live authority session plus `--write`.
- **Defaults:** No executor kind is inferred when the task omits its executor contract.
- **Output contract:** Requested executor remains immutable; resolution and completion are recorded separately in task-execution evidence.
- **Verdict semantics:** Incomplete, mismatched, cyclic, cross-round, timed-out, or unevidenced execution blocks completion.
- **Declared effect:** Derived from the requested work and its registered actions; executor kind grants no effect.
- **Consent flags:** Derived from the resolved action effects; executor kind supplies no consent.
- **Cost class:** `moderate`
- **When to use:** Use `routine` only when its closed execution contract matches the task.
- **When not to use:** Do not use it to bypass round containment, role authority, or evidence requirements.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai round run --round R-1000 --repo-root . --as-role owner --write --format json`
- **Canonical source:** [`law/schemas/task.schema.json`](../../../law/schemas/task.schema.json#/properties/executor)
- **Related workflow:** `round`

<!-- devai:generated-entry category="executor-kinds" id="agent" -->

### `agent` — Agent

- **Stable ID:** agent
- **User-facing label:** Agent
- **Purpose:** `agent` is one closed requested-executor branch; discipline, not executor kind, grants authority.
- **Population or projection:** All schema fields in `#/$defs/agentExecutor` plus the exact `agent` discriminator.
- **Prerequisites:** One active owning round and one schema-valid immutable requested executor contract.
- **Required external tools:** A rostered runtime adapter and provider/host preflight.
- **Accepted inputs:** The exact `agent` task-schema branch; fields from other executor branches are rejected. Dispatch uses `--as-role <allowed-role>` or a live authority session plus `--write`.
- **Defaults:** No executor kind is inferred when the task omits its executor contract.
- **Output contract:** Requested executor remains immutable; resolution and completion are recorded separately in task-execution evidence.
- **Verdict semantics:** Incomplete, mismatched, cyclic, cross-round, timed-out, or unevidenced execution blocks completion.
- **Declared effect:** Derived from the requested work and its registered actions; executor kind grants no effect.
- **Consent flags:** Derived from the resolved action effects; executor kind supplies no consent.
- **Cost class:** `external-dependent`
- **When to use:** Use `agent` only when its closed execution contract matches the task.
- **When not to use:** Do not use it to bypass round containment, role authority, or evidence requirements.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai round run --round R-1000 --repo-root . --as-role owner --write --format json`
- **Canonical source:** [`law/schemas/task.schema.json`](../../../law/schemas/task.schema.json#/properties/executor)
- **Related workflow:** `round`

<!-- devai:generated-entry category="executor-kinds" id="human" -->

### `human` — Human

- **Stable ID:** human
- **User-facing label:** Human
- **Purpose:** `human` is one closed requested-executor branch; discipline, not executor kind, grants authority.
- **Population or projection:** All schema fields in `#/$defs/humanExecutor` plus the exact `human` discriminator.
- **Prerequisites:** One active owning round and one schema-valid immutable requested executor contract.
- **Required external tools:** Not applicable unless the executor record declares a tool through a child or completion procedure.
- **Accepted inputs:** The exact `human` task-schema branch; fields from other executor branches are rejected. Dispatch uses `--as-role <allowed-role>` or a live authority session plus `--write`.
- **Defaults:** No executor kind is inferred when the task omits its executor contract.
- **Output contract:** Requested executor remains immutable; resolution and completion are recorded separately in task-execution evidence.
- **Verdict semantics:** Incomplete, mismatched, cyclic, cross-round, timed-out, or unevidenced execution blocks completion.
- **Declared effect:** Derived from the requested work and its registered actions; executor kind grants no effect.
- **Consent flags:** Derived from the resolved action effects; executor kind supplies no consent.
- **Cost class:** `moderate`
- **When to use:** Use `human` only when its closed execution contract matches the task.
- **When not to use:** Do not use it to bypass round containment, role authority, or evidence requirements.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai round run --round R-1000 --repo-root . --as-role owner --write --format json`
- **Canonical source:** [`law/schemas/task.schema.json`](../../../law/schemas/task.schema.json#/properties/executor)
- **Related workflow:** `round`

<!-- devai:generated-entry category="executor-kinds" id="composite" -->

### `composite` — Composite

- **Stable ID:** composite
- **User-facing label:** Composite
- **Purpose:** `composite` is one closed requested-executor branch; discipline, not executor kind, grants authority.
- **Population or projection:** All schema fields in `#/$defs/compositeExecutor` plus the exact `composite` discriminator.
- **Prerequisites:** One active owning round and one schema-valid immutable requested executor contract.
- **Required external tools:** Not applicable unless the executor record declares a tool through a child or completion procedure.
- **Accepted inputs:** The exact `composite` task-schema branch; fields from other executor branches are rejected. Dispatch uses `--as-role <allowed-role>` or a live authority session plus `--write`.
- **Defaults:** No executor kind is inferred when the task omits its executor contract.
- **Output contract:** Requested executor remains immutable; resolution and completion are recorded separately in task-execution evidence.
- **Verdict semantics:** Incomplete, mismatched, cyclic, cross-round, timed-out, or unevidenced execution blocks completion.
- **Declared effect:** Derived from the requested work and its registered actions; executor kind grants no effect.
- **Consent flags:** Derived from the resolved action effects; executor kind supplies no consent.
- **Cost class:** `expensive`
- **When to use:** Use `composite` only when its closed execution contract matches the task.
- **When not to use:** Do not use it to bypass round containment, role authority, or evidence requirements.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai round run --round R-1000 --repo-root . --as-role owner --write --format json`
- **Canonical source:** [`law/schemas/task.schema.json`](../../../law/schemas/task.schema.json#/properties/executor)
- **Related workflow:** `round`

<!-- devai:generated-reference:end category="executor-kinds" -->

## Canonical agent-selection descriptors

Agent execution must bind an available roster entry and one declared selection mode. The generated
descriptors own the complete mode population, accepted fields, defaults, costs, examples, and all
failure semantics.

<!-- devai:generated-reference:start category="agent-selection-modes" -->

## Agent selection modes

<!-- devai:generated-entry category="agent-selection-modes" id="exact" -->

### `exact` — Exact

- **Stable ID:** exact
- **User-facing label:** Exact
- **Purpose:** Require one runtime bridge and exact host model with no substitution.
- **Population or projection:** One registry_id plus one exact host model identity.
- **Prerequisites:** A schema-valid agent executor, a declared runtime bridge, an exact host model, and a successful host preflight.
- **Required external tools:** The adapter declared by the selected runtime entry and its provider or host preflight.
- **Accepted inputs:** Only the fields admitted by the `exact` agentSelection contract.
- **Defaults:** No model, runtime, effort, provider alias, or substitution is inferred.
- **Output contract:** Resolved executor identity is recorded separately from the immutable requested executor.
- **Verdict semantics:** The first unresolved, unavailable, capability, effort, adapter, or exact-identity mismatch blocks before provider invocation.
- **Declared effect:** Not applicable: a selection mode grants no action effect; the resolved task work declares effects separately.
- **Consent flags:** Not applicable: selection mode grants no consent; the resolved task actions enforce their own consent.
- **Cost class:** `external-dependent`
- **When to use:** Use `exact` when one exact runtime and model identity are intended.
- **When not to use:** Do not use it to infer authority, aliases, defaults, or model substitution.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai doctor --probe llm --repo-root .`
- **Canonical source:** [`law/schemas/task.schema.json`](../../../law/schemas/task.schema.json#/$defs/agentSelection/properties/mode/const)
- **Related workflow:** `round`

<!-- devai:generated-reference:end category="agent-selection-modes" -->

### Select exactly

Only the requested runtime bridge and exact host model identity may be considered. The first
runtime, model, effort, class, capability, availability, host-preflight, or adapter-identity
mismatch blocks before provider invocation.

```json
{
  "kind": "agent",
  "runtime": "codex-cli",
  "model": "gpt-5.6-sol",
  "effort": "high",
  "selection": {
    "mode": "exact",
    "registry_id": "codex-cli"
  }
}
```

Runtime capabilities and availability metadata are generated in the
[model/runtime reference](./model-runtime.md). Declared availability does not prove host
reachability; provider/session preflight and adapter-reported exact identity remain mandatory.

## Requested versus resolved execution

The task's `executor` object is the immutable request. The runtime binds it by canonical digest;
it does not copy the object into a mutable execution record. Resolution and observation live in a
separate task-execution-evidence record.

That record binds the task, round, candidate, task digest, and requested-executor digest, then
records the resolved executor or argv, adapter/tool versions, input/output digests, exact selection,
prompt identity, usage/cost where applicable, timestamps, verdict, failure disposition, and
evidence references. Selection evidence includes what was requested, what was selected, and any
rejection codes.

An exact mismatch or incomplete record blocks completion. If the request must change, create a new
governed request; never mutate the old requested executor in place or silently retry another model.

Canonical contract:
[task schema](../../../law/schemas/task.schema.json),
[task-execution-evidence schema](../../../law/schemas/task-execution-evidence.schema.json), and
[model runtime registry](../../../law/policy/model-runtime-registry.json).

## Authority stays with discipline

Executor kind, runtime, model, effort, skill, capability, and selection result answer how a task may
be attempted. They do not answer who may change a path. The task's discipline, the repository's
role/path policy, the resolved effect, and explicit consent remain authoritative.

An executor resolved to a more capable model does not gain additional filesystem, database,
publication, or remote authority. A deterministic routine is not automatically read-only. A human
checkpoint supplies evidence but cannot ratify outside that human role. See
[authority and effects](./authority-effects.md).

## Failure and recovery

- **Selection failure:** unavailable, mismatched, or exhausted allowed selection stops before
  invocation. Preserve the evidence and amend work only through a new governed task request.
- **Executor failure or timeout:** stop the dependent branch. Agent retry is bounded by the
  task's iteration limit; a human timeout follows its declared block/escalate behavior.
- **Malformed, unknown, or partial output:** treat it as error or diagnostic-only output, never
  completion.
- **Resource conflict:** requeue after lock denial; repeated conflict escalates for human review.
- **Reference gap:** preserve the branch and evidence, release resources, and resume only after the
  governed gap transition.
- **Rollback:** there is no automatic remote rollback and no destructive reset. An unmerged batch
  is abandoned or explicitly reverted; merged work needs a newly authorized revert. Composite
  compensation is reverse dependency order and only through an explicit registered action.

Aggregate task output follows the [verdict contract](./vocabulary.md#verdicts). Failure evidence is
retained even when rollback succeeds.

## Hidden task plumbing

Expanded help exposes low-level task operations for orchestration and advanced automation:

```sh
devai catalog actions --format json
```

This is inspection, not an ordinary workflow recommendation. Plumbing retains the same round
argument, containment, authority, effect, consent, output, and lifecycle checks. Operators should
prefer `round status`, `round assess`, `round gap ...`, and `round run`.

## Nonclaims

Successful task dispatch proves only the recorded execution attempt and verdict for its bound
candidate. It does not by itself close the round, publish evidence, establish release eligibility,
or authorize deployment.

Canonical sources: [round execution policy](../../../law/policy/round-execution.json),
[task execution schema](../../../law/schemas/task-execution-evidence.schema.json).
