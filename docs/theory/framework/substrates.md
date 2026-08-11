---
title: Substrates
sidebar_position: 2
---

# Substrates

> [Constitution Article 4](../../reference/law.md) declares five fundamental substrates. Every artifact in a DEVAI-governed repo belongs to exactly one. Each substrate has a distinct authority (Article 6), a distinct sensor regime, and a distinct role on the control loop.

## The five substrates

### F1 — Specification (the reference signal)

What the framework is trying to achieve. The reference signal _r(t)_ in control-theory terms.

- **Contents.** Business specs (Owner-authored journeys + use-cases under `product/`), engineering specs (Architect-authored arch notes + invariants + trace + ADRs under `docs/theory/architecture/`, `framework/adr/`), contracts (`docs/reference/contracts/`), glossary (`law/glossary/`, joint Owner+Architect).
- **Authors.** Owner for business tier, Architect for engineering tier, joint at glossary.
- **Sensor regime.** Contract and documentation tasks selected by `devai check`, plus registered sensor kinds resolved by `devai sense run`.

### F2 — Plant (the system under control)

The system the controller acts on. The plant _P_.

- **Contents.** All source code under `apps/`, `libs/`, `packages/` (in monorepo layouts); DB migrations under `db/migrations/`; seeds under `db/seeds/`; infrastructure-as-code under `iac/`; root-level build scripts.
- **Author.** Engineer.
- **Sensor regime.** Type-checker, linter, builder, test runners, and registered plant sensors.

### F3 — Observation (sensors on the plant)

The tests that measure what _P_ actually does, compared with what F1 says it should do. Sensors _y(t)_.

- **Contents.** All `**/*.spec.ts`, `**/*.test.ts`, `tests/`, `e2e/`, configuration files that encode test intent.
- **Author.** Inspector.
- **Sensor regime.** The task graph described by the [test policy](./test-policy.md), plus registered sensors that probe the observation substrate.

### F4 — Inventory (plant identification)

A derived model of _P_. The controller's view of the plant's current state _x̂_.

- **Contents.** Canonical read-only slices produced by `devai sense inventory` and registered sensor readings produced through the evidence boundary.
- **Author.** No one — F4 is derived from the repository and declared inputs.
- **Sensor regime.** Inventory and coherence sensor kinds resolved by `devai sense run`.

### F5 — Harness (the controller infrastructure)

The DEVAI machinery as instantiated in the client repo. The control system itself, not the plant.

- **Contents.** `.devai/` (excluding `inventory/` and `worktrees/`). The constitution as pinned, contracts schemas, skill manifests, agent prompts, role configurations, pack config.
- **Author.** Bound from declared sources with `devai init bind`; ordinary disciplines do not edit it directly.
- **Sensor regime.** Registered harness sensor kinds resolved by `devai sense run`.

## Authority-by-path enforcement

[Article 6](../../reference/law.md) — _"Authority is enforced by filesystem path. The harness refuses writes that violate this mapping at the tool layer, not at review time."_

This is the load-bearing semantic difference between DEVAI and a convention-based governance model. Authority is not "what reviewers expect" or "what the PR template says" — it's what the tool refuses at execution time.

A worker that tries to write outside its declared role's enumerated paths gets a refusal _before_ the write happens, not a flag _after_. The mapping is constitutional (immutable at the F1 Owner / F1 Architect / F2 / F3 / F4 / F5 level) and version-pinned per [Article 40](../../reference/law.md). Constitution 0.2.0 (R14) rewrote the F1 enumeration to point at the new section roots; clients pinned to 0.1.1 honour the old mapping until they upgrade.

## Substrate extensions

Clients MAY extend the path mapping for client-specific disciplines (e.g., adding a `db/` Engineer path for a NestJS service that has migrations at a non-default location). Extensions are **additive**; the core mapping is **immutable**.

A client extension lives in `.devai/config/` and is picked up by the harness at boot. Binding validates the declared extension without changing the core mapping.

## See also

- [Constitution Article 6](../../reference/law.md) — the path enumeration that this page commentates on.
- [Roles](../../roles) — how human and agent roles map to substrates.
- [Aspect grid](./aspect-grid.md) — the 5×9 grid of substrates × transversals.
