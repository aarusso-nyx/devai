# CLI vocabulary

DEVAI uses different words for different control decisions. Keeping them separate prevents a
larger check from being mistaken for broader authority, a model choice from being mistaken for a
role, or an observation from being mistaken for a release verdict.

The generated blocks on this page are deterministic projections of canonical policy and schema
sources. Do not hand-edit their contents. The surrounding prose explains relationships without
owning those mutable populations.

## The selection words

### Suite

A **suite** is a named, ordered population of validation members selected by `devai check
--suite <name>`. It answers “which governed assertions should run together?” A suite owns member
order, prerequisites, maximum effect, cost, output, and aggregation behavior; it does not own an
adoption floor or grant a role.

Use a suite when you want a repeatable validation population. Use `--only <member>` when the
question is one check rather than the whole population. See the generated
[check-suite reference](./check-suites.md).

```sh
devai check --suite quick --repo-root . --as-role inspector --write --format json
```

### Preset

A **preset** is a named, ordered population of sensor kinds selected by `devai sense run --preset
<name>`. It answers “which observations should be gathered together?” A preset may require a round
and may exclude kinds whose intrinsic effects exceed its boundary. Running one does not implicitly
persist readings.

Use a preset for a repeatable observation population. Use a positional kind when only one sensor
is needed. Exact preset IDs come only from the candidate's generated
[sense-preset reference](./sense-presets.md). An unknown ID yields UNKNOWN and is not remapped.

### Kind

A **kind** is the stable identity of one sensor contract. It is a value in the sensor registry,
not a separate CLI action. `devai sense run <kind>` resolves the kind's inputs, tools, output,
scorecard or diagnostic standing, intrinsic effect, and consent before dispatch.

Use a kind for one precise observation. Do not infer that every sensor is read-only merely because
it produces a reading. See the generated [sensor-kind catalog](./sensor-kinds.md).

```sh
devai sense run type_check --repo-root . --dry-run --format json
```

### Slice

A **slice** is a named deterministic projection of repository inventory selected with the
`--slice <name>` option on `devai sense inventory`. It answers “which structural view should be
rendered?” A slice is not a sensor preset and does not declare an adoption floor.

Use a slice when the desired output is an inventory body rather than a sensor verdict. See the
generated [inventory-slice reference](./inventory-slices.md).

```sh
devai sense inventory --slice modules --repo-root . --format json
```

### Tier

An unqualified **tier** is the repository's declared adoption floor. It determines which
obligations are binding and which higher obligations remain visible but advisory. It does not
disable commands, select a check suite, select a sensor preset, or authorize an effect.

