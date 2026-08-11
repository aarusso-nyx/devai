# CLI overview

DEVAI presents 41 actions: 20 stable public actions, 10 preview round actions, and 11
internal plumbing actions. Seven workflow domains organize the public surface. Choose the domain from the outcome you need;
then choose one leaf action, suite, preset, kind, slice, tier, round, or task selection inside
that domain. The hidden `task` and `catalog` surfaces are plumbing, not additional workflows.

This page is the current operator guide. It describes the supported CLI surface; documentation
does not by itself establish release, deployment, or readiness.

## Choose a workflow

| If you need to...                                                         | Choose     | Start with                                                                    |
| ------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| plan, apply, or bind adoption                                             | `init`     | `devai init plan --target . --tier tier1 --format json`                       |
| diagnose the repository's declared posture                                | `doctor`   | `devai doctor --repo-root . --format json`                                    |
| validate a governed rule population                                       | `check`    | `devai check --only cli-reference --repo-root . --format json`                |
| observe the repository or runtime                                         | `sense`    | `devai sense run type_check --repo-root . --dry-run --format json`            |
| plan, inspect, run, or close governed work                                | `round`    | `devai round status --round R-1000 --repo-root . --format json`               |
| collect, record, render, redact, or verify evidence                       | `evidence` | `devai evidence verify --scope chain --show-head --repo-root . --format json` |
| inspect release control or enter a separately authorized release ceremony | `release`  | `devai release status --repo-root . --format json`                            |

The examples above use only the current grammar. They are read-only or dry-run selections;
replace the example identifiers with identifiers that exist in the target repository.

## Contract shared by all seven workflows

For workflow identifier `W`, its exact population is the ordered projection of entries in the
[action registry](../../../law/policy/action-registry.json) whose status is `stable` or `preview`
and whose first path component is `W`. This formula, rather than a copied action list, keeps the
overview aligned with the live registry. Query `devai catalog actions --format json` for the
current stable, preview, and internal population.

