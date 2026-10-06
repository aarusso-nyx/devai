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

The Architect declares a complete task as schema-valid JSON under the governed round. The Engineer
materializes it through the queue boundary before starting it:

```sh
devai task queue add --round R-1000 \
  --input work/rounds/R-1000/inputs/TASK-7001.json \
  --repo-root . --as-role engineer --write --format json

devai task start --round R-1000 --task TASK-7001 --with-worktree \
  --repo-root . --as-role engineer --write --format json
```

`--input` is mutually exclusive with the legacy title, priority, and description flags. The input
must stay under the repository, validate against `task.schema.json`, belong to the requested active
round, and begin in `queued`. If a title-only queue item with the same ID already exists, the input
may enrich it only when title, priority, description, and creation time agree. Replaying identical
materialization returns the same task; conflicting queue or task bytes fail closed.

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

A denied task returns to `ready` with its priority raised by one and reports
`TASK_RESOURCE_LOCK_DENIED`; the third consecutive denial escalates it with
`TASK_RESOURCE_LOCK_DENIED_REPEATED`. The runner renews a task's locks while its executor runs, and
a lock displaced during execution fails the attempt with `TASK_RESOURCE_LOCK_LOST`.

A dispatch that leaves its task waiting outside any dispatch (`merging`, `awaiting_human_review`,
`pre_merge`, `checkpoint` or `experimental_blocked`) renews its locks once more with a seven-day
waiting lease instead of the one-hour dispatch TTL, because nothing renews a waiting task. The
lease stays bounded, so an abandoned task does not hold its modules forever. Exact ownership is
proven before every completion. `task finish` refuses with `TASK_RESOURCE_LOCK_LOST` before it
writes anything when a key the task declares is missing or held by another task, and `round ratify
--decision accept` refuses the same way, including when it retries an acceptance it already
recorded. Each of these checks renews in place any own record with less than five minutes left,
expired ones included, so no takeover can land before the step completes. An accepted task gets
the waiting lease again. The completion itself (`completeTask`) checks once more right before it
persists. If that final check still refuses a human task, the task is escalated instead of being
left in `merging`, which it could not finish from. A record that outlived its lease without anyone
taking it still counts as held.

When a routine's process group cannot be confirmed gone (`PROCESS_GROUP_TERMINATION_UNCONFIRMED`),
the task is escalated but its locks are kept. The runner first writes
`.devai/state/lock-quarantine/<task id>.json` durably, naming the process group leader's pid, the
evidence id and the held keys. While that record stands, nothing releases the task's locks, not
the escalation and not a later run's reconciliation. They lapse by their TTL. Removing the
record, once the group is known to be gone, is the explicit human release. If the record itself
cannot be written, the attempt fails with `TASK_LOCK_QUARANTINE_UNPERSISTED` and the runner does
not escalate the task. It stays `in_progress`, holding its locks until their TTL lapses, for
explicit human disposition.

One `round run` controls a round at a time. A second run of the same round refuses with
`TASK_ROUND_CONTROLLER_BUSY` while the controller in `.devai/state/round-runs/<round>/controller.json`
is alive or ran on another host. A controller left by a dead process on the same host is reclaimed;
the tasks it left `in_progress` stay there for explicit human disposition, because only `ready`
tasks are dispatched.

