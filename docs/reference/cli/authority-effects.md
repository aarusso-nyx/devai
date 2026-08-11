# Authority and effects

DEVAI authorizes a non-read invocation only when two independent questions both resolve:

1. **Authority:** is the declared human role permitted to perform this action against these exact
   paths and resources?
2. **Effect:** what is the maximum intrinsic mutation the resolved invocation can perform, and did
   the caller supply the required consent?

A correct role cannot downgrade an effect. A declared effect cannot grant a role. Executor kind,
runtime, model, effort, skill, and capability cannot answer either question on their own.

## The authorization sequence

Before any mutation, the runtime:

1. resolves the exact leaf action and any parameterized member population;
2. derives the member population's capability ceiling and maximum effect;
3. resolves one human role declaration or one live, repository-bound authority session when the
   effect is non-read;
4. checks action, role, canonical target path, operation, and active policy together;
5. checks independent write and publication consent;
6. installs the exact planner and mutation-adapter boundary; and
7. re-verifies the final targets before committing the bounded effect.

Missing metadata, an unresolved target, effect/capability divergence, or policy disagreement fails
closed. A broad declaration is reviewable intent, not permission to perform an undeclared concrete
operation.

## Canonical role descriptors

The renderer derives the complete human-role population from the
[action-registry schema](../../../law/schemas/action-registry.schema.json) and joins it to
role/effect rules in the [action registry](../../../law/policy/action-registry.json). The generated
entries own labels, exact projections, prerequisites, inputs/defaults, outputs, effects/consent,
cost, use guidance, non-pass behavior, examples, and source links.

The multi-role authority marker `joint` is composition metadata, not another human role. A task's
`discipline` supplies its role; an executor may not override it. Cross-role work requires a session
and commit boundary.

<!-- devai:generated-reference:start category="roles" -->

## Roles

<!-- devai:generated-entry category="roles" id="owner" -->

### `owner` — Owner