Machine output is one action-bound envelope on stdout. A successful envelope contains a closed
result frame; a failed invocation emits one structured error envelope on stderr. Aggregate
commands also carry a verdict. A process exit is transport/control information, not a substitute
for reading that verdict. See [verdicts](./vocabulary.md#verdicts) and the
[action-result schema](../../../law/schemas/action-result.schema.json).

Routing, usage, precondition, authority, infrastructure, and contract failures stop or refuse the
selected action according to its error envelope. `review` and `unknown` never become `pass`;
`skipped` and `na` must be explicit and cannot hide a required member; `killed` means execution did
not complete. Leaf and aggregate descriptors define the exact behavior. The CLI never infers a
positive result from missing or malformed output.

There is no meaningful cost or effect class for a domain by itself: those fields resolve at the
selected leaf and, for parameterized `check` and `sense` actions, at the selected member
population. The exact descriptor uses `fast`, `moderate`, `expensive`, or
`external-dependent`. Inspect the selected reference before execution:

- [check suites](./check-suites.md) and [sense presets](./sense-presets.md);
- [sensor kinds](./sensor-kinds.md) and [inventory slices](./inventory-slices.md);
- [authority and effects](./authority-effects.md);
- the live action registry and leaf help.

Every non-read invocation needs a permitted role or live authority session plus explicit
`--write`. A resolved remote write additionally needs `--publish`; neither flag implies the
other. Preview or inspect whenever the leaf offers `--dry-run`, plan output, status, or help.

## Workflow descriptors

### `init` — Adoption and binding

- **Stable identifier and label:** `init`; “Adoption and binding.”
- **Purpose and exact projection:** plan the segmented adoption projection, apply a role-owned
  segment, or bind the selected adoption. Its exact leaves are the registry projection defined above
  with `W = init`.
- **Prerequisites, tools, inputs, and defaults:** a target repository is required; `--target`
  defaults to the current directory. A tier may be selected explicitly. `init plan` needs no write
  authority; an apply needs the role that owns the projected paths. Binding follows the exact
  contract shown by `devai init bind --help`. Selected includes such as hooks or CI can require
  their host tools.
- **Output and verdict:** plans report the exact projected operations; applies report bounded
  writes through the shared action envelope. Schema, target, authority, or write failures refuse
  the operation; planning is not an apply verdict.
- **Effect, consent, and cost:** effect and cost are leaf-dependent. `init plan` is read-only;
  applying or binding follows the selected leaf's declared consent and role. Domain-level cost
  is N/A because the chosen target and segment determine it.
- **Use / do not use:** use for adoption planning, application, and binding. Do not use it to run checks,
  sensors, rounds, or a release ceremony.
- **Example:** `devai init plan --target . --tier tier1 --format json`.
- **Canonical source and related workflow:** [action registry](../../../law/policy/action-registry.json);
  follow with `doctor`.

### `doctor` — Declared-posture diagnosis

- **Stable identifier and label:** `doctor`; “Declared-posture diagnosis.”
- **Purpose and exact projection:** run the composite health diagnosis for the selected repository
  posture. Its exact population is the registry projection with `W = doctor`.
- **Prerequisites, tools, inputs, and defaults:** point `--repo-root` at the repository. The
  default posture is automatic detection; explicit self/adopter posture is available in leaf
  help. Individual probes can depend on tools reported in their findings.
- **Output and verdict:** reports every applicable check, including advisory results above the
  declared adoption tier. Binding failures make the diagnosis fail; advisory findings remain
  visible without changing the binding aggregate. Unknown dependencies remain explicit.
- **Effect, consent, and cost:** declared `read`; no role declaration, `--write`, or `--publish`.
  Cost is `moderate` for the composite itself, while an external probe can make a particular run
  `external-dependent`.
- **Use / do not use:** use after adoption changes and when diagnosing drift. Do not treat a
  diagnostic pass as release or round-close authority.
- **Example:** `devai doctor --repo-root . --format json`.
- **Canonical source and related workflow:** [action registry](../../../law/policy/action-registry.json),
  [adoption tiers](./adoption-tiers.md); follow findings to `check`, `sense`, or `init`.

### `check` — Governed validation

- **Stable identifier and label:** `check`; “Governed validation.”
- **Purpose and exact projection:** run one named check or an ordered check suite. Its action
  population is the registry projection with `W = check`; suite membership is generated from the
  canonical suite policy.
- **Prerequisites, tools, inputs, and defaults:** `--repo-root` defaults to the current directory.
  Select exactly one `--suite` or `--only`; when neither is supplied the suite policy defines the
  default. Each member descriptor names required tools and inputs.
- **Output and verdict:** emits member results plus the fail-closed aggregate. Review, unknown,
  fail, error, skipped, and N/A behavior is defined per member and by aggregate precedence; an
  unrecognized member or outcome is an error, never a pass.
- **Effect, consent, and cost:** the selected plan resolves its maximum member effect before
  authorization. A non-read selection requires the Inspector role and `--write`; no check
  publishes. Cost is the class generated for the selected member or suite, not for the domain.
- **Use / do not use:** use to assert governed rules. Do not use it as a sensor preset or as
  authorization to publish or close a round.
- **Example:** `devai check --only cli-reference --repo-root . --format json`.
- **Canonical source and related workflow:** [check-suite policy](../../../law/policy/check-suites.json),
  [check suites](./check-suites.md); use `sense` when the question is observational.

### `sense` — Observation and inventory

- **Stable identifier and label:** `sense`; “Observation and inventory.”
- **Purpose and exact projection:** resolve and run a sensor kind or preset, render an inventory
  slice, or explicitly record an observation. Its action population is the registry projection
  with `W = sense`; kinds, presets, and slices come from their own canonical sources.
- **Prerequisites, tools, inputs, and defaults:** select exactly one positional kind or
  `--preset`; some selections require a round or structured input. A slice selection is separate.
  Each generated descriptor names the external tools it can invoke.
- **Output and verdict:** sensor execution and readiness are reported separately; preset output
  includes executed and excluded populations. Unknown kinds, malformed inputs, tool
  failures, killed sensors, and incomplete results remain explicit. Running a preset never
  implicitly persists a reading.
- **Effect, consent, and cost:** the selected kind population resolves effect and consent before
  dispatch. Read-only selection needs no role; non-read and remote selections follow the exact
  authority contract. Cost is selected-kind or selected-preset data, not a domain value.
- **Use / do not use:** use to observe or inventory. Do not use a reading as a check verdict, and
  do not assume that producing a reading makes an intrinsically write-capable probe read-only.
- **Example:** `devai sense run type_check --repo-root . --dry-run --format json`.
- **Canonical source and related workflow:** [sensor registry](../../../law/policy/sensor-registry.json),
  [sense presets](./sense-presets.md), [sensor kinds](./sensor-kinds.md); use `evidence` for explicit
  persistence and verification.

### `round` — Governed work

- **Stable identifier and label:** `round`; “Governed work.”
- **Purpose and exact projection:** plan, inspect, assess, run, recover, seal, or close work inside
  one governed round. Its exact leaves are the registry projection with `W = round`.
- **Prerequisites, tools, inputs, and defaults:** commands take an explicit `R-NNNN` identity;
  execution requires that round to be active and each selected task to belong to it. Task
  executors declare any further tools, resources, inputs, and timeouts.
- **Output and verdict:** reports round/task state or one aggregate task execution result.
  Dependency, cycle, cross-round, lock, authority, timeout, malformed-output, and recovery states
  are fail-closed and evidenced. Partial output is diagnostic only.
- **Effect, consent, and cost:** status and assessment can be read-only; planning, execution, and
  closure have their leaf-declared effects and roles. Domain-level cost is N/A because it ranges
  from a fast status read to external-dependent task execution.
- **Use / do not use:** use as the ordinary entry point for governed task execution. Do not call
  hidden task plumbing to bypass containment, and do not infer release from round closure.
- **Example:** `devai round status --round R-1000 --repo-root . --format json`.
- **Canonical source and related workflow:** [round-execution policy](../../../law/policy/round-execution.json),
  [round/task/executor guide](./round-task-executors.md); use `evidence` to inspect execution proof.

### `evidence` — Governed evidence handling

- **Stable identifier and label:** `evidence`; “Governed evidence handling.”
- **Purpose and exact projection:** collect, append, redact by recorded erratum, render, or verify
  a declared evidence scope. Its exact leaves are the registry projection with `W = evidence`.
- **Prerequisites, tools, inputs, and defaults:** choose a declared evidence source, kind, view, or
  verification scope. Mutating operations require the owning round and schema-valid inputs;
  source-specific collectors may require local artifacts or an external provider.
- **Output and verdict:** verification returns an integrity result and diagnostic location;
  mutations return an action-bound receipt. Missing, malformed, digest-divergent, unknown, or
  partial evidence never becomes a positive claim. Redaction preserves an attributable erratum.
- **Effect, consent, and cost:** verification can be read-only; collection, recording, rendering,
  and redaction can write harness state and require a permitted role plus `--write`. Cost is
  `fast`, `moderate`, or `external-dependent` according to the selected source and scope.
- **Use / do not use:** use for evidence lifecycle operations. Do not hand-edit machine evidence,
  and do not treat storage, transport, or a successful command as authenticated claim reuse.
- **Example:** `devai evidence verify --scope chain --show-head --repo-root . --format json`.
- **Canonical source and related workflow:** [action registry](../../../law/policy/action-registry.json),
  [round execution outputs](../../../law/policy/round-execution.json); evidence supports `round`
  and `release` but does not authorize either.

### `release` — Release control

- **Stable identifier and label:** `release`; “Release control.”
- **Purpose and exact projection:** inspect release-control status, evaluate eligibility, and
  record drift or verification. Its exact leaves are the registry projection with `W = release`.
- **Prerequisites, tools, inputs, and defaults:** status needs a repository; other leaves require
  their declared artifact, environment, scorecard, evidence, or runtime inputs.
- **Output and verdict:** status is observation; eligibility and verification report their
  governed verdicts. Review, unknown, failure, missing evidence, external errors, and N/A remain
  nonclaims. A release-suite or release-check result is not publication.
- **Effect, consent, and cost:** status is read-only. Other leaves can write harness state and
  require the permitted role plus `--write`. Cost is leaf-dependent.
- **Use / do not use:** use only at the applicable release-control stage. Do not use it to infer
  authority from documentation, a round result, or stored evidence.
- **Example:** `devai release status --repo-root . --format json`.
- **Canonical source and related workflow:** [action registry](../../../law/policy/action-registry.json),
  [authority/effects](./authority-effects.md); consume `check` and `evidence` results only under
  the separately governed release contract.

## Typical adoption-to-release journey

This is a selection journey, not proof that any step has passed or that publication is
authorized.

1. Preview a declared tier and inspect the exact files before mutation:

   ```sh
   devai init plan --target . --tier tier1 --format json
   ```

2. Apply only the reviewed, role-owned segments. Each line is a deliberate local write:

   ```sh
   devai init apply owner --target . --tier tier1 --as-role owner --write --format json
   devai init apply architect --target . --tier tier1 --as-role architect --write --format json
   devai init apply harness --target . --tier tier1 --as-role architect --write --format json
   ```

3. Diagnose the resulting declaration and binding posture:

   ```sh
   devai doctor --repo-root . --format json
   ```

4. Resolve observation before execution, then run one exact registered kind with its resolved
   authority and consent. An unknown preset or kind remains UNKNOWN; it is never substituted:

   ```sh
   devai sense run type_check --repo-root . --dry-run --format json
   ```

5. Run the check suite required by the current gate. This example declares the Inspector and
   accepts the selected suite's local-write ceiling:

   ```sh
   devai check --suite quick --repo-root . --as-role inspector --write --format json
   ```

6. When the repository is ready to assume more obligations, generate a plan-only climb checklist.
   Do not add a role declaration or write consent. The checklist does not complete the climb:

   ```sh
   devai init bind --help
   ```

7. Operate governed work through its round, first reading state and then deliberately running
   the selected ready tasks:

   ```sh
   devai round status --round R-1000 --repo-root . --format json
   devai round run --round R-1000 --task TASK-7001 --repo-root . --as-role engineer --write --format json
   ```

8. Verify the evidence scope before consulting release control:

   ```sh
   devai evidence verify --scope chain --show-head --repo-root . --format json
   devai release status --repo-root . --format json
   ```

9. Continue only under the applicable release authorization. A release check observes
   eligibility; it does not publish packages, tags, releases, documentation, or deployments.

## Continue reading

- Learn the distinctions in [CLI vocabulary](./vocabulary.md).
- Select obligations in [adoption tiers](./adoption-tiers.md).
- Operate governed work with [rounds, tasks, and executors](./round-task-executors.md).
- Check role and mutation boundaries in [authority and effects](./authority-effects.md).
  Canonical routing: [action registry](../../../law/policy/action-registry.json),
  [documentation information architecture](../../../law/policy/documentation-information-architecture.json).
