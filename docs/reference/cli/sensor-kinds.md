---
title: Sensor-kind catalog
---

# Sensor-kind catalog

This is the current canonical sensor descriptor reference, not a release or readiness claim.
The generated section derives its population and stable order from
the live sensor registry and joins preset membership from canonical preset policy. Edit the
sources or renderer, never the bytes between markers.

<!-- devai:generated-reference:start category="sensor-kinds" -->

## Sensor kinds

<!-- devai:generated-entry category="sensor-kinds" id="type_check" -->

### `type_check` — Type Check

- **Stable ID:** type_check
- **User-facing label:** Type Check
- **Purpose:** Run the registered `type_check` observation through `packages/sensors/src/type-check.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/type-check.ts`; standing scorecard cells `F2×T8`; preset membership `baseline`, `structural`, `governed`, `sweep`; registry tiers `BASELINE`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run type_check`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `type_check` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run type_check --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/type_check.md`](../../../law/policy/sensor-notes/type_check.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="lint" -->

### `lint` — Lint

- **Stable ID:** lint
- **User-facing label:** Lint
- **Purpose:** Run the registered `lint` observation through `packages/sensors/src/lint.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/lint.ts`; standing scorecard cells `F2×T5`; preset membership `baseline`, `structural`, `governed`, `sweep`; registry tiers `BASELINE`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run lint`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `lint` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run lint --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/lint.md`](../../../law/policy/sensor-notes/lint.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="build" -->

### `build` — Build

- **Stable ID:** build
- **User-facing label:** Build
- **Purpose:** Run the registered `build` observation through `packages/sensors/src/build.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/build.ts`; standing scorecard cells `F2×T9`; preset membership `baseline`, `structural`, `governed`; registry tiers `BASELINE`, `SWEEP`.
- **Prerequisites:** Reviewed effect sources `packages/sensors/src/build.ts`, `packages/cli/src/command-manifest.ts`. Capabilities `proc:pnpm-build`, `fs:workspace`.
- **Required external tools:** Tools or services satisfying `proc:pnpm-build`, `fs:workspace`; exact availability is checked before execution.
- **Accepted inputs:** `sense run build`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and `--as-role <owner|architect|inspector|engineer|auditor>` or a live `--authority-session <id>` plus the declared consent flags.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `local-write` — The sensor executes the workspace build, whose compiler outputs materialize under package directories; fs:workspace derives local-write.
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `expensive`
- **When to use:** Use when the `build` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `local-write`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run build --repo-root . --as-role owner --write --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/build.md`](../../../law/policy/sensor-notes/build.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="unit_test" -->

### `unit_test` — Unit Test

- **Stable ID:** unit_test
- **User-facing label:** Unit Test
- **Purpose:** Run the registered `unit_test` observation through `packages/sensors/src/test.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/test.ts`; standing scorecard cells `F3×T1`; preset membership `baseline`, `structural`, `governed`; registry tiers `BASELINE`, `SWEEP`.
- **Prerequisites:** Reviewed effect sources `packages/sensors/src/test.ts`, `packages/cli/src/command-manifest.ts`. Capabilities `proc:pnpm-vitest`, `fs:f5-state`.
- **Required external tools:** Tools or services satisfying `proc:pnpm-vitest`, `fs:f5-state`; exact availability is checked before execution.
- **Accepted inputs:** `sense run unit_test`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and `--as-role <owner|architect|inspector|engineer|auditor>` or a live `--authority-session <id>` plus the declared consent flags.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `harness-write` — The sensor executes the unit-test harness, including bounded test-runtime materialization; the harness state capability derives harness-write.
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `expensive`
- **When to use:** Use when the `unit_test` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `harness-write`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run unit_test --repo-root . --as-role owner --write --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/unit_test.md`](../../../law/policy/sensor-notes/unit_test.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="integration_test" -->

### `integration_test` — Integration Test

- **Stable ID:** integration_test
- **User-facing label:** Integration Test
- **Purpose:** Run the registered `integration_test` observation through `packages/sensors/src/test.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/test.ts`; standing scorecard cells `F3×T1`; preset membership Not applicable: the canonical source declares no values; registry tiers `SWEEP`.
- **Prerequisites:** Reviewed effect sources `packages/sensors/src/test.ts`, `packages/cli/src/command-manifest.ts`. Capabilities `proc:pnpm-vitest`, `fs:f5-state`.
- **Required external tools:** Tools or services satisfying `proc:pnpm-vitest`, `fs:f5-state`; exact availability is checked before execution.
- **Accepted inputs:** `sense run integration_test`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and `--as-role <owner|architect|inspector|engineer|auditor>` or a live `--authority-session <id>` plus the declared consent flags.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `harness-write` — The sensor executes the integration-test harness and its bounded runtime fixtures; the harness state capability derives harness-write.
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `expensive`
- **When to use:** Use when the `integration_test` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `harness-write`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run integration_test --repo-root . --as-role owner --write --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/integration_test.md`](../../../law/policy/sensor-notes/integration_test.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="e2e_test" -->

### `e2e_test` — E2e Test

- **Stable ID:** e2e_test
- **User-facing label:** E2e Test
- **Purpose:** Run the registered `e2e_test` observation through `packages/sensors/src/test.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/test.ts`; standing scorecard cells `F3×T1`; preset membership Not applicable: the canonical source declares no values; registry tiers `SWEEP`.
- **Prerequisites:** Reviewed effect sources `packages/sensors/src/test.ts`, `packages/cli/src/command-manifest.ts`. Capabilities `proc:pnpm-vitest`, `fs:f5-state`.
- **Required external tools:** Tools or services satisfying `proc:pnpm-vitest`, `fs:f5-state`; exact availability is checked before execution.
- **Accepted inputs:** `sense run e2e_test`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and `--as-role <owner|architect|inspector|engineer|auditor>` or a live `--authority-session <id>` plus the declared consent flags.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `harness-write` — The sensor executes the end-to-end test harness and its bounded runtime fixtures; the harness state capability derives harness-write.
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `expensive`
- **When to use:** Use when the `e2e_test` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `harness-write`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run e2e_test --repo-root . --as-role owner --write --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/e2e_test.md`](../../../law/policy/sensor-notes/e2e_test.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="migration_check" -->

### `migration_check` — Migration Check

- **Stable ID:** migration_check
- **User-facing label:** Migration Check
- **Purpose:** Run the registered `migration_check` observation through `packages/sensors/src/migrate-check.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/migrate-check.ts`; standing scorecard cells `F2×T4`; preset membership Not applicable: the canonical source declares no values; registry tiers `SWEEP`.
- **Prerequisites:** Reviewed effect sources `packages/sensors/src/migrate-check.ts`, `packages/cli/src/command-manifest.ts`. Capabilities `proc:psql`, `db:write`, `fs:f5-state`.
- **Required external tools:** Tools or services satisfying `proc:psql`, `db:write`, `fs:f5-state`; exact availability is checked before execution.
- **Accepted inputs:** `sense run migration_check`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and `--as-role <owner|architect|inspector|engineer|auditor>` or a live `--authority-session <id>` plus the declared consent flags.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `local-write` — The sensor creates roles and tracking tables, applies migration SQL, and may persist a body; db:write derives local-write.
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `expensive`
- **When to use:** Use when the `migration_check` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `local-write`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run migration_check --repo-root . --as-role owner --write --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/migration_check.md`](../../../law/policy/sensor-notes/migration_check.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="inventory_regeneration" -->

### `inventory_regeneration` — Inventory Regeneration

- **Stable ID:** inventory_regeneration
- **User-facing label:** Inventory Regeneration
- **Purpose:** Run the registered `inventory_regeneration` observation through `packages/cli/src/commands/sense/readings-rebuild.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/cli/src/commands/sense/readings-rebuild.ts`; standing scorecard cells `F4×T9`; preset membership Not applicable: the canonical source declares no values; registry tiers `SWEEP`.
- **Prerequisites:** Reviewed effect sources `packages/cli/src/commands/sense/readings-rebuild.ts`, `packages/cli/src/command-manifest.ts`. Capabilities `fs:f5-state`.
- **Required external tools:** Tools or services satisfying `fs:f5-state`; exact availability is checked before execution.
- **Accepted inputs:** `sense run inventory_regeneration`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and `--as-role <owner|architect|inspector|engineer|auditor>` or a live `--authority-session <id>` plus the declared consent flags.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `harness-write` — The readings rebuild command writes synthesized SensorReading files below .devai/state, whose capability derives harness-write.
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `expensive`
- **When to use:** Use when the `inventory_regeneration` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `harness-write`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run inventory_regeneration --repo-root . --as-role owner --write --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/inventory_regeneration.md`](../../../law/policy/sensor-notes/inventory_regeneration.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="test_weakening_review" -->

### `test_weakening_review` — Test Weakening Review

- **Stable ID:** test_weakening_review
- **User-facing label:** Test Weakening Review
- **Purpose:** Run the registered `test_weakening_review` observation through `packages/sensors/src/test-weakening.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/test-weakening.ts`; standing scorecard cells `F3×T9`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run test_weakening_review`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `test_weakening_review` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run test_weakening_review --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/test_weakening_review.md`](../../../law/policy/sensor-notes/test_weakening_review.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="trace_resolution" -->

### `trace_resolution` — Trace Resolution

- **Stable ID:** trace_resolution
- **User-facing label:** Trace Resolution
- **Purpose:** Run the registered `trace_resolution` observation through `packages/sensors/src/trace-resolve.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/trace-resolve.ts`; standing scorecard cells `F1×T3`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run trace_resolution`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `trace_resolution` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run trace_resolution --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/trace_resolution.md`](../../../law/policy/sensor-notes/trace_resolution.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="security_scan" -->

### `security_scan` — Security Scan

- **Stable ID:** security_scan
- **User-facing label:** Security Scan
- **Purpose:** Run the registered `security_scan` observation through `packages/sensors/src/security-scan.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/security-scan.ts`; standing scorecard cells `F2×T6`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run security_scan`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `security_scan` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run security_scan --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/security_scan.md`](../../../law/policy/sensor-notes/security_scan.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="perf_test" -->

### `perf_test` — Perf Test

- **Stable ID:** perf_test
- **User-facing label:** Perf Test
- **Purpose:** Run the registered `perf_test` observation through `packages/sensors/src/perf-test.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/perf-test.ts`; standing scorecard cells `F2×T7`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run perf_test`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `perf_test` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run perf_test --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/perf_test.md`](../../../law/policy/sensor-notes/perf_test.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="llm_judge" -->

### `llm_judge` — Llm Judge

- **Stable ID:** llm_judge
- **User-facing label:** Llm Judge
- **Purpose:** Run the registered `llm_judge` observation through `packages/sensors/src/judge.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/judge.ts`; standing scorecard cells `F1×T3`; preset membership Not applicable: the canonical source declares no values; registry tiers `SWEEP`.
- **Prerequisites:** Reviewed effect sources `packages/sensors/src/judge.ts`, `packages/cli/src/commands/sense/adapters.ts`, `packages/cli/src/command-manifest.ts`. Capabilities `net:llm-provider`.
- **Required external tools:** Tools or services satisfying `net:llm-provider`; exact availability is checked before execution.
- **Accepted inputs:** `sense run llm_judge`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and `--as-role <owner|architect|inspector|engineer|auditor>` or a live `--authority-session <id>` plus the declared consent flags.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `remote-write` — The judge invokes a configured external model provider. The binding authority vocabulary conservatively derives remote-write from every net capability.
- **Consent flags:** `--write` and `--publish` are both required; neither implies the other.
- **Cost class:** `external-dependent`
- **When to use:** Use when the `llm_judge` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `remote-write`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run llm_judge --repo-root . --as-role owner --write --publish --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/llm_judge.md`](../../../law/policy/sensor-notes/llm_judge.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="runtime_probe_api" -->

### `runtime_probe_api` — Runtime Probe Api

- **Stable ID:** runtime_probe_api
- **User-facing label:** Runtime Probe Api
- **Purpose:** Run the registered `runtime_probe_api` observation through `packages/sensors/src/runtime-probe.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/runtime-probe.ts`; standing diagnostic-only; preset membership Not applicable: the canonical source declares no values; registry tiers `SWEEP`.
- **Prerequisites:** Reviewed effect sources `packages/sensors/src/runtime-probe.ts`, `packages/cli/src/command-manifest.ts`. Capabilities `net:runtime-probe`.
- **Required external tools:** Tools or services satisfying `net:runtime-probe`; exact availability is checked before execution.
- **Accepted inputs:** `sense run runtime_probe_api`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and `--as-role <owner|architect|inspector|engineer|auditor>` or a live `--authority-session <id>` plus the declared consent flags.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `remote-write` — API charters issue network requests with caller-declared HTTP methods and optional bodies; net capability conservatively derives remote-write.
- **Consent flags:** `--write` and `--publish` are both required; neither implies the other.
- **Cost class:** `external-dependent`
- **When to use:** Use when the `runtime_probe_api` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `remote-write`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run runtime_probe_api --repo-root . --as-role owner --write --publish --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/runtime_probe_api.md`](../../../law/policy/sensor-notes/runtime_probe_api.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="runtime_probe_auth" -->

### `runtime_probe_auth` — Runtime Probe Auth

- **Stable ID:** runtime_probe_auth
- **User-facing label:** Runtime Probe Auth
- **Purpose:** Run the registered `runtime_probe_auth` observation through `packages/sensors/src/runtime-probe.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/runtime-probe.ts`; standing diagnostic-only; preset membership Not applicable: the canonical source declares no values; registry tiers `SWEEP`.
- **Prerequisites:** Reviewed effect sources `packages/sensors/src/runtime-probe.ts`, `packages/cli/src/command-manifest.ts`. Capabilities `net:runtime-probe`.
- **Required external tools:** Tools or services satisfying `net:runtime-probe`; exact availability is checked before execution.
- **Accepted inputs:** `sense run runtime_probe_auth`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and `--as-role <owner|architect|inspector|engineer|auditor>` or a live `--authority-session <id>` plus the declared consent flags.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `remote-write` — Auth charters issue credentialed network requests with caller-declared HTTP methods and optional bodies; net capability derives remote-write.
- **Consent flags:** `--write` and `--publish` are both required; neither implies the other.
- **Cost class:** `external-dependent`
- **When to use:** Use when the `runtime_probe_auth` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `remote-write`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run runtime_probe_auth --repo-root . --as-role owner --write --publish --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/runtime_probe_auth.md`](../../../law/policy/sensor-notes/runtime_probe_auth.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="runtime_probe_data" -->

### `runtime_probe_data` — Runtime Probe Data

- **Stable ID:** runtime_probe_data
- **User-facing label:** Runtime Probe Data
- **Purpose:** Run the registered `runtime_probe_data` observation through `packages/sensors/src/runtime-probe-data.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/runtime-probe-data.ts`; standing diagnostic-only; preset membership Not applicable: the canonical source declares no values; registry tiers `SWEEP`.
- **Prerequisites:** Reviewed effect sources `packages/sensors/src/runtime-probe-data.ts`, `packages/cli/src/command-manifest.ts`. Capabilities `net:runtime-probe`, `db:unclassified`.
- **Required external tools:** Tools or services satisfying `net:runtime-probe`, `db:unclassified`; exact availability is checked before execution.
- **Accepted inputs:** `sense run runtime_probe_data`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and `--as-role <owner|architect|inspector|engineer|auditor>` or a live `--authority-session <id>` plus the declared consent flags.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `remote-write` — Data charters open a target connection and may permit idempotent or isolated destructive SQL; net capability conservatively derives remote-write.
- **Consent flags:** `--write` and `--publish` are both required; neither implies the other.
- **Cost class:** `external-dependent`
- **When to use:** Use when the `runtime_probe_data` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `remote-write`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run runtime_probe_data --repo-root . --as-role owner --write --publish --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/runtime_probe_data.md`](../../../law/policy/sensor-notes/runtime_probe_data.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="inventory_api" -->

### `inventory_api` — Inventory Api

- **Stable ID:** inventory_api
- **User-facing label:** Inventory Api
- **Purpose:** Run the registered `inventory_api` observation through `packages/sensors/src/inventory-api.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/inventory-api.ts`; standing scorecard cells `F4×T1`, `F4×T2`; preset membership `structural`, `governed`, `sweep`; registry tiers `TIER2`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run inventory_api`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `inventory_api` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run inventory_api --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/inventory_api.md`](../../../law/policy/sensor-notes/inventory_api.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="inventory_routes" -->

### `inventory_routes` — Inventory Routes

- **Stable ID:** inventory_routes
- **User-facing label:** Inventory Routes
- **Purpose:** Run the registered `inventory_routes` observation through `packages/sensors/src/inventory-routes.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/inventory-routes.ts`; standing scorecard cells `F4×T1`, `F4×T2`; preset membership `structural`, `governed`, `sweep`; registry tiers `TIER2`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run inventory_routes`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `inventory_routes` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run inventory_routes --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/inventory_routes.md`](../../../law/policy/sensor-notes/inventory_routes.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="inventory_data_model" -->

### `inventory_data_model` — Inventory Data Model

- **Stable ID:** inventory_data_model
- **User-facing label:** Inventory Data Model
- **Purpose:** Run the registered `inventory_data_model` observation through `packages/sensors/src/inventory-data-model.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/inventory-data-model.ts`; standing scorecard cells `F4×T1`, `F4×T2`; preset membership `structural`, `governed`, `sweep`; registry tiers `TIER2`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run inventory_data_model`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `inventory_data_model` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run inventory_data_model --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/inventory_data_model.md`](../../../law/policy/sensor-notes/inventory_data_model.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="inventory_rbac" -->

### `inventory_rbac` — Inventory Rbac

- **Stable ID:** inventory_rbac
- **User-facing label:** Inventory Rbac
- **Purpose:** Run the registered `inventory_rbac` observation through `packages/sensors/src/inventory-rbac.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/inventory-rbac.ts`; standing scorecard cells `F4×T1`, `F4×T6`; preset membership `structural`, `governed`, `sweep`; registry tiers `TIER2`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run inventory_rbac`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `inventory_rbac` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run inventory_rbac --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/inventory_rbac.md`](../../../law/policy/sensor-notes/inventory_rbac.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="inventory_data_handling" -->

### `inventory_data_handling` — Inventory Data Handling

- **Stable ID:** inventory_data_handling
- **User-facing label:** Inventory Data Handling
- **Purpose:** Run the registered `inventory_data_handling` observation through `packages/sensors/src/inventory-data-handling.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/inventory-data-handling.ts`; standing scorecard cells `F4×T1`, `F4×T6`; preset membership `structural`, `governed`, `sweep`; registry tiers `TIER2`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run inventory_data_handling`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `inventory_data_handling` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run inventory_data_handling --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/inventory_data_handling.md`](../../../law/policy/sensor-notes/inventory_data_handling.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="inventory_dep_graph" -->

### `inventory_dep_graph` — Inventory Dep Graph

- **Stable ID:** inventory_dep_graph
- **User-facing label:** Inventory Dep Graph
- **Purpose:** Run the registered `inventory_dep_graph` observation through `packages/sensors/src/inventory-dep-graph.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/inventory-dep-graph.ts`; standing scorecard cells `F4×T1`, `F4×T3`; preset membership `structural`, `governed`, `sweep`; registry tiers `TIER2`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run inventory_dep_graph`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `inventory_dep_graph` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run inventory_dep_graph --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/inventory_dep_graph.md`](../../../law/policy/sensor-notes/inventory_dep_graph.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="inventory_coverage" -->

### `inventory_coverage` — Inventory Coverage

- **Stable ID:** inventory_coverage
- **User-facing label:** Inventory Coverage
- **Purpose:** Run the registered `inventory_coverage` observation through `packages/sensors/src/inventory-coverage.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/inventory-coverage.ts`; standing scorecard cells `F4×T1`, `F4×T2`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run inventory_coverage`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `inventory_coverage` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run inventory_coverage --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/inventory_coverage.md`](../../../law/policy/sensor-notes/inventory_coverage.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="spec_depth" -->

### `spec_depth` — Spec Depth

- **Stable ID:** spec_depth
- **User-facing label:** Spec Depth
- **Purpose:** Run the registered `spec_depth` observation through `packages/sensors/src/spec-depth.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/spec-depth.ts`; standing scorecard cells `F1×T2`; preset membership `structural`, `governed`, `sweep`; registry tiers `TIER2`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run spec_depth`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `spec_depth` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run spec_depth --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/spec_depth.md`](../../../law/policy/sensor-notes/spec_depth.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="spec_idiomaticity" -->

### `spec_idiomaticity` — Spec Idiomaticity

- **Stable ID:** spec_idiomaticity
- **User-facing label:** Spec Idiomaticity
- **Purpose:** Run the registered `spec_idiomaticity` observation through `packages/sensors/src/spec-idiomaticity.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/spec-idiomaticity.ts`; standing scorecard cells `F1×T5`; preset membership `governed`, `sweep`; registry tiers `TIER3`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run spec_idiomaticity`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `spec_idiomaticity` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run spec_idiomaticity --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/spec_idiomaticity.md`](../../../law/policy/sensor-notes/spec_idiomaticity.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="spec_freshness" -->

### `spec_freshness` — Spec Freshness

- **Stable ID:** spec_freshness
- **User-facing label:** Spec Freshness
- **Purpose:** Run the registered `spec_freshness` observation through `packages/sensors/src/spec-freshness.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/spec-freshness.ts`; standing scorecard cells `F1×T9`; preset membership `governed`, `sweep`; registry tiers `TIER3`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run spec_freshness`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `spec_freshness` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run spec_freshness --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/spec_freshness.md`](../../../law/policy/sensor-notes/spec_freshness.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="plant_coverage" -->

### `plant_coverage` — Plant Coverage

- **Stable ID:** plant_coverage
- **User-facing label:** Plant Coverage
- **Purpose:** Run the registered `plant_coverage` observation through `packages/sensors/src/plant-coverage.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/plant-coverage.ts`; standing scorecard cells `F2×T1`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run plant_coverage`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `plant_coverage` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run plant_coverage --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/plant_coverage.md`](../../../law/policy/sensor-notes/plant_coverage.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="test_coverage_depth" -->

### `test_coverage_depth` — Test Coverage Depth

- **Stable ID:** test_coverage_depth
- **User-facing label:** Test Coverage Depth
- **Purpose:** Run the registered `test_coverage_depth` observation through `packages/sensors/src/test-coverage-depth.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/test-coverage-depth.ts`; standing scorecard cells `F3×T2`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run test_coverage_depth`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `test_coverage_depth` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run test_coverage_depth --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/test_coverage_depth.md`](../../../law/policy/sensor-notes/test_coverage_depth.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="test_invariant_alignment" -->

### `test_invariant_alignment` — Test Invariant Alignment

- **Stable ID:** test_invariant_alignment
- **User-facing label:** Test Invariant Alignment
- **Purpose:** Run the registered `test_invariant_alignment` observation through `packages/sensors/src/test-invariant-alignment.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/test-invariant-alignment.ts`; standing scorecard cells `F3×T4`; preset membership `governed`, `sweep`; registry tiers `TIER3`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run test_invariant_alignment`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `test_invariant_alignment` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run test_invariant_alignment --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/test_invariant_alignment.md`](../../../law/policy/sensor-notes/test_invariant_alignment.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="inventory_adherence" -->

### `inventory_adherence` — Inventory Adherence

- **Stable ID:** inventory_adherence
- **User-facing label:** Inventory Adherence
- **Purpose:** Run the registered `inventory_adherence` observation through `packages/sensors/src/inventory-adherence.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/inventory-adherence.ts`; standing scorecard cells `F4×T4`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run inventory_adherence`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `inventory_adherence` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run inventory_adherence --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/inventory_adherence.md`](../../../law/policy/sensor-notes/inventory_adherence.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="inventory_determinism" -->

### `inventory_determinism` — Inventory Determinism

- **Stable ID:** inventory_determinism
- **User-facing label:** Inventory Determinism
- **Purpose:** Run the registered `inventory_determinism` observation through `packages/sensors/src/inventory-determinism.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/inventory-determinism.ts`; standing scorecard cells `F4×T8`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run inventory_determinism`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `inventory_determinism` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run inventory_determinism --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/inventory_determinism.md`](../../../law/policy/sensor-notes/inventory_determinism.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="harness_security" -->

### `harness_security` — Harness Security

- **Stable ID:** harness_security
- **User-facing label:** Harness Security
- **Purpose:** Run the registered `harness_security` observation through `packages/sensors/src/harness-security.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/harness-security.ts`; standing scorecard cells `F5×T6`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run harness_security`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `harness_security` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run harness_security --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/harness_security.md`](../../../law/policy/sensor-notes/harness_security.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="harness_green_main" -->

### `harness_green_main` — Harness Green Main

- **Stable ID:** harness_green_main
- **User-facing label:** Harness Green Main
- **Purpose:** Run the registered `harness_green_main` observation through `packages/sensors/src/harness-green-main.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/harness-green-main.ts`; standing scorecard cells `F5×T9`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run harness_green_main`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `harness_green_main` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run harness_green_main --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/harness_green_main.md`](../../../law/policy/sensor-notes/harness_green_main.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="spec_alignment" -->

### `spec_alignment` — Spec Alignment

- **Stable ID:** spec_alignment
- **User-facing label:** Spec Alignment
- **Purpose:** Run the registered `spec_alignment` observation through `packages/sensors/src/spec-alignment.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/spec-alignment.ts`; standing scorecard cells `F1×T4`; preset membership `structural`, `governed`, `sweep`; registry tiers `TIER2`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run spec_alignment`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `spec_alignment` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run spec_alignment --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/spec_alignment.md`](../../../law/policy/sensor-notes/spec_alignment.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="spec_security_coverage" -->

### `spec_security_coverage` — Spec Security Coverage

- **Stable ID:** spec_security_coverage
- **User-facing label:** Spec Security Coverage
- **Purpose:** Run the registered `spec_security_coverage` observation through `packages/sensors/src/spec-security-coverage.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/spec-security-coverage.ts`; standing scorecard cells `F1×T6`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run spec_security_coverage`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `spec_security_coverage` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run spec_security_coverage --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/spec_security_coverage.md`](../../../law/policy/sensor-notes/spec_security_coverage.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="spec_performance_targets" -->

### `spec_performance_targets` — Spec Performance Targets

- **Stable ID:** spec_performance_targets
- **User-facing label:** Spec Performance Targets
- **Purpose:** Run the registered `spec_performance_targets` observation through `packages/sensors/src/spec-performance-targets.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/spec-performance-targets.ts`; standing scorecard cells `F1×T7`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run spec_performance_targets`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `spec_performance_targets` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run spec_performance_targets --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/spec_performance_targets.md`](../../../law/policy/sensor-notes/spec_performance_targets.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="spec_robustness_targets" -->

### `spec_robustness_targets` — Spec Robustness Targets

- **Stable ID:** spec_robustness_targets
- **User-facing label:** Spec Robustness Targets
- **Purpose:** Run the registered `spec_robustness_targets` observation through `packages/sensors/src/spec-robustness-targets.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/spec-robustness-targets.ts`; standing scorecard cells `F1×T8`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run spec_robustness_targets`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `spec_robustness_targets` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run spec_robustness_targets --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/spec_robustness_targets.md`](../../../law/policy/sensor-notes/spec_robustness_targets.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="plant_depth" -->

### `plant_depth` — Plant Depth

- **Stable ID:** plant_depth
- **User-facing label:** Plant Depth
- **Purpose:** Run the registered `plant_depth` observation through `packages/sensors/src/plant-depth.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/plant-depth.ts`; standing scorecard cells `F2×T2`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run plant_depth`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `plant_depth` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run plant_depth --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/plant_depth.md`](../../../law/policy/sensor-notes/plant_depth.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="plant_coherence" -->

### `plant_coherence` — Plant Coherence

- **Stable ID:** plant_coherence
- **User-facing label:** Plant Coherence
- **Purpose:** Run the registered `plant_coherence` observation through `packages/sensors/src/plant-coherence.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/plant-coherence.ts`; standing scorecard cells `F2×T3`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run plant_coherence`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `plant_coherence` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run plant_coherence --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/plant_coherence.md`](../../../law/policy/sensor-notes/plant_coherence.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="test_coherence" -->

### `test_coherence` — Test Coherence

- **Stable ID:** test_coherence
- **User-facing label:** Test Coherence
- **Purpose:** Run the registered `test_coherence` observation through `packages/sensors/src/test-coherence.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/test-coherence.ts`; standing scorecard cells `F3×T3`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run test_coherence`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `test_coherence` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run test_coherence --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/test_coherence.md`](../../../law/policy/sensor-notes/test_coherence.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="test_idiomaticity" -->

### `test_idiomaticity` — Test Idiomaticity

- **Stable ID:** test_idiomaticity
- **User-facing label:** Test Idiomaticity
- **Purpose:** Run the registered `test_idiomaticity` observation through `packages/sensors/src/test-idiomaticity.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/test-idiomaticity.ts`; standing scorecard cells `F3×T5`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run test_idiomaticity`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `test_idiomaticity` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run test_idiomaticity --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/test_idiomaticity.md`](../../../law/policy/sensor-notes/test_idiomaticity.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="test_security_coverage" -->

### `test_security_coverage` — Test Security Coverage

- **Stable ID:** test_security_coverage
- **User-facing label:** Test Security Coverage
- **Purpose:** Run the registered `test_security_coverage` observation through `packages/sensors/src/test-security-coverage.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/test-security-coverage.ts`; standing scorecard cells `F3×T6`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run test_security_coverage`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `test_security_coverage` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run test_security_coverage --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/test_security_coverage.md`](../../../law/policy/sensor-notes/test_security_coverage.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="test_performance_coverage" -->

### `test_performance_coverage` — Test Performance Coverage

- **Stable ID:** test_performance_coverage
- **User-facing label:** Test Performance Coverage
- **Purpose:** Run the registered `test_performance_coverage` observation through `packages/sensors/src/test-performance-coverage.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/test-performance-coverage.ts`; standing scorecard cells `F3×T7`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run test_performance_coverage`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `test_performance_coverage` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run test_performance_coverage --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/test_performance_coverage.md`](../../../law/policy/sensor-notes/test_performance_coverage.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="test_robustness_coverage" -->

### `test_robustness_coverage` — Test Robustness Coverage

- **Stable ID:** test_robustness_coverage
- **User-facing label:** Test Robustness Coverage
- **Purpose:** Run the registered `test_robustness_coverage` observation through `packages/sensors/src/test-robustness-coverage.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/test-robustness-coverage.ts`; standing scorecard cells `F3×T8`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run test_robustness_coverage`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `test_robustness_coverage` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run test_robustness_coverage --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/test_robustness_coverage.md`](../../../law/policy/sensor-notes/test_robustness_coverage.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="harness_coverage" -->

### `harness_coverage` — Harness Coverage

- **Stable ID:** harness_coverage
- **User-facing label:** Harness Coverage
- **Purpose:** Run the registered `harness_coverage` observation through `packages/sensors/src/harness-coverage.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/harness-coverage.ts`; standing scorecard cells `F5×T1`; preset membership `governed`, `sweep`; registry tiers `TIER3`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run harness_coverage`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `harness_coverage` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run harness_coverage --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/harness_coverage.md`](../../../law/policy/sensor-notes/harness_coverage.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="harness_depth" -->

### `harness_depth` — Harness Depth

- **Stable ID:** harness_depth
- **User-facing label:** Harness Depth
- **Purpose:** Run the registered `harness_depth` observation through `packages/sensors/src/harness-depth.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/harness-depth.ts`; standing scorecard cells `F5×T2`; preset membership `governed`, `sweep`; registry tiers `TIER3`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run harness_depth`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `harness_depth` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run harness_depth --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/harness_depth.md`](../../../law/policy/sensor-notes/harness_depth.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="harness_coherence" -->

### `harness_coherence` — Harness Coherence

- **Stable ID:** harness_coherence
- **User-facing label:** Harness Coherence
- **Purpose:** Run the registered `harness_coherence` observation through `packages/sensors/src/harness-coherence.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/harness-coherence.ts`; standing scorecard cells `F5×T3`; preset membership `governed`, `sweep`; registry tiers `TIER3`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run harness_coherence`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `harness_coherence` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run harness_coherence --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/harness_coherence.md`](../../../law/policy/sensor-notes/harness_coherence.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="harness_invariant_alignment" -->

### `harness_invariant_alignment` — Harness Invariant Alignment

- **Stable ID:** harness_invariant_alignment
- **User-facing label:** Harness Invariant Alignment
- **Purpose:** Run the registered `harness_invariant_alignment` observation through `packages/sensors/src/harness-invariant-alignment.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/harness-invariant-alignment.ts`; standing scorecard cells `F5×T4`; preset membership `governed`, `sweep`; registry tiers `TIER3`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run harness_invariant_alignment`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `harness_invariant_alignment` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run harness_invariant_alignment --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/harness_invariant_alignment.md`](../../../law/policy/sensor-notes/harness_invariant_alignment.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="harness_idiomaticity" -->

### `harness_idiomaticity` — Harness Idiomaticity

- **Stable ID:** harness_idiomaticity
- **User-facing label:** Harness Idiomaticity
- **Purpose:** Run the registered `harness_idiomaticity` observation through `packages/sensors/src/harness-idiomaticity.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/harness-idiomaticity.ts`; standing scorecard cells `F5×T5`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run harness_idiomaticity`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `harness_idiomaticity` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run harness_idiomaticity --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/harness_idiomaticity.md`](../../../law/policy/sensor-notes/harness_idiomaticity.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="harness_performance" -->

### `harness_performance` — Harness Performance

- **Stable ID:** harness_performance
- **User-facing label:** Harness Performance
- **Purpose:** Run the registered `harness_performance` observation through `packages/sensors/src/harness-performance.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/harness-performance.ts`; standing scorecard cells `F5×T7`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run harness_performance`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `harness_performance` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run harness_performance --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/harness_performance.md`](../../../law/policy/sensor-notes/harness_performance.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="harness_robustness" -->

### `harness_robustness` — Harness Robustness

- **Stable ID:** harness_robustness
- **User-facing label:** Harness Robustness
- **Purpose:** Run the registered `harness_robustness` observation through `packages/sensors/src/harness-robustness.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/harness-robustness.ts`; standing scorecard cells `F5×T8`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run harness_robustness`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `harness_robustness` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run harness_robustness --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/harness_robustness.md`](../../../law/policy/sensor-notes/harness_robustness.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="inventory_performance" -->

### `inventory_performance` — Inventory Performance

- **Stable ID:** inventory_performance
- **User-facing label:** Inventory Performance
- **Purpose:** Run the registered `inventory_performance` observation through `packages/sensors/src/inventory-performance.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/inventory-performance.ts`; standing scorecard cells `F4×T7`; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run inventory_performance`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `inventory_performance` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run inventory_performance --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/inventory_performance.md`](../../../law/policy/sensor-notes/inventory_performance.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="decision_record_integrity" -->

### `decision_record_integrity` — Decision Record Integrity

- **Stable ID:** decision_record_integrity
- **User-facing label:** Decision Record Integrity
- **Purpose:** Run the registered `decision_record_integrity` observation through `packages/loop/src/governance-ledger/index.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/loop/src/governance-ledger/index.ts`; standing diagnostic-only; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run decision_record_integrity`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `decision_record_integrity` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run decision_record_integrity --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/decision_record_integrity.md`](../../../law/policy/sensor-notes/decision_record_integrity.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="decision_citation_resolution" -->

### `decision_citation_resolution` — Decision Citation Resolution

- **Stable ID:** decision_citation_resolution
- **User-facing label:** Decision Citation Resolution
- **Purpose:** Run the registered `decision_citation_resolution` observation through `packages/loop/src/governance-ledger/index.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/loop/src/governance-ledger/index.ts`; standing diagnostic-only; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run decision_citation_resolution`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `decision_citation_resolution` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run decision_citation_resolution --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/decision_citation_resolution.md`](../../../law/policy/sensor-notes/decision_citation_resolution.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="archive_immutability" -->

### `archive_immutability` — Archive Immutability

- **Stable ID:** archive_immutability
- **User-facing label:** Archive Immutability
- **Purpose:** Run the registered `archive_immutability` observation through `packages/loop/src/governance-ledger/index.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/loop/src/governance-ledger/index.ts`; standing diagnostic-only; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run archive_immutability`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `archive_immutability` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run archive_immutability --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/archive_immutability.md`](../../../law/policy/sensor-notes/archive_immutability.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="round_record_integrity" -->

### `round_record_integrity` — Round Record Integrity

- **Stable ID:** round_record_integrity
- **User-facing label:** Round Record Integrity
- **Purpose:** Run the registered `round_record_integrity` observation through `packages/loop/src/governance-ledger/index.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/loop/src/governance-ledger/index.ts`; standing diagnostic-only; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run round_record_integrity`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `round_record_integrity` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run round_record_integrity --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/round_record_integrity.md`](../../../law/policy/sensor-notes/round_record_integrity.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="docs_drift" -->

### `docs_drift` — Docs Drift

- **Stable ID:** docs_drift
- **User-facing label:** Docs Drift
- **Purpose:** Run the registered `docs_drift` observation through `packages/sensors/src/docs-drift.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/docs-drift.ts`; standing scorecard cells `F5×T3`; preset membership `governed`, `sweep`; registry tiers `TIER3`, `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run docs_drift`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `docs_drift` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run docs_drift --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/docs_drift.md`](../../../law/policy/sensor-notes/docs_drift.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="site_drift" -->

### `site_drift` — Site Drift

- **Stable ID:** site_drift
- **User-facing label:** Site Drift
- **Purpose:** Run the registered `site_drift` observation through `packages/sensors/src/site-drift.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/site-drift.ts`; standing diagnostic-only; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run site_drift`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `site_drift` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run site_drift --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/site_drift.md`](../../../law/policy/sensor-notes/site_drift.md)
- **Related workflow:** `sense`

<!-- devai:generated-entry category="sensor-kinds" id="action_effect_inference" -->

### `action_effect_inference` — Action Effect Inference

- **Stable ID:** action_effect_inference
- **User-facing label:** Action Effect Inference
- **Purpose:** Run the registered `action_effect_inference` observation through `packages/sensors/src/action-effect-inference.ts` and emit its canonical reading.
- **Population or projection:** Emitter `packages/sensors/src/action-effect-inference.ts`; standing diagnostic-only; preset membership `sweep`; registry tiers `SWEEP`.
- **Prerequisites:** The registered emitter and a readable repository root. No additional capability is declared by the registry.
- **Required external tools:** Not applicable: no external tool is declared by the canonical sensor entry; the emitter still performs its own preflight.
- **Accepted inputs:** `sense run action_effect_inference`, `--repo-root <path>`, optional sensor-specific JSON through `--input`, `--dry-run`, and no role declaration for the resolved read-only kind.
- **Defaults:** Repository root `.`; no implicit persistence, preset, round, or sensor-specific input.
- **Output contract:** A schema-valid [`law/schemas/sensor-reading.schema.json`](../../../law/schemas/sensor-reading.schema.json) plus action-bound aggregate output when invoked in a preset.
- **Verdict semantics:** `pass` is an observation from this sensor, not a release claim; all non-pass states remain explicit.
- **Declared effect:** `read`
- **Consent flags:** No write or publish consent.
- **Cost class:** `moderate`
- **When to use:** Use when the `action_effect_inference` observation and its declared standing are required.
- **When not to use:** Do not use as a substitute for an acceptance suite, a different kind, or authority beyond `read`.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai sense run action_effect_inference --repo-root . --dry-run --format json`
- **Canonical source:** [`law/policy/sensor-registry.json`](../../../law/policy/sensor-registry.json#/entries); [`law/policy/sensor-notes/action_effect_inference.md`](../../../law/policy/sensor-notes/action_effect_inference.md)
- **Related workflow:** `sense`

<!-- devai:generated-reference:end category="sensor-kinds" -->
