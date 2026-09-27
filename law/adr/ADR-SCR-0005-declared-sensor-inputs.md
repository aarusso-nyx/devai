---
id: ADR-SCR-0005
title: Sensor inputs are adopter declarations, including read-only host processes
type: adr
status: proposed
date: 2026-09-26
authority: Architect
supersedes: []
provenance:
  - law/constitution.md#article-6-substrate-authority-by-path
  - law/constitution.md#article-32-sensor-adapter-uniformity
  - law/adr/ADR-CHK-0001-preflight-probes-as-dag-nodes.md
  - law/policy/sensor-registry.json
  - packages/cli/src/commands/sense/shared.ts
affected_rules:
  - law/schemas/sensor-inputs.schema.json
  - .devai/config/sensor-inputs.json
  - law/policy/adopter-defaults/sensor-inputs.json
  - packages/cli/src/commands/sense/shared.ts
  - law/policy/authority-policy.json
  - packages/cli/src/authority/broker.ts
inspector_acceptance:
  - IA-001 -- A declared test root, ADR directory, coverage path, effects tsconfig, typecheck argv, or performance script is used by its sensor, and the effective inputs appear in the sweep dry run per member.
  - IA-002 -- An explicit --input for the same key overrides the declaration for that run only.
  - IA-003 -- An undeclared key, a kind absent from the registry, or a path outside the repository root is refused with a structured error and no sensor executes.
  - IA-004 -- gh run list with the declared argv shape is admitted as a read-only process without a host adapter; gh with any other subcommand is refused.
  - IA-005 -- The site drift sensor verifies the provenance the publication path journals; a published tip without provenance reads unknown, never pass.
---

# Sensor inputs are adopter declarations, including read-only host processes

## Status

Proposed on 2026-09-26 by maintainer decision. Implemented by campaign CMP-0002, rounds R-0202 and R-0205.

## Context

The sweep against the framework repository showed that most review and
error outcomes are missing inputs, not defects: test discovery walks
`packages/*/test` while the repository uses `tests`, ADR discovery expects
`docs/meta/adr` while the records live in `law/adr`, the coverage sensor has
no coverage path, the effect inference sensor looks for an effects tsconfig
at the root, the type check sensor runs a bare `tsc --noEmit` against
project references, the performance sensor wants a `test:perf` script, and
three harness sensors fail because the authority broker cannot prove that
`gh run list` is read-only. Each sensor carries defaults for a conventional
service layout; the framework is not that layout, and neither are many
adopters.

## Decision

Sensor inputs are declared by the adopter in `.devai/config/sensor-inputs.json`
under `law/schemas/sensor-inputs.schema.json`, keyed by registered sensor
kind. `sense run` validates the file, refuses undeclared keys, unknown kinds,
and paths outside the repository, merges an explicit `--input` over it for
one run, and prints the effective inputs in a dry run. Sensor defaults stay
unchanged for adopters that declare nothing. The authority policy declares
`gh run list` with a fixed argv shape as a read-only host process the broker
admits without an adapter, mirroring the preflight probe admission. The site
drift sensor verifies the provenance the Pages publication path journals.

## Consequences

The framework declares its own layout once, and the same mechanism serves
adopters with unconventional layouts. Read-only host processes remain an
exact allowlist. Changing a default in a sensor is no longer the way to make
one repository pass.

## Alternatives Considered

Changing sensor defaults to the framework's layout is rejected because it
moves the problem to every adopter. Stack packs alone are rejected because
they tune parameters of a matched pack and cannot declare a path the pack
did not anticipate.

## Affected Rules

- `law/schemas/sensor-inputs.schema.json`, `.devai/config/sensor-inputs.json`, and the adopter default.
- `packages/cli/src/commands/sense/shared.ts` resolves and validates declarations.
- `law/policy/authority-policy.json` and `packages/cli/src/authority/broker.ts` admit the read-only process.

## Inspector Adversarial Acceptance

Discharged by `packages/cli/tests/unit/sense-inputs-declaration.test.ts`, `packages/sensors/tests/declared-inputs.test.ts`, `tests/contract/sensor-inputs.contract.test.ts`, and `packages/cli/tests/unit/authority-host-process-read-only.test.ts`.