Lock and controller records change only under a claim on the exact record read (kept in
`.devai/state/lock-claims/` and the round's `controller-claims/`), so a stale reaper or a late
renewal stands down instead of displacing a newer holder. A claim whose claimant provably stopped
(a dead pid on this host, or a reboot since) is broken by one writer at a time, and a live claimant
is never displaced; a claim older than ten minutes that nothing proves abandoned (a live pid, another
host, or an unreadable claim) refuses with `TASK_RECORD_CLAIM_STALE`, naming the file to remove once
no process there is still at work. A lock lost during execution fails the attempt with
`TASK_RESOURCE_LOCK_LOST` whatever status the executor left, a completion included, and escalates
the task instead of letting it merge. Each dispatch attempt is fenced, durably, under
`.devai/state/lock-fences/`, so every run first reconciles the attempts a stopped runner left
unjudged and reports a lost lock among them under `reconciled`; a fence nobody can read refuses
the run with `TASK_LOCK_FENCE_INVALID`, naming the file to repair. Release receipts are fsynced
with their directory entry, so a power loss cannot turn a clean release into a lost one. A run
also removes the receipts that no standing fence names, which a stop between retiring a fence and
its receipts leaves behind. Every run also applies the priority
bump a re-queue still owes; an all-ready run re-queues tasks an interrupted denial left in
`lock_denied`. A corrupt `lock-denials.json` refuses with `TASK_LOCK_DENIAL_STATE_INVALID`: repair
the entry, or remove the file to reset every count.

## Bounded concurrency

`round run` is serial by default. `--workers <count>` opts one invocation into bounded concurrent
dispatch, up to the `capacity.max_workers` ceiling of `law/policy/round-execution.json`; a count
outside 1 to that ceiling refuses with `TASK_WORKER_CAP_INVALID` before any task is touched.
Admission still follows plan order. A task joins the tasks in flight only when it is in the same
topological generation as all of them (`TASK_GENERATION_BARRIER` otherwise) and shares no lock
key with any of them (`TASK_RESOURCE_CONFLICT`); a blocked task waits for an in-flight task to
finish instead of failing. With one worker the behavior is the serial runner, task for task.

Routine executors run their argv through the governed asynchronous process effect
(ADR-MDL-0005 D-10): the process is authorized before it starts, bounded by the task's
`timeout_ms`, stopped as a whole process group when it overruns, and its output retained up to
1 MiB per stream, keeping the newest bytes. Concurrent routine tasks therefore overlap. An
overrun sends SIGTERM to the group and, after a grace period, SIGKILL to every member still
alive, descendants included; it fails the task with `TASK_ROUTINE_TIMED_OUT` even when the
routine traps the signal and exits 0. If the group, or a process holding its output, is still
there 5 s after SIGKILL, the termination is never reported as done: the task fails with
`PROCESS_GROUP_TERMINATION_UNCONFIRMED` instead, because the routine may still be running, and
its resource locks stay quarantined (see Resources and isolation).
Database and worktree identities
are per task (`devai_task_<task id>`, `WT-<task id>`), so two distinct tasks never contend for
them. There is no cross-round controller.

The reviewer reserve (`capacity.review_reserve`, ADR-MDL-0009) keeps one worker for review work.
While an Inspector or Auditor task of the same topological generation is ready, unblocked and
waiting, implementation tasks may hold at most the run's workers minus one; review tasks may use
every worker. Admission refuses an implementation task over that share with the waitable
`TASK_WORKER_CAP`, so it starts once a worker frees up. A serial run is unreserved, and a
reserve with no admissible review task waiting idles nothing: a review task blocked by a
resource conflict, an unfinished dependency or a failure holds no worker.

An agent task that derives no lock key, such as a materialized campaign task, never runs beside
another agent task, and no agent task runs beside it (`resources.keyless_agent_tasks`); the
later one waits with `TASK_RESOURCE_CONFLICT`.

Managed worktrees are capped per host at `capacity.max_workers` (ADR-MDL-0007), so every worker
the policy admits can hold its worktree. A worktree kept after its attempt settles, for review or
for a human disposition, holds no capacity. Neither does a worktree left by an attempt process that
is provably gone. Human-adopted worktrees are exempt as before (Constitution Article 27).

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
- **Example:** `devai round dispatch --round R-1000 --repo-root . --as-role owner --write --experimental --format json`
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
  "model": "gpt-6-sol",
  "effort": "high",
  "selection": {
    "mode": "exact",
    "registry_id": "codex-cli:gpt-6-sol"
  }
}
```

`selection.registry_id` is the `runtime:model` registry id form the router derives and compares:
the runtime id from the registry, a colon, and the exact host model identity, so
`codex-cli:gpt-6-sol` for the request above. A `registry_id` that differs from that string is a
`TASK_REGISTRY_IDENTITY_MISMATCH` before any provider is contacted.

A campaign task obtains its model identity from its pinned tier map rather than from a prompt.
[`law/policy/model-tiers.json`](../../../law/policy/model-tiers.json) maps each tier (`architect`,
`worker-high`, `worker`, `clerk`) to one alias per host: `fable`, `opus`, `sonnet`, and `haiku`
resolve through `claude-cli`; `gpt-6-astra`, `gpt-6-sol`, and `gpt-6-luna` through `codex-cli`. At
task start the merged map is pinned on the task in this same `runtime:model` form, for example
`claude-cli:fable`; see the
[campaign guide](../../dev/operations/workflow-economy-campaign/README.md#models-effort-and-time).

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

## Experimental agent dispatch activation

Agent tasks run only under experimental policy (ADR-MDL-0005). The Owner first records an
expiring activation:

```bash
devai round dispatch activate --input activation.json --repo-root . --as-role owner --write --experimental --format json
```

The input follows `law/schemas/experimental-activation.schema.json`: the exact runtimes,
models, and efforts, the `engineer` and `inspector` disciplines it admits, and budgets within
`law/policy/experimental-execution.json`. The action refuses an invalid, expired, or
over-long activation (at most 30 days) and any budget above a ceiling, leaving an earlier
activation untouched. It writes only `.devai/state/experimental/activation.json`
(ADR-MDL-0006); nothing under `.devai/config` is read as an activation.

`--experimental` is a consent flag like `--publish`: an experimental action refuses without
it with `AUTHORITY_EXPERIMENTAL_CONSENT_REQUIRED`, and every other action refuses it.

## Experimental agent dispatch

```bash
devai round dispatch --round R-0012 --repo-root . --as-role architect --write --experimental --format json
```

`round dispatch` runs the round's ready agent tasks, or the `--task` selection, under the
in-force activation. Before any lock, worktree, or provider is touched it refuses:

- an absent or expired activation;
- any task in the selection's whole same-round dependency closure, exactly as the runner will plan
  it, whose discipline, runtime, model, effort, or exact selection the activation does not admit;
- an effort the runtime registry does not list for its runtime;
- a runtime whose own sandbox cannot confine writes to the attempt worktree on this host
  (`EXPERIMENTAL_SANDBOX_UNAVAILABLE`, ADR-MDL-0008);
- a round with uncertain work (`TASK_DISPATCH_UNCERTAIN`).

Uncertain work is an attempt with `intent` but no `settled`, whatever the task status, or an agent
task left `in_progress` with no journal record. The refusal names each such task and attempt, and
the round stays blocked until a recorded human disposition (see
[recovering experimental work](#recovering-experimental-work)).

Each task composes its prompt (Article 37) from four layers: the adopter's `AGENTS.md`, the
discipline's role charter, the task record, and the task's recipe as the payload. A task without
`recipe_name` refuses with `PROMPT_RECIPE_REQUIRED`. The prompt must still match its bound
`prompt_composition_id`, or the task is refused with `TASK_PROMPT_COMPOSITION_DRIFT`. It then runs up
to three attempts at the requested model and one at the next tier of
`law/policy/model-tiers.json` when the activation also admits that model, bounded by the task's
`max_iterations` and the activation budgets. Attempts are numbered for the task's lifetime, so a
retried task continues its ladder. Every attempt runs in a fresh worktree `WT-<task>-A<n>`, bound
to the task, and is journalled from `intent` to `settled`.

An attempt fails when:

- Article 6 does not give the task's discipline a changed path
  (`EXPERIMENTAL_WRITE_SCOPE_VIOLATION`);
- a changed path lies outside the task's declared boundary, `intent_diff.planned_files`, where
  an entry ending in `/` admits the paths under it (`EXPERIMENTAL_BOUNDARY_VIOLATION`,
  ADR-MDL-0009); a task with no declared boundary is bounded by its role alone;
- it leaves a symbolic link resolving outside the worktree (`EXPERIMENTAL_SYMLINK_ESCAPE`); a base
  tree holding one refuses before any provider starts;
- the task lost a declared lock before its result could be accepted (`TASK_RESOURCE_LOCK_LOST`).

Its evidence carries `experimental: true`, version-2 usage, and a `sandbox` object naming the
provider-enforced write confinement and its exact flags once the provider started. The task's
outcome and worktree binding are saved before the attempt settles:

- A contained, completed attempt leaves the task `awaiting_human_review`, with its worktree
  retained for review.
- A failed attempt's worktree is removed when the next attempt starts; its changed-file digests
  stay in the evidence.
- An exhausted ladder or budget ends the task `experimental_blocked`, with the last failed
  attempt's worktree retained and bound to it.
- A task that could not start any attempt, because a budget ran out or its worktree could not be
  prepared, stays `ready`. It keeps its locks, which `release_on` frees only on completion,
  escalation, a gap pause or cancellation; the next dispatch reuses them.

Once a provider leaves any token counter unreported, cache counters included, no further attempt
in the invocation may spend (`EXPERIMENTAL_USAGE_UNVERIFIABLE`). A failure after a provider
started leaves the attempt uncertain and the task `experimental_blocked`, with the worktree kept.
Nothing is pushed, merged, or retried automatically.

A provider starts with an allowlisted environment, never the host's. It gets only `PATH`,
`HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, the proxy and CA variables,
and its own `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, so it runs on its stored login while tokens such
as `GH_TOKEN` and cloud credentials stay out. Only a single explicit terminal event in a stream
read whole completes an attempt: a stream that outgrew its retained bound or carries a line
that is not a JSON object fails with `AGENT_CLI_OUTPUT_TRUNCATED` or `AGENT_CLI_OUTPUT_MALFORMED`.
If the journal cannot record a started provider, its process group is stopped before the attempt
fails with `AGENT_CLI_SPAWN_RECORD_FAILED`. A provider stopped at its wall clock whose process
group cannot be confirmed gone fails with `PROCESS_GROUP_TERMINATION_UNCONFIRMED`, an error
after spawn, so the attempt stays uncertain and keeps its worktree.

## Completing agent work

An accepted agent task completes through the registered path (ADR-MDL-0007):

1. `round ratify --round <round-id> --task <task-id> --decision accept --as-role owner --write`
   moves the reviewed task to `pre_merge`.
2. A human integrates the attempt's changes from its retained worktree. Merge stays a separate
   human act; record it as evidence, for example with `evidence record`.
3. `task finish --round <round-id> --task <task-id> --evidence <EV-id> --as-role engineer --write`
   records the completion.

`task finish` holds the round controller for an agent task, so it refuses with
`TASK_ROUND_CONTROLLER_BUSY` while another holder owns the round, and it re-reads the task under
the controller. It refuses an agent task with no accepted ratification
(`TASK_RATIFICATION_REQUIRED`), with no `EV-` merge evidence (`TASK_MERGE_EVIDENCE_REQUIRED`), or
with an open journal attempt (`TASK_DISPATCH_UNCERTAIN`).

Every `--evidence` reference must resolve to a valid record in `record/proofs/chain.json`, read
with the same chain reader the `evidence` commands use. One loaded snapshot of the whole chain
must pass the evidence package's chain verification, and the references resolve against that same
snapshot: every record's manifest hash recomputes, each record links to its predecessor, and the
head names the last record. Each referenced record must also satisfy the
evidence schema. Proof-line anchors are not re-resolved, because that needs the anchor baseline
that `evidence verify --scope chain` keeps. A missing, unreadable or broken chain, a reference the
chain does not hold, or a referenced record that fails the schema refuses with
`TASK_MERGE_EVIDENCE_REQUIRED`. These checks and the ratification check first run before
anything is written, including a lock renewal, so a refusal at that point writes nothing. They
run again under the round controller after the locks are secured. If the chain or the
ratification changes in between, that second check can refuse after a lock was renewed; the
renewal is then the only write.

A record binds to the task only through what it names: a non-null `context.task_id` must be the
finished task, and every `round_id=<round>` note must name the task's round. A record that names
neither is accepted unbound, because the evidence writers do not stamp a task. The binding is
best-effort against a hand-edited chain: the manifest hash does not cover `context.task_id` or
the notes, so an edit to either leaves the chain verifiable.

A retry after an interruption needs the same `--evidence` again. From `pre_merge` it reuses an
identical completion record. From `merging`, after the worktrees were released, the completion
record must still exist and be complete, with every field present and correctly typed. It must
also bind the current ratification bytes and name exactly the given
references, which must still resolve; otherwise it refuses with `TASK_COMPLETION_CONFLICT` or
`TASK_MERGE_EVIDENCE_REQUIRED`.

On completion it writes
`.devai/state/round-runs/<round>/completions/<task>.json`, binding the ratification digest and
the merge evidence. It then moves the task through `merging` to `completed` and releases the
attempt worktree; the branch is kept. A rejecting ratification or `task escalate` on an agent task
releases its worktree too. Routine and human tasks complete exactly as before.

## Recovering experimental work

Every recovery action is Owner-only and needs `--write` and `--experimental`. Each writes a
durable record before it changes anything else, and none runs a provider.

```bash
devai round dispatch dispose --round R-0012 --task TASK-0040 --as retry --repo-root . --as-role owner --write --experimental --format json
devai round dispatch dispose --round R-0012 --quarantine-journal --repo-root . --as-role owner --write --experimental --format json
devai round dispatch deactivate --repo-root . --as-role owner --write --experimental --format json
```

- **`round dispatch dispose --task <task-id> --as retry|escalate`** holds the round controller, so
  it refuses with `TASK_ROUND_CONTROLLER_BUSY` while a dispatch owns the round. It disposes of one
  agent task with an open journal attempt, an attempt a quarantined journal left open, left
  `in_progress`, or `experimental_blocked`.
  - It writes `.devai/state/round-runs/<round>/dispositions/<DSP-id>.json`, then closes each open
    attempt with a `settled` event of outcome `cancelled` naming that record. Last, it writes a
    `<DSP-id>.applied` marker.
  - It releases the task's attempt worktrees. Locks follow `release_on`: a retried task keeps
    them and an escalated one releases them.
  - A retry returns the task to `ready`; escalate escalates it.
  - A retry refuses once the task's ladder is spent (`DISPOSITION_ATTEMPTS_EXHAUSTED`): a further
    try is a new task.
  - A disposition interrupted before its marker blocks the round. Issuing the same disposition
    again resumes it; a different one refuses with `DISPOSITION_INCOMPLETE`.
- **`task escalate`** on an agent task also takes the round controller, refusing with
  `TASK_ROUND_CONTROLLER_BUSY` while a dispatch owns the round. It records a disposition when the
  task has open or quarantined attempts, or is still `in_progress`.
- **`round dispatch dispose --quarantine-journal`** handles a damaged journal, which otherwise
  refuses every dispatch with `TASK_DISPATCH_JOURNAL_INVALID`. It writes a disposition record,
  then moves the journal aside byte for byte as `dispatch-journal.quarantined-<sha256>.jsonl`. The
  next dispatch starts a fresh chain. A readable journal refuses (`TASK_DISPATCH_JOURNAL_VALID`).
  The record lists every attempt the damaged journal leaves open: those its verifiable prefix
  does not settle, and any named only after the damage. Each keeps blocking the round, whatever
  its task's status, until that task gets its own disposition.
- **`round dispatch deactivate`** writes a withdrawal record under
  `.devai/state/experimental/withdrawals/`. The record names the time, the SHA-256 of the
  withdrawn record and its activation digest. The action then removes the activation, so the
  repository returns to the supported serial runner. A dispatch already running keeps the
  activation it read at start. Activation writes and withdrawals take the same lock,
  `.devai/state/experimental/activation.lock`, and refuse with `EXPERIMENTAL_ACTIVATION_BUSY`
  while the other holds it. A withdrawal removes only the exact record it names. Nothing takes the
  lock over: a lock left by a writer that is gone refuses with
  `EXPERIMENTAL_ACTIVATION_LOCK_STALE`, naming the file and the command that removes it once no
  activation or withdrawal is running.

### Known limitations of experimental execution

- **The write boundary is the provider's own sandbox.** Snapshots alone cannot prove the
  boundary: a provider could create a symbolic link that escapes the worktree, write through it,
  and remove it before the final snapshot. So the provider's own sandbox enforces it while the
  provider runs (ADR-MDL-0008). Each adapter passes the strongest workspace-confined write mode
  its CLI offers, rooted at the attempt worktree:
  - codex (`codex-workspace-write`): `codex exec --ignore-user-config --sandbox workspace-write