“Surface tier” is a separate term that classifies CLI routes as porcelain or plumbing. See the
generated [adoption-tier descriptors](./adoption-tiers.md) and the
[surface-tier descriptors](#surface-tiers).

```sh
devai init plan --target . --tier tier1 --format json
```

## The work words

### Round

A **round** is the governed container for one authorized body of work. Its stable identity has the
shape `R-NNNN`. It owns intent, task population, active/closed standing, evidence boundaries, and
the applicable close contract. A round result does not imply release.

```sh
devai round status --round R-1000 --repo-root . --format json
```

### Task

A **task** is a subordinate work item owned by exactly one active round. Its immutable request
declares a discipline, dependencies, resource targets, and exactly one executor contract. Ordinary
operators execute it through `round run`; direct `task` routes are hidden plumbing and cannot
bypass round containment.

```sh
devai round run --round R-1000 --task TASK-7001 --repo-root . --as-role engineer --write --format json
```

See [rounds, tasks, and executors](./round-task-executors.md) for dependency, resource, selection,
and recovery semantics.

## The safety words

### Role

A **role** is a human governance discipline and its path authority. It answers “who may perform
this governed change?” A role is declared for a non-read invocation through `--as-role` or a live,
repository-bound authority session. A model, runtime, skill, capability, or executor kind cannot
grant or change the task's role.

```sh
devai init apply architect --target . --tier tier1 --as-role architect --write --help
```

### Effect

An **effect** is the maximum intrinsic mutation class of the resolved invocation. It answers “what
may this invocation change?” Effects are conservative capability ceilings and are resolved before
authority and consent. The effect does not grant authority; role, path policy, planner, mutation
boundary, and explicit consent must all agree. Every resolved `remote-write` invocation, including
a dry run, requires independent `--write` and `--publish` consent.

See [authority and effects](./authority-effects.md).

### Verdict

A **verdict** is a governed evaluation outcome in an action, check, sensor, or task aggregate. It
is not the same as process execution state: a command can execute successfully while reporting a
non-passing readiness verdict. Aggregation follows canonical precedence, and missing, malformed,
or unknown outcomes never default to pass.

Read both the action envelope and the verdict it carries:

```sh
devai check --only cli-reference --repo-root . --format json
```

### Lifecycle

An action's **lifecycle** records whether its identity is supported or guarded by an explicit
experimental boundary. Lifecycle is independent of a result verdict and independent of the
repository's adoption tier.

Inspect a leaf without dispatching it:

```sh
devai release status --help
```

## The surface words

### Porcelain

**Porcelain** is the workflow-facing CLI surface. It is shown in default help and is organized
around the seven domains in the [CLI overview](./index.md). Porcelain may orchestrate internal
services, but it retains exact action, effect, consent, and output contracts.

```sh
devai catalog actions --format json
```

### Plumbing

**Plumbing** is the hidden low-level surface used by orchestration and advanced automation. It is
visible only in expanded help. Plumbing is not an eighth workflow, carries no broader authority,
and cannot relax round containment or consent.

```sh
devai catalog actions --format json
```

## Distinctions to preserve

| Do not conflate...             | Because...                                                             |
| ------------------------------ | ---------------------------------------------------------------------- |
| suite and preset               | suites validate; presets observe                                       |
| preset and kind                | a preset selects an ordered population; a kind identifies one sensor   |
| slice and preset               | a slice renders an inventory projection; a preset runs sensors         |
| adoption tier and surface tier | one sets binding obligations; the other controls CLI visibility        |
| round and task                 | the round is the governed container; the task is subordinate work      |
| role and executor              | discipline grants path authority; execution mechanism does not         |
| capability and effect          | capability is a reviewed ceiling input; resolved effect drives consent |
| process exit and verdict       | transport completion does not make an evaluation pass                  |
| lifecycle and verdict          | lifecycle describes an action identity; verdict describes one result   |
| porcelain and plumbing         | visibility and ergonomics do not change authority                      |

## Canonical verdict descriptors

The renderer derives this complete descriptor population from
[`round-execution.json#/vocabularies/verdicts`](../../../law/policy/round-execution.json), with
sensor-state parity checked against the
[sensor-reading schema](../../../law/schemas/sensor-reading.schema.json).

<!-- devai:generated-reference:start category="verdicts" -->

## Verdicts

<!-- devai:generated-entry category="verdicts" id="pass" -->

### `pass` — Pass

- **Stable ID:** pass
- **User-facing label:** Pass
- **Purpose:** Represent the explicit `pass` aggregate outcome without coercing it to pass.
- **Population or projection:** The single canonical verdicts value `pass` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** `pass` retains its literal aggregate meaning and is never silently coerced to pass.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing resolved action.
- **Cost class:** `fast`
- **When to use:** Use only when `pass` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite standard --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/verdicts); [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json#/properties/status/enum)
- **Related workflow:** `check`

<!-- devai:generated-entry category="verdicts" id="review" -->

### `review` — Review

- **Stable ID:** review
- **User-facing label:** Review
- **Purpose:** Represent the explicit `review` aggregate outcome without coercing it to pass.
- **Population or projection:** The single canonical verdicts value `review` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** `review` retains its literal aggregate meaning and is never silently coerced to pass.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing resolved action.
- **Cost class:** `fast`
- **When to use:** Use only when `review` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite standard --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/verdicts); [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json#/properties/status/enum)
- **Related workflow:** `check`

<!-- devai:generated-entry category="verdicts" id="fail" -->

### `fail` — Fail

- **Stable ID:** fail
- **User-facing label:** Fail
- **Purpose:** Represent the explicit `fail` aggregate outcome without coercing it to pass.
- **Population or projection:** The single canonical verdicts value `fail` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** `fail` retains its literal aggregate meaning and is never silently coerced to pass.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing resolved action.
- **Cost class:** `fast`
- **When to use:** Use only when `fail` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite standard --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/verdicts); [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json#/properties/status/enum)
- **Related workflow:** `check`

<!-- devai:generated-entry category="verdicts" id="unknown" -->

### `unknown` — Unknown

- **Stable ID:** unknown
- **User-facing label:** Unknown
- **Purpose:** Represent the explicit `unknown` aggregate outcome without coercing it to pass.
- **Population or projection:** The single canonical verdicts value `unknown` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** `unknown` retains its literal aggregate meaning and is never silently coerced to pass.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing resolved action.
- **Cost class:** `fast`
- **When to use:** Use only when `unknown` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite standard --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/verdicts); [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json#/properties/status/enum)
- **Related workflow:** `check`

<!-- devai:generated-entry category="verdicts" id="na" -->

### `na` — Na

- **Stable ID:** na
- **User-facing label:** Na
- **Purpose:** Represent the explicit `na` aggregate outcome without coercing it to pass.
- **Population or projection:** The single canonical verdicts value `na` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** `na` retains its literal aggregate meaning and is never silently coerced to pass.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing resolved action.
- **Cost class:** `fast`
- **When to use:** Use only when `na` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite standard --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/verdicts); [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json#/properties/status/enum)
- **Related workflow:** `check`

<!-- devai:generated-entry category="verdicts" id="skipped" -->

### `skipped` — Skipped

- **Stable ID:** skipped
- **User-facing label:** Skipped
- **Purpose:** Represent the explicit `skipped` aggregate outcome without coercing it to pass.
- **Population or projection:** The single canonical verdicts value `skipped` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** `skipped` retains its literal aggregate meaning and is never silently coerced to pass.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing resolved action.
- **Cost class:** `fast`
- **When to use:** Use only when `skipped` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite standard --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/verdicts); [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json#/properties/status/enum)
- **Related workflow:** `check`

<!-- devai:generated-entry category="verdicts" id="error" -->

### `error` — Error

- **Stable ID:** error
- **User-facing label:** Error
- **Purpose:** Represent the explicit `error` aggregate outcome without coercing it to pass.
- **Population or projection:** The single canonical verdicts value `error` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** `error` retains its literal aggregate meaning and is never silently coerced to pass.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing resolved action.
- **Cost class:** `fast`
- **When to use:** Use only when `error` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite standard --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/verdicts); [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json#/properties/status/enum)
- **Related workflow:** `check`

<!-- devai:generated-entry category="verdicts" id="killed" -->

### `killed` — Killed

- **Stable ID:** killed
- **User-facing label:** Killed
- **Purpose:** Represent the explicit `killed` aggregate outcome without coercing it to pass.
- **Population or projection:** The single canonical verdicts value `killed` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** `killed` retains its literal aggregate meaning and is never silently coerced to pass.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing resolved action.
- **Cost class:** `fast`
- **When to use:** Use only when `killed` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite standard --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/verdicts); [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json#/properties/status/enum)
- **Related workflow:** `check`

<!-- devai:generated-reference:end category="verdicts" -->

## Canonical lifecycle descriptors

The renderer derives this complete population from the lifecycle enum in the
[action-registry schema](../../../law/schemas/action-registry.schema.json). Per-action assignment
remains in the [action registry](../../../law/policy/action-registry.json).

<!-- devai:generated-reference:start category="action-lifecycles" -->

## Action lifecycles

<!-- devai:generated-entry category="action-lifecycles" id="supported" -->

### `supported` — Supported

- **Stable ID:** supported
- **User-facing label:** Supported
- **Purpose:** Describe an action whose canonical lifecycle is `supported`.
- **Population or projection:** The single canonical action-lifecycles value `supported` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** Not applicable: this value classifies a record; the enclosing operation owns verdict semantics.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing resolved action.
- **Cost class:** `fast`
- **When to use:** Use only when `supported` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai catalog actions --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/action_lifecycles)
- **Related workflow:** `catalog`

