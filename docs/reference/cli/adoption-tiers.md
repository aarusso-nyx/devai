# Adoption tiers

An adoption tier is a repository's declared governance floor. It says which obligations are
binding now and which higher obligations are still observed as advisory. It is a staged adoption
contract, not an edition of DEVAI and not a switch that hides commands.

The complete tier population and per-tier semantics below are generated from the canonical
round-execution policy. Narrative on this page explains selection and climbing without maintaining
a second membership list.

## What a tier changes

For an obligation at or below the declared tier:

- the obligation is **binding**;
- its non-passing result participates in the command's aggregate according to the canonical
  verdict contract; and
- a missing, malformed, unknown, or skipped required result cannot be relabelled as pass.

For an obligation above the declared tier:

- it remains evaluated or reported when the applicable command supports that observation;
- it is marked **advisory** and excluded from the binding aggregate; and
- its diagnostic value remains available for planning the climb.

The constitution, role-by-path discipline, effect resolution, and explicit consent rules remain
binding at every tier. A lower tier never authorizes a forbidden write, makes a remote operation
local, turns missing evidence into pass, or enables autonomous execution.

## What a tier does not select

A tier is independent of the other selectors:

- a [check suite](./check-suites.md) chooses an ordered validation population;
- a [sense preset](./sense-presets.md) chooses an ordered observation population;
- a [sensor kind](./sensor-kinds.md) chooses one sensor contract;
- an [inventory slice](./inventory-slices.md) chooses one repository projection; and
- a [surface tier](./vocabulary.md#surface-tiers) controls whether a route appears in default or
  expanded help.

Declaring a tier therefore does not automatically run a similarly sized suite or preset. Select
each command population explicitly for the gate or observation you need.

## Declare an initial tier

Preview the target first. The plan reports the exact segmented projection and performs no write:

```sh
devai init plan --target . --tier tier1 --format json
```

Review that output, then apply only the role-owned segments you intend to create. The
[CLI overview](./index.md) shows the role-separated sequence.
After application, read the declared posture:

```sh
devai doctor --repo-root . --format json
```

Do not infer the effective tier from which commands happen to be installed or from a previous
run. The project declaration and the canonical policy are the inputs. If a declaration is absent,
the project-config schema defines the default. Declare the intended tier explicitly instead of
relying on that default.

## Read binding and advisory results

`doctor` reports the effective tier and every applicable diagnosis. A finding above the declared
floor stays in the report with advisory standing. A binding finding participates in `doctor.ok`;
an advisory finding does not, even though its own diagnostic result remains visible.

```sh
devai doctor --repo-root . --format json
```

For checks and sensors, read the member-level descriptor as well as the aggregate. A passing
binding aggregate does not mean that advisory observations passed, that higher-tier obligations
were satisfied, or that the repository is eligible for release.

## Climb to a higher tier

Climbing is explicit and monotonic:

1. Ask for the target-tier checklist. This branch is plan-only; do not add a role declaration or
   write consent:

   ```sh
   devai init bind --help
   ```

2. Read the binding contract and provide only its exact required inputs. Help does not apply a
   mutation or bind a tier.
3. Complete changes through their owning roles and paths. The checklist does not widen a session's
   authority and does not execute those changes.
4. Update the repository's tier declaration through the authorized configuration transition.
5. Re-run `doctor` and the gate-required suite. The climb has standing only when the new binding
   population is actually evaluated; generating or completing a checklist is not itself a verdict.

If the requested target is not above the declared tier, the planner returns no climb steps. That
does not perform a downgrade. Unknown tiers, invalid configuration, unavailable prerequisites, or
failed binding checks remain explicit failures or diagnostics under their action contracts.

## Canonical tier descriptors

The renderer derives every stable identifier, label, exact obligation projection, prerequisite,
input/default, output/verdict behavior, effect/consent rule, cost class, use guidance, non-pass
semantics, example, source, and workflow link from
[`round-execution.json#/vocabularies/adoption_tiers`](../../../law/policy/round-execution.json) and
its declared supplemental sources.

<!-- devai:generated-reference:start category="adoption-tiers" -->

## Adoption tiers

<!-- devai:generated-entry category="adoption-tiers" id="tier1" -->

### `tier1` — Tier1

- **Stable ID:** tier1
- **User-facing label:** Tier1
- **Purpose:** Select the canonical `tier1` adoption tier.
- **Population or projection:** `constitution-and-policy-pin`, `project-config`, `baseline-sensors`, `quick-check-suite`
- **Prerequisites:** A readable repository root and a canonical descriptor that resolves every selected member.
- **Required external tools:** Not applicable: no additional external tool is declared by the canonical adoption tier descriptor.
- **Accepted inputs:** `--tier tier1` and `--target <path>`.
- **Defaults:** Target `.`; the current declared adoption tier remains authoritative and no climb is inferred.
- **Output contract:** action-envelope using law/schemas/action-result.schema.json.
- **Verdict semantics:** `pass` requires the complete projection; unsupported or unresolved members return an error and never a partial pass.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing action, not this vocabulary value.
- **Cost class:** `moderate`
- **When to use:** Use when the named adoption tier is the exact requested scope.
- **When not to use:** Do not treat it as a check suite, sense preset, or authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai init plan --tier tier1 --target . --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/adoption_tiers)
- **Related workflow:** `init`