--cd <worktree> --ignore-rules --config sandbox_workspace_write.writable_roots=[] --config
sandbox_workspace_write.network_access=false`;
  - claude (`claude-restricted-sandbox`): `claude --setting-sources "" --strict-mcp-config` with
    an empty MCP configuration, `--restricted --tools Bash,Read,Edit,Write,Glob,Grep`, the
    sandbox settings `{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false}}`,
    `--permission-mode acceptEdits` and `--permission-prompts none`.

  The broker admits the provider process only when its argv carries that whole sequence, rooted
  at the spawn cwd. Dispatch refuses a runtime it cannot confine, or a host other than macOS or
  Linux, with `EXPERIMENTAL_SANDBOX_UNAVAILABLE` before any lock or worktree is touched. The
  evidence of every attempt whose provider process started records the enforced mode and its
  complete flags in a `sandbox` object; an attempt refused before any provider ran records
  none. Limits remain:
  - DEVAI asserts the flags it passes; it does not observe the provider's kernel sandbox, so a
    defect in that sandbox is outside DEVAI's proof.
  - Both providers leave their temporary directories writable, outside the repository.
  - The Article 6 write-scope check and the symbolic-link check still compare snapshots. They
    catch writes inside the worktree that fall outside the discipline's paths.

- **The state root must be initialized first.** Dispatch fsyncs every directory it creates
  below `.devai/state`, but it holds no authority over `.devai`, which lies outside the
  `fs:f5-state` domain. `init apply harness` creates the state root, fsyncs the repository
  directory when it created `.devai`, fsyncs `.devai`, and then publishes
  `.devai/state/state-root.json`; `round dispatch` refuses with
  `EXPERIMENTAL_STATE_ROOT_UNINITIALIZED` until that marker exists, and with
  `EXPERIMENTAL_STATE_ROOT_MARKER_INVALID` when anything other than a regular file with the
  exact marker bytes is at its path (ADR-AUT-0005). Re-running `init apply harness` on an
  adopted repository adds the marker and keeps a valid one; it refuses an invalid one with
  `INIT_STATE_ROOT_MARKER_INVALID`.
- **Create-only records and locks publish without replacement.** A create-only record, a fresh
  resource lock, the activation lock and the worktree registry lock are written to a staged, fsynced file that is
  hard-linked into place, so the name appears only with its complete bytes and an existing one
  is never replaced: of two concurrent writers exactly one succeeds (ADR-AUT-0005). A crash
  between the link and the staged unlink leaves the complete record and a hidden
  `.<name>.<pid>-<uuid>.publish-staged` link, which no reader lists and which is safe to remove.
  A failure after the link refuses with `DURABLE_PUBLICATION_INDETERMINATE`: the record holds
  the writer's bytes but is not reported as created, and a lock holder removes its own lock.
- **Worktree registry updates are serialized across processes.** Every change to
  `.devai/state/worktrees.json` runs under `.devai/state/worktrees.lock`, so concurrent rounds
  never exceed the worktree cap or drop an entry. A second writer waits up to 30 seconds, then
  refuses with `WORKTREE_REGISTRY_BUSY`. A lock left by a process on this host that is gone
  refuses with `WORKTREE_REGISTRY_LOCK_STALE` and names its removal step; it is never taken over.

## Campaigns, materialization, and ratification

`campaign status --campaign <CMP-id>` reads a campaign plan beside the runtime task records
and names each drift: a planned task with no runtime record in an open round, a runtime record
ahead of or behind the plan, or a runtime task the plan does not name. It writes nothing.

`campaign materialize --campaign <CMP-id> --round <round-id> --as-role architect --write` turns
one open campaign round into queued task records through the round task queue, mapped as
`law/policy/campaign-execution.json` declares. Each task gets:

- its wave as the coupled group;
- a `human` executor whose role is the discipline;
- the campaign prompt as `instructions_ref`;
- completion on a merged pull request, with escalation after the task's time budget.

An identical existing record is reported, and a differing one refuses with
`TASK_RECORD_CONFLICT` before anything is written. No external controller materializes
campaign state (ADR-GOV-0025).

A campaign task may instead declare an agent `executor` with a `runtime`, `model`, `effort`
and `recipe_name`, and optionally `recipe_variant`, `max_iterations` (default 4) and
`capabilities` (ADR-MDL-0009). That task materializes with an agent executor that selects its
runtime exactly, names the campaign prompt as `instructions_ref`, and carries the composition
id of its prompt, so `round dispatch --experimental` can run it. The campaign prompt is a hashed
component of the prompt the provider receives; editing it changes the id, and dispatch refuses
with `TASK_PROMPT_COMPOSITION_DRIFT` until the task is re-bound. The campaign `boundary.paths`
become the task's declared boundary. Before anything is written, each contract is checked:

- the discipline must be engineer or inspector (`CAMPAIGN_AGENT_DISCIPLINE_UNSUPPORTED`);
- the runtime must be an experimental runtime (`CAMPAIGN_AGENT_RUNTIME_UNSUPPORTED`);
- the effort must be one the runtime registry lists for it (`CAMPAIGN_AGENT_EFFORT_UNSUPPORTED`);
- the model must be one of the runtime's tier aliases (`CAMPAIGN_AGENT_MODEL_UNSUPPORTED`).

Materializing needs no activation. Dispatch still needs an in-force Owner activation that admits
the selection.

`round ratify --round <round-id> --task <task-id> --decision accept|reject --as-role owner --write`
records the Owner's or Architect's decision on a task in `awaiting_human_review` (for example
after experimental dispatch). Accept moves the task to `pre_merge`, and reject escalates it.
The record is written once to `.devai/state/round-runs/<round>/ratifications/<task>.json` with
the reviewed evidence. Ratification never merges, pushes, or closes a round.
