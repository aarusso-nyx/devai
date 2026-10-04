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

One `round run` controls a round at a time. A second run of the same round refuses with
`TASK_ROUND_CONTROLLER_BUSY` while the controller in `.devai/state/round-runs/<round>/controller.json`
is alive or ran on another host. A controller left by a dead process on the same host is reclaimed;
the tasks it left `in_progress` stay there for explicit human disposition, because only `ready`
tasks are dispatched.

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
`PROCESS_GROUP_TERMINATION_UNCONFIRMED` instead, because the routine may still be running.
Database and worktree identities
are per task (`devai_task_<task id>`, `WT-<task id>`), so two distinct tasks never contend for
them. There is no cross-round controller and no reviewer reserve yet; the policy records both.

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
in-force activation. Before any lock, worktree, or provider is touched it refuses an absent or
expired activation, any selected task whose discipline, runtime, model, effort, or exact
selection the activation does not admit, and a round whose dispatch journal holds an uncertain
attempt (`TASK_DISPATCH_UNCERTAIN`) until a human runs `task escalate` on that task.

Each task composes its prompt (Article 37) from four layers: the adopter's `AGENTS.md`, the
discipline's role charter, the task record, and the task's recipe as the payload. A task without
`recipe_name` refuses with `PROMPT_RECIPE_REQUIRED`. The prompt must still match its bound
`prompt_composition_id`, or the task is refused with `TASK_PROMPT_COMPOSITION_DRIFT`. It then runs up
to three attempts at the requested model and one at the next tier of
`law/policy/model-tiers.json` when the activation also admits that model, bounded by the task's
`max_iterations` and the activation budgets. Every attempt runs in a fresh worktree
`WT-<task>-A<n>` and is journalled from `intent` to `settled`. Any changed path that Article 6
does not give the task's discipline fails it with `EXPERIMENTAL_WRITE_SCOPE_VIOLATION`. Its
evidence carries `experimental: true` and version-2 usage. A contained, completed attempt leaves
the task `awaiting_human_review` with its worktree kept for review. Otherwise the worktree is
removed, the changed-file digests stay in the evidence, and an exhausted ladder or budget ends
the task `experimental_blocked`. Once a provider leaves a token counter unreported, no further
attempt in the invocation may spend (`EXPERIMENTAL_USAGE_UNVERIFIABLE`). Nothing is pushed,
merged, or retried automatically.

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

`round ratify --round <round-id> --task <task-id> --decision accept|reject --as-role owner --write`
records the Owner's or Architect's decision on a task in `awaiting_human_review` (for example
after experimental dispatch). Accept moves the task to `pre_merge`, and reject escalates it.
The record is written once to `.devai/state/round-runs/<round>/ratifications/<task>.json` with
the reviewed evidence. Ratification never merges, pushes, or closes a round.