<!-- devai:generated-entry category="adoption-tiers" id="tier2" -->

### `tier2` — Tier2

- **Stable ID:** tier2
- **User-facing label:** Tier2
- **Purpose:** Select the canonical `tier2` adoption tier.
- **Population or projection:** `constitution-and-policy-pin`, `project-config`, `baseline-sensors`, `quick-check-suite`, `structural-inventories`, `structural-sense-preset`, `standard-check-suite`
- **Prerequisites:** A readable repository root and a canonical descriptor that resolves every selected member.
- **Required external tools:** Not applicable: no additional external tool is declared by the canonical adoption tier descriptor.
- **Accepted inputs:** `--tier tier2` and `--target <path>`.
- **Defaults:** Target `.`; the current declared adoption tier remains authoritative and no climb is inferred.
- **Output contract:** action-envelope using law/schemas/action-result.schema.json.
- **Verdict semantics:** `pass` requires the complete projection; unsupported or unresolved members return an error and never a partial pass.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing action, not this vocabulary value.
- **Cost class:** `moderate`
- **When to use:** Use when the named adoption tier is the exact requested scope.
- **When not to use:** Do not treat it as a check suite, sense preset, or authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai init plan --tier tier2 --target . --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/adoption_tiers)
- **Related workflow:** `init`

<!-- devai:generated-entry category="adoption-tiers" id="tier3" -->

### `tier3` — Tier3

- **Stable ID:** tier3
- **User-facing label:** Tier3
- **Purpose:** Select the canonical `tier3` adoption tier.
- **Population or projection:** `constitution-and-policy-pin`, `project-config`, `baseline-sensors`, `quick-check-suite`, `structural-inventories`, `structural-sense-preset`, `standard-check-suite`, `governed-trace-and-harness-controls`, `governed-sense-preset`, `full-check-suite`
- **Prerequisites:** A readable repository root and a canonical descriptor that resolves every selected member.
- **Required external tools:** Not applicable: no additional external tool is declared by the canonical adoption tier descriptor.
- **Accepted inputs:** `--tier tier3` and `--target <path>`.
- **Defaults:** Target `.`; the current declared adoption tier remains authoritative and no climb is inferred.
- **Output contract:** action-envelope using law/schemas/action-result.schema.json.
- **Verdict semantics:** `pass` requires the complete projection; unsupported or unresolved members return an error and never a partial pass.
- **Declared effect:** Not applicable: this vocabulary value grants no action effect.
- **Consent flags:** Not applicable: consent belongs to the enclosing action, not this vocabulary value.
- **Cost class:** `moderate`
- **When to use:** Use when the named adoption tier is the exact requested scope.
- **When not to use:** Do not treat it as a check suite, sense preset, or authority grant.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai init plan --tier tier3 --target . --format json`
- **Canonical source:** [`law/policy/round-execution.json`](../../../law/policy/round-execution.json#/vocabularies/adoption_tiers)
- **Related workflow:** `init`

<!-- devai:generated-reference:end category="adoption-tiers" -->

## Nonclaims

A tier declaration is not a readiness certificate. A `doctor` result describes its exact
repository and invocation; a suite or preset describes its exact population; release control has
its own separately authorized inputs and effects. Moving to a higher tier does not publish,
deploy, close a round, or promote evidence.

Canonical sources: [action registry](../../../law/policy/action-registry.json),
[round-execution policy](../../../law/policy/round-execution.json), and
[project-config schema](../../../law/schemas/project-config.schema.json).