<!-- devai:generated-entry category="action-lifecycles" id="experimental" -->

### `experimental` — Experimental

- **Stable ID:** experimental
- **User-facing label:** Experimental
- **Purpose:** Describe an action whose canonical lifecycle is `experimental`.
- **Population or projection:** The single canonical action-lifecycles value `experimental` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** Not applicable: this value classifies a record; the enclosing operation owns verdict semantics.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing resolved action.
- **Cost class:** `fast`
- **When to use:** Use only when `experimental` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai catalog actions --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/action_lifecycles)
- **Related workflow:** `catalog`

<!-- devai:generated-reference:end category="action-lifecycles" -->

## Canonical surface-tier descriptors

The renderer derives this complete population and its exact domain projection from
[`round-execution.json#/vocabularies/surface_tiers`](../../../law/policy/round-execution.json) and
checks the identifiers against the action-registry schema.

<!-- devai:generated-reference:start category="surface-tiers" -->

## Surface tiers

<!-- devai:generated-entry category="surface-tiers" id="porcelain" -->

### `porcelain` — Porcelain

- **Stable ID:** porcelain
- **User-facing label:** Porcelain
- **Purpose:** Select the canonical `porcelain` surface tier.
- **Population or projection:** `init`, `doctor`, `check`, `sense`, `round`, `evidence`, `release`
- **Prerequisites:** A readable repository root and a canonical descriptor that resolves every selected member.
- **Required external tools:** Not applicable: no additional external tool is declared by the canonical surface tier descriptor.
- **Accepted inputs:** This classification is emitted by the hidden action catalog; it is not selected as a public workflow input.
- **Defaults:** No surface tier is inferred outside the canonical action registry.
- **Output contract:** action-envelope using law/schemas/action-result.schema.json.
- **Verdict semantics:** `pass` requires the complete projection; unsupported or unresolved members return an error and never a partial pass.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing action, not this vocabulary value.
- **Cost class:** `moderate`
- **When to use:** Use when the named surface tier is the exact requested scope.
- **When not to use:** Do not treat it as a check suite, sense preset, or authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai catalog actions --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/surface_tiers); [`law/schemas/action-registry.schema.json`](../../../law/schemas/action-registry.schema.json#/properties/entries/items/properties/tier/enum)
- **Related workflow:** `catalog`

<!-- devai:generated-entry category="surface-tiers" id="plumbing" -->

### `plumbing` — Plumbing

- **Stable ID:** plumbing
- **User-facing label:** Plumbing
- **Purpose:** Select the canonical `plumbing` surface tier.
- **Population or projection:** `task`, `catalog`
- **Prerequisites:** A readable repository root and a canonical descriptor that resolves every selected member.
- **Required external tools:** Not applicable: no additional external tool is declared by the canonical surface tier descriptor.
- **Accepted inputs:** This classification is emitted by the hidden action catalog; it is not selected as a public workflow input.
- **Defaults:** No surface tier is inferred outside the canonical action registry.
- **Output contract:** action-envelope using law/schemas/action-result.schema.json.
- **Verdict semantics:** `pass` requires the complete projection; unsupported or unresolved members return an error and never a partial pass.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing action, not this vocabulary value.
- **Cost class:** `moderate`
- **When to use:** Use when the named surface tier is the exact requested scope.
- **When not to use:** Do not treat it as a check suite, sense preset, or authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai catalog actions --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/surface_tiers); [`law/schemas/action-registry.schema.json`](../../../law/schemas/action-registry.schema.json#/properties/entries/items/properties/tier/enum)
- **Related workflow:** `catalog`

<!-- devai:generated-reference:end category="surface-tiers" -->

Canonical routing: [action registry](../../../law/policy/action-registry.json),
[documentation information architecture](../../../law/policy/documentation-information-architecture.json).
