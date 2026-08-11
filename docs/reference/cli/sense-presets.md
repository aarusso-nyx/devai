---
title: Sense presets
---

# Select and run a sense preset

A sense preset selects an ordered observation population through `devai sense run`.
The generated reference below is rendered from the preset policy and sensor registry;
it is the lookup authority for current membership, exclusions, order, prerequisites,
effects, costs, outputs, and examples. This page does not carry a second copy of those
mutable populations.

<!-- devai:generated-reference:start category="sense-presets" -->

## Sense presets

<!-- devai:generated-entry category="sense-presets" id="baseline" -->

### `baseline` — Baseline

- **Stable ID:** baseline
- **User-facing label:** Baseline
- **Purpose:** Resolve and observe the canonical `baseline` sensor population without implicit reading persistence.
- **Population or projection:** `build`, `lint`, `type_check`, `unit_test`. Excluded: none.
- **Prerequisites:** A repository root; each resolved emitter checks its own inputs before execution.
- **Required external tools:** Emitter-specific tools are not enumerated by the preset source; every selected emitter must complete its own preflight.
- **Accepted inputs:** `--preset baseline`, `--repo-root <path>`, optional sensor-input JSON, `--dry-run`, `--as-role <owner|architect|inspector|engineer|auditor>` or a live `--authority-session <id>` plus required write consent, and an optional valid round ID.
- **Defaults:** No preset is implicit and persistence is forbidden. No round is required.
- **Output contract:** `one-action-bound-sensor-reading` per member and `total-result-with-explicit-executed-and-excluded-populations` for the complete resolved population.
- **Verdict semantics:** `unknown-or-error-never-pass`; aggregate output names both executed and excluded populations.
- **Declared effect:** `local-write` aggregate derived from the resolved members; each member retains its narrower exact effect.
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `expensive`
- **When to use:** Use to run the complete named `baseline` observation population.
- **When not to use:** Do not use as an acceptance suite, as implicit persistence, or to omit a required selected member.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run --preset baseline --repo-root . --as-role owner --write --dry-run --format json`
- **Canonical source:** [`law/policy/sense-presets.json`](../../../law/policy/sense-presets.json#/presets)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sense-presets" id="structural" -->

### `structural` — Structural

- **Stable ID:** structural
- **User-facing label:** Structural
- **Purpose:** Resolve and observe the canonical `structural` sensor population without implicit reading persistence.
- **Population or projection:** `build`, `lint`, `type_check`, `unit_test`, `inventory_api`, `inventory_routes`, `inventory_data_model`, `inventory_rbac`, `inventory_data_handling`, `inventory_dep_graph`, `spec_depth`, `spec_alignment`. Excluded: none.
- **Prerequisites:** A repository root; each resolved emitter checks its own inputs before execution.
- **Required external tools:** Emitter-specific tools are not enumerated by the preset source; every selected emitter must complete its own preflight.
- **Accepted inputs:** `--preset structural`, `--repo-root <path>`, optional sensor-input JSON, `--dry-run`, `--as-role <owner|architect|inspector|engineer|auditor>` or a live `--authority-session <id>` plus required write consent, and an optional valid round ID.
- **Defaults:** No preset is implicit and persistence is forbidden. No round is required.
- **Output contract:** `one-action-bound-sensor-reading` per member and `total-result-with-explicit-executed-and-excluded-populations` for the complete resolved population.
- **Verdict semantics:** `unknown-or-error-never-pass`; aggregate output names both executed and excluded populations.
- **Declared effect:** `local-write` aggregate derived from the resolved members; each member retains its narrower exact effect.
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `expensive`
- **When to use:** Use to run the complete named `structural` observation population.
- **When not to use:** Do not use as an acceptance suite, as implicit persistence, or to omit a required selected member.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run --preset structural --repo-root . --as-role owner --write --dry-run --format json`
- **Canonical source:** [`law/policy/sense-presets.json`](../../../law/policy/sense-presets.json#/presets)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sense-presets" id="governed" -->

### `governed` — Governed

- **Stable ID:** governed
- **User-facing label:** Governed
- **Purpose:** Resolve and observe the canonical `governed` sensor population without implicit reading persistence.
- **Population or projection:** `build`, `lint`, `type_check`, `unit_test`, `inventory_api`, `inventory_routes`, `inventory_data_model`, `inventory_rbac`, `inventory_data_handling`, `inventory_dep_graph`, `spec_depth`, `spec_alignment`, `spec_freshness`, `spec_idiomaticity`, `test_invariant_alignment`, `harness_coverage`, `harness_depth`, `harness_coherence`, `harness_invariant_alignment`, `docs_drift`. Excluded: none.
- **Prerequisites:** A repository root; each resolved emitter checks its own inputs before execution.
- **Required external tools:** Emitter-specific tools are not enumerated by the preset source; every selected emitter must complete its own preflight.
- **Accepted inputs:** `--preset governed`, `--repo-root <path>`, optional sensor-input JSON, `--dry-run`, `--as-role <owner|architect|inspector|engineer|auditor>` or a live `--authority-session <id>` plus required write consent, and an optional valid round ID.
- **Defaults:** No preset is implicit and persistence is forbidden. No round is required.
- **Output contract:** `one-action-bound-sensor-reading` per member and `total-result-with-explicit-executed-and-excluded-populations` for the complete resolved population.
- **Verdict semantics:** `unknown-or-error-never-pass`; aggregate output names both executed and excluded populations.
- **Declared effect:** `local-write` aggregate derived from the resolved members; each member retains its narrower exact effect.
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `expensive`
- **When to use:** Use to run the complete named `governed` observation population.
- **When not to use:** Do not use as an acceptance suite, as implicit persistence, or to omit a required selected member.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run --preset governed --repo-root . --as-role owner --write --dry-run --format json`
- **Canonical source:** [`law/policy/sense-presets.json`](../../../law/policy/sense-presets.json#/presets)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sense-presets" id="sweep" -->

### `sweep` — Sweep

- **Stable ID:** sweep
- **User-facing label:** Sweep
- **Purpose:** Resolve and observe the canonical `sweep` sensor population without implicit reading persistence.
- **Population or projection:** `type_check`, `lint`, `test_weakening_review`, `trace_resolution`, `security_scan`, `perf_test`, `inventory_api`, `inventory_routes`, `inventory_data_model`, `inventory_rbac`, `inventory_data_handling`, `inventory_dep_graph`, `inventory_coverage`, `spec_depth`, `spec_idiomaticity`, `spec_freshness`, `plant_coverage`, `test_coverage_depth`, `test_invariant_alignment`, `inventory_adherence`, `inventory_determinism`, `harness_security`, `harness_green_main`, `spec_alignment`, `spec_security_coverage`, `spec_performance_targets`, `spec_robustness_targets`, `plant_depth`, `plant_coherence`, `test_coherence`, `test_idiomaticity`, `test_security_coverage`, `test_performance_coverage`, `test_robustness_coverage`, `harness_coverage`, `harness_depth`, `harness_coherence`, `harness_invariant_alignment`, `harness_idiomaticity`, `harness_performance`, `harness_robustness`, `inventory_performance`, `decision_record_integrity`, `decision_citation_resolution`, `archive_immutability`, `round_record_integrity`, `docs_drift`, `site_drift`, `action_effect_inference`. Excluded: `build` — The registered build command writes compiled workspace outputs; `unit_test` — The test harness may create controlled test artifacts or isolated fixture state; `integration_test` — Integration execution may mutate isolated fixture databases and harness state; `e2e_test` — End-to-end execution may mutate isolated fixture services and harness state; `migration_check` — The sensor applies migrations, creates roles, and writes migration bookkeeping; `inventory_regeneration` — The regeneration command writes canonical harness inventory state; `llm_judge` — The sensor invokes an external model provider and net capability derives remote-write; `runtime_probe_api` — API charters may issue mutating HTTP requests and net capability derives remote-write; `runtime_probe_auth` — Auth charters may issue credentialed mutating HTTP requests and net capability derives remote-write; `runtime_probe_data` — Data charters may execute write SQL and net capability derives remote-write.
- **Prerequisites:** A repository root and explicit `--round R-NNNN`.
- **Required external tools:** Emitter-specific tools are not enumerated by the preset source; every selected emitter must complete its own preflight.
- **Accepted inputs:** `--preset sweep`, `--repo-root <path>`, optional sensor-input JSON, `--dry-run`, no role declaration for the resolved read-only population, and `--round R-NNNN`.
- **Defaults:** No preset is implicit and persistence is forbidden. A round is mandatory.
- **Output contract:** `one-action-bound-sensor-reading` per member and `total-result-with-explicit-executed-and-excluded-populations` for the complete resolved population.
- **Verdict semantics:** `unknown-or-error-never-pass`; aggregate output names both executed and excluded populations.
- **Declared effect:** `read` aggregate derived from the resolved members; each member retains its narrower exact effect.
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use to run the complete named `sweep` observation population.
- **When not to use:** Do not use as an acceptance suite, as implicit persistence, or to omit a required selected member.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run --preset sweep --round R-1000 --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sense-presets.json`](../../../law/policy/sense-presets.json#/presets)
- **Related workflow:** `sense`

<!-- devai:generated-reference:end category="sense-presets" -->

## Choose a preset

Select exactly one positional sensor kind or one `--preset`; the two forms are mutually
exclusive. Choose a preset when its complete declared population matches the observation
you need. Choose `sense run <kind>` when you need one registered observation. A preset
name never grants authority and never changes a member's intrinsic effect.

Inspect the resolved population without dispatching any sensor by using `--dry-run`:

```sh
devai sense run --preset baseline --as-role inspector --write --dry-run --format json
```

The dry-run result reports the exact executed and excluded populations, aggregate
effect, round requirement, consent boundary, and the fact that implicit persistence is
disabled. The current router still requires the selected population's local consent
before returning that preview. The preview does not dispatch a sensor and is not
observation evidence.

## Read-only sweep

The sweep preset is an exhaustive **read-only** registry projection, not an alias for
every sensor. It requires an explicit governed round, executes every sensor whose
canonical intrinsic effect is `read` in registry order, and reports every write-capable
sensor as excluded with a reason. The caller cannot omit a read-only member or add an
excluded member while retaining the sweep identity.

```sh
devai sense run --preset sweep --round R-1000 --format json
```

The round argument binds the observation to its round context. It does not persist the
readings, grant write authority, or turn excluded operations into skipped execution.
Run a write-capable kind separately only when its declared role, capabilities, and
consent are authorized.

## Persistence is separate

Preset execution never records a reading implicitly. Treat the returned readings as
the command output unless a separately authorized `sense record` invocation persists
them. `--write` consents only to the resolved local or harness effects of selected
members. `--publish` is additionally required only for a resolved remote-write member;
neither flag implies the other.

The runtime resolves every member before any adapter executes. Unknown kinds or presets, missing
or invalid round identity, missing effect data, or authority/consent refusal block dispatch. There
is no caller-selected omission.

## Interpret results conservatively

The aggregate distinguishes execution status from readiness status and reports executed
and excluded populations explicitly. PASS or an explicitly all-N/A population exits
`0`; review or unknown exits `1`; failure, malformed output, killed execution, or adapter
error exits `2`. A skipped sensor contributes to N/A. A policy exclusion is reported as
an exclusion rather than misrepresented as an executed skip.

Cost classes are relative and do not promise a duration. Provider, database, service,
or tool availability remains a runtime prerequisite when declared by a selected kind.

## Canonical descriptor

- [Sense-preset policy](../../../law/policy/sense-presets.json) — exact ordered
  membership, sweep projection, exclusions, persistence boundary, migration refusals,
  and output shape.
- [Sensor registry](../../../law/policy/sensor-registry.json) — canonical kinds,
  intrinsic effects, capability bases, emitters, and design-note routing.
- [Sense-preset schema](../../../law/schemas/sense-presets.schema.json) — closed preset
  shape and round requirement.
- [Sense presets](../../../law/policy/sense-presets.json) —
  effect resolution, read-only sweep, and fail-closed selection.
- [Sense action contract](../../../law/policy/action-registry.json) — public route,
  generic ceiling, consent, and output envelope.