- **Stable ID:** owner
- **User-facing label:** Owner
- **Purpose:** Identify the human `owner` discipline; only matching action authority contracts permit an invocation.
- **Population or projection:** 11 matching action contracts; effects `harness-write`, `local-write`, `remote-write`; actions `evidence collect`, `evidence record`, `evidence redact`, `evidence render`, `init apply owner`, `round close`, `round gap create`, `round gap resolve`, `round run`, `sense record`, `sense run`.
- **Prerequisites:** An invocation-scoped `--as-role owner` declaration or live repository-bound authority session, plus a matching action contract.
- **Required external tools:** Not applicable: a role is a governance discipline, not an executor or adapter.
- **Accepted inputs:** `--as-role owner` only on a non-read action whose canonical authority contract allowlists this role.
- **Defaults:** No role is inferred from executor kind, model capability, environment, or prior invocation.
- **Output contract:** The resolved authority evidence preserves the initiating human role and exact action contract.
- **Verdict semantics:** A missing declaration, disallowed role, selector mismatch, or stale session refuses before effects.
- **Declared effect:** Not applicable: role discipline grants no effect by itself.
- **Consent flags:** Not applicable: explicit effect-specific consent remains independently required.
- **Cost class:** `fast`
- **When to use:** Use `owner` only when operating within that discipline's canonical path and action authority.
- **When not to use:** Do not use a role declaration to widen executor, model, mutation, publication, or path authority.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai round run --round R-1000 --repo-root . --as-role owner --write --format json`
- **Canonical source:** [`law/schemas/action-registry.schema.json`](../../../law/schemas/action-registry.schema.json#/$defs/authorityContract/properties/subject/oneOf/1/properties/allowed_roles/items/enum); [`law/policy/action-registry.json`](../../../law/policy/action-registry.json#/entries/*/authority_contract)
- **Related workflow:** `round`

<!-- devai:generated-entry category="roles" id="architect" -->

### `architect` — Architect

- **Stable ID:** architect
- **User-facing label:** Architect
- **Purpose:** Identify the human `architect` discipline; only matching action authority contracts permit an invocation.
- **Population or projection:** 18 matching action contracts; effects `harness-write`, `local-write`, `remote-write`; actions `evidence collect`, `evidence record`, `evidence redact`, `evidence render`, `init apply architect`, `init apply harness`, `init bind`, `release check`, `release drift`, `release verify`, `round close`, `round gap create`, `round gap resolve`, `round plan`, `round run`, `round seal`, `sense record`, `sense run`.
- **Prerequisites:** An invocation-scoped `--as-role architect` declaration or live repository-bound authority session, plus a matching action contract.
- **Required external tools:** Not applicable: a role is a governance discipline, not an executor or adapter.
- **Accepted inputs:** `--as-role architect` only on a non-read action whose canonical authority contract allowlists this role.
- **Defaults:** No role is inferred from executor kind, model capability, environment, or prior invocation.
- **Output contract:** The resolved authority evidence preserves the initiating human role and exact action contract.
- **Verdict semantics:** A missing declaration, disallowed role, selector mismatch, or stale session refuses before effects.
- **Declared effect:** Not applicable: role discipline grants no effect by itself.
- **Consent flags:** Not applicable: explicit effect-specific consent remains independently required.
- **Cost class:** `fast`
- **When to use:** Use `architect` only when operating within that discipline's canonical path and action authority.
- **When not to use:** Do not use a role declaration to widen executor, model, mutation, publication, or path authority.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai round run --round R-1000 --repo-root . --as-role architect --write --format json`
- **Canonical source:** [`law/schemas/action-registry.schema.json`](../../../law/schemas/action-registry.schema.json#/$defs/authorityContract/properties/subject/oneOf/1/properties/allowed_roles/items/enum); [`law/policy/action-registry.json`](../../../law/policy/action-registry.json#/entries/*/authority_contract)
- **Related workflow:** `round`

<!-- devai:generated-entry category="roles" id="inspector" -->

### `inspector` — Inspector

- **Stable ID:** inspector
- **User-facing label:** Inspector
- **Purpose:** Identify the human `inspector` discipline; only matching action authority contracts permit an invocation.
- **Population or projection:** 11 matching action contracts; effects `local-write`, `harness-write`, `remote-write`; actions `check`, `evidence collect`, `evidence record`, `evidence redact`, `evidence render`, `round close`, `round gap create`, `round gap resolve`, `round run`, `sense record`, `sense run`.
- **Prerequisites:** An invocation-scoped `--as-role inspector` declaration or live repository-bound authority session, plus a matching action contract.
- **Required external tools:** Not applicable: a role is a governance discipline, not an executor or adapter.
- **Accepted inputs:** `--as-role inspector` only on a non-read action whose canonical authority contract allowlists this role.
- **Defaults:** No role is inferred from executor kind, model capability, environment, or prior invocation.
- **Output contract:** The resolved authority evidence preserves the initiating human role and exact action contract.
- **Verdict semantics:** A missing declaration, disallowed role, selector mismatch, or stale session refuses before effects.
- **Declared effect:** Not applicable: role discipline grants no effect by itself.
- **Consent flags:** Not applicable: explicit effect-specific consent remains independently required.
- **Cost class:** `fast`
- **When to use:** Use `inspector` only when operating within that discipline's canonical path and action authority.
- **When not to use:** Do not use a role declaration to widen executor, model, mutation, publication, or path authority.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai round run --round R-1000 --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/schemas/action-registry.schema.json`](../../../law/schemas/action-registry.schema.json#/$defs/authorityContract/properties/subject/oneOf/1/properties/allowed_roles/items/enum); [`law/policy/action-registry.json`](../../../law/policy/action-registry.json#/entries/*/authority_contract)
- **Related workflow:** `round`

<!-- devai:generated-entry category="roles" id="engineer" -->

### `engineer` — Engineer

- **Stable ID:** engineer
- **User-facing label:** Engineer
- **Purpose:** Identify the human `engineer` discipline; only matching action authority contracts permit an invocation.
- **Population or projection:** 18 matching action contracts; effects `harness-write`, `local-write`, `remote-write`; actions `evidence collect`, `evidence record`, `evidence redact`, `evidence render`, `round close`, `round gap create`, `round gap resolve`, `round run`, `sense migrate`, `sense record`, `sense run`, `task escalate`, `task finish`, `task pause`, `task queue add`, `task queue complete`, `task resume`, `task start`.
- **Prerequisites:** An invocation-scoped `--as-role engineer` declaration or live repository-bound authority session, plus a matching action contract.
- **Required external tools:** Not applicable: a role is a governance discipline, not an executor or adapter.
- **Accepted inputs:** `--as-role engineer` only on a non-read action whose canonical authority contract allowlists this role.
- **Defaults:** No role is inferred from executor kind, model capability, environment, or prior invocation.
- **Output contract:** The resolved authority evidence preserves the initiating human role and exact action contract.
- **Verdict semantics:** A missing declaration, disallowed role, selector mismatch, or stale session refuses before effects.
- **Declared effect:** Not applicable: role discipline grants no effect by itself.
- **Consent flags:** Not applicable: explicit effect-specific consent remains independently required.
- **Cost class:** `fast`
- **When to use:** Use `engineer` only when operating within that discipline's canonical path and action authority.
- **When not to use:** Do not use a role declaration to widen executor, model, mutation, publication, or path authority.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai round run --round R-1000 --repo-root . --as-role engineer --write --format json`
- **Canonical source:** [`law/schemas/action-registry.schema.json`](../../../law/schemas/action-registry.schema.json#/$defs/authorityContract/properties/subject/oneOf/1/properties/allowed_roles/items/enum); [`law/policy/action-registry.json`](../../../law/policy/action-registry.json#/entries/*/authority_contract)
- **Related workflow:** `round`

<!-- devai:generated-entry category="roles" id="auditor" -->

### `auditor` — Auditor

- **Stable ID:** auditor
- **User-facing label:** Auditor
- **Purpose:** Identify the human `auditor` discipline; only matching action authority contracts permit an invocation.
- **Population or projection:** 10 matching action contracts; effects `harness-write`, `remote-write`; actions `evidence collect`, `evidence record`, `evidence redact`, `evidence render`, `round close`, `round gap create`, `round gap resolve`, `round run`, `sense record`, `sense run`.
- **Prerequisites:** An invocation-scoped `--as-role auditor` declaration or live repository-bound authority session, plus a matching action contract.
- **Required external tools:** Not applicable: a role is a governance discipline, not an executor or adapter.
- **Accepted inputs:** `--as-role auditor` only on a non-read action whose canonical authority contract allowlists this role.
- **Defaults:** No role is inferred from executor kind, model capability, environment, or prior invocation.
- **Output contract:** The resolved authority evidence preserves the initiating human role and exact action contract.
- **Verdict semantics:** A missing declaration, disallowed role, selector mismatch, or stale session refuses before effects.
- **Declared effect:** Not applicable: role discipline grants no effect by itself.
- **Consent flags:** Not applicable: explicit effect-specific consent remains independently required.
- **Cost class:** `fast`
- **When to use:** Use `auditor` only when operating within that discipline's canonical path and action authority.
- **When not to use:** Do not use a role declaration to widen executor, model, mutation, publication, or path authority.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai round run --round R-1000 --repo-root . --as-role auditor --write --format json`
- **Canonical source:** [`law/schemas/action-registry.schema.json`](../../../law/schemas/action-registry.schema.json#/$defs/authorityContract/properties/subject/oneOf/1/properties/allowed_roles/items/enum); [`law/policy/action-registry.json`](../../../law/policy/action-registry.json#/entries/*/authority_contract)
- **Related workflow:** `round`

<!-- devai:generated-reference:end category="roles" -->

## Path authority

Role authority is positive and target-specific. The action contract and runtime target classifier
own the mapping. In practical terms:

- business reference work stays with its business authority;
- engineering law, governed round intent, and human documentation stay with engineering-reference
  authority;
- tests stay with sensor authority;
- plant code and workspace tooling stay with plant authority;
- audit observation stays in the designated audit output; and
- machine records and mutable harness state are written only through attributed verbs, never by a
  human role editing them directly.

This conceptual map is not an access-control list. Always use the exact
[action contract](../../../law/policy/action-registry.json) and current
[runtime authority policy](../../../packages/cli/src/authority/policy.ts). An apparently adjacent
directory, generated materialization, or host-tool file can have a different owner or machine-only
boundary.

## Canonical effect descriptors

The renderer derives the complete ordered effect population from the
[action-registry schema](../../../law/schemas/action-registry.schema.json) and joins each value to
per-action assignment in the [action registry](../../../law/policy/action-registry.json).

<!-- devai:generated-reference:start category="effects" -->

## Effects

<!-- devai:generated-entry category="effects" id="read" -->

### `read` — Read

- **Stable ID:** read
- **User-facing label:** Read
- **Purpose:** Declare the conservative `read` capability ceiling before authority and consent checks.
- **Population or projection:** The single canonical effects value `read` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** Not applicable: this value classifies a record; the enclosing operation owns verdict semantics.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `fast`
- **When to use:** Use only when `read` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite standard --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/schemas/action-registry.schema.json`](../../../law/schemas/action-registry.schema.json#/properties/entries/items/properties/effect/enum); [`law/policy/action-registry.json`](../../../law/policy/action-registry.json#/entries)
- **Related workflow:** `check`

<!-- devai:generated-entry category="effects" id="harness-write" -->

### `harness-write` — Harness Write

- **Stable ID:** harness-write
- **User-facing label:** Harness Write
- **Purpose:** Declare the conservative `harness-write` capability ceiling before authority and consent checks.
- **Population or projection:** The single canonical effects value `harness-write` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** Not applicable: this value classifies a record; the enclosing operation owns verdict semantics.
- **Declared effect:** `harness-write`
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `fast`
- **When to use:** Use only when `harness-write` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite standard --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/schemas/action-registry.schema.json`](../../../law/schemas/action-registry.schema.json#/properties/entries/items/properties/effect/enum); [`law/policy/action-registry.json`](../../../law/policy/action-registry.json#/entries)
- **Related workflow:** `check`

<!-- devai:generated-entry category="effects" id="local-write" -->

### `local-write` — Local Write

- **Stable ID:** local-write
- **User-facing label:** Local Write
- **Purpose:** Declare the conservative `local-write` capability ceiling before authority and consent checks.
- **Population or projection:** The single canonical effects value `local-write` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** Not applicable: this value classifies a record; the enclosing operation owns verdict semantics.
- **Declared effect:** `local-write`
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `fast`
- **When to use:** Use only when `local-write` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite standard --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/schemas/action-registry.schema.json`](../../../law/schemas/action-registry.schema.json#/properties/entries/items/properties/effect/enum); [`law/policy/action-registry.json`](../../../law/policy/action-registry.json#/entries)
- **Related workflow:** `check`

<!-- devai:generated-entry category="effects" id="remote-write" -->

### `remote-write` — Remote Write

- **Stable ID:** remote-write
- **User-facing label:** Remote Write
- **Purpose:** Declare the conservative `remote-write` capability ceiling before authority and consent checks.
- **Population or projection:** The single canonical effects value `remote-write` and all records that select it.
- **Prerequisites:** A schema-valid canonical record selecting this exact value.
- **Required external tools:** Not applicable: this is a vocabulary value, not an executable adapter.
- **Accepted inputs:** Accepted only where the linked canonical schema or policy exposes this exact value.
- **Defaults:** No undocumented value or alias is inferred.
- **Output contract:** Appears in the enclosing action, reading, catalog, or execution-evidence schema.
- **Verdict semantics:** Not applicable: this value classifies a record; the enclosing operation owns verdict semantics.
- **Declared effect:** `remote-write`
- **Consent flags:** `--write` and `--publish` are both required; neither implies the other.
- **Cost class:** `fast`
- **When to use:** Use only when `remote-write` exactly describes the canonical record.
- **When not to use:** Do not use as a synonym for another canonical value or as an authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite standard --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/schemas/action-registry.schema.json`](../../../law/schemas/action-registry.schema.json#/properties/entries/items/properties/effect/enum); [`law/policy/action-registry.json`](../../../law/policy/action-registry.json#/entries)
- **Related workflow:** `check`

<!-- devai:generated-reference:end category="effects" -->

## Effect ceilings and exact resolution

An action registry entry declares a conservative capability ceiling. Build-time and contract-time
analysis must prove that inferred direct and transitive effects stay within it. At runtime, the
exact target and selected member population still have to resolve before authority.

That distinction matters for parameterized facades:

- `devai sense run <kind>` resolves the named kind's intrinsic effect before execution. The generic
  action ceiling does not force a read-only kind to request unrelated mutation authority, and it
  does not let a write-capable kind travel through a read boundary.
- `devai check --suite <name>` and `devai check --only <member>` resolve the maximum effect of the
  selected validation plan before execution.
- An action that emits a report can still be write-capable when its implementation mutates a
  database, workspace, remote, or harness state.

Inspect a parameterized population without running it:

```sh
devai sense run type_check --repo-root . --dry-run --format json
```

## Consent flags

Consent is invocation-scoped and independent:

- a non-read resolved effect requires explicit `--write`;
- every remote resolved effect additionally requires explicit `--publish`, including a dry run;
- `--publish` never implies `--write`;
- `--write` never implies `--publish`; and
- possession of a publication-capable action, role, model, adapter, or session does not satisfy
  either flag.

For a read-only action, a role declaration and write/publication consent are not applicable and
are refused rather than ignored. For a non-read action, provide exactly one `--as-role <role>` or
`--authority-session <id>`, not both. A caller cannot declare a machine actor.

A remote dry run performs no publication, but a selected sensor whose resolved effect is
`remote-write` still requires its permitted role and both independent consent flags,
`--write` and `--publish`.

## Safe examples

Read without a role declaration or consent:

```sh
devai release status --repo-root . --format json
devai evidence verify --scope chain --show-head --repo-root . --format json
```

Inspect a local-write leaf without dispatching it:

```sh
devai init apply architect --target . --tier tier1 --as-role architect --write --help
```

Perform that local write only after reviewing `init plan`:

```sh
devai init apply architect --target . --tier tier1 --as-role architect --write --format json
```

Inspect the remote-capable sensor action without dispatching it:

```sh
devai sense run --help
```

The last command is help-only. A selected sensor kind determines the actual effect and consent.

## Refusals and non-pass behavior

Authority is checked before handler dispatch. Typical refusals include a missing, conflicting,
invalid, expired, stale, repository-mismatched, or policy-mismatched declaration; a role not
allowed by the action; missing write or publication consent; unresolved target; unclassified
resource; or absent final mutation boundary.

These conditions produce one structured error envelope and no successful result envelope. Usage
and policy refusals do not become `review` or `unknown`; they prevent execution. Infrastructure and
contract violations use their own failure classes and cannot be treated as a completed action.

For an aggregate command, read the [verdict descriptor](./vocabulary.md#verdicts) after authority
succeeds. A permitted operation may still return review, unknown, fail, error, skipped, or N/A.
Authorization means only that the bounded attempt was allowed.

## Executor authority is forbidden

An executor says how to attempt a task. The host selects a provider and exact model; DEVAI owns no
fixed roster, alias, preferred/default model, or policy fallback. Missing or unavailable selection
fails closed without substitution. The selected model does not widen task discipline, target
paths, effects, or consent. Execution evidence records the exact host selection; it does not grant
authority retroactively.

See [rounds, tasks, and executors](./round-task-executors.md#authority-stays-with-discipline) and
the generated [model/runtime reference](./model-runtime.md).

## Nonclaims

A policy allow proves only that one resolved invocation may attempt its bounded effects. It does
not prove the command's verdict, readiness, round closure, release eligibility, publication
success, deployment, or evidence promotion.

Canonical sources: [action registry](../../../law/policy/action-registry.json),
[runtime authority policy](../../../packages/cli/src/authority/policy.ts).
