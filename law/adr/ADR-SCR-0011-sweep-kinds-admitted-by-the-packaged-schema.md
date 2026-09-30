---
id: ADR-SCR-0011
title: Every sweep read kind is admitted by the packaged SensorReading schema
type: adr
status: accepted
date: 2026-09-29
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0002
  - ADR-SCR-0005
  - ADR-SCR-0008
  - law/policy/sensor-registry.json
  - law/policy/sense-presets.json
  - law/schemas/sensor-reading.schema.json
  - docs/dev/operations/harness-convergence-extension-proposal.md
affected_rules:
  - law/schemas/sensor-reading.schema.json
  - law/policy/sensor-registry.json
  - law/policy/sense-presets.json
  - packages/sensors/src/sensor-reading.ts
  - packages/schemas/src/index.ts
  - docs/reference/cli/sensor-kinds.md
  - docs/adopters/sensor-inputs.md
inspector_acceptance:
  - IA-001 -- The registry-minus-schema set computed over every read kind the sweep preset selects is empty, and removing any one of decision_record_integrity, decision_citation_resolution, archive_immutability, or round_record_integrity from the schema enum turns the invariant test red.
  - IA-002 -- Each of the four kinds emitted through sense run validates at the installed JSON Schema boundary with command_hash, status, kind, effect, and every required field present; a reading whose kind is not in the enum is still rejected.
  - IA-003 -- A sensor of one of the four kinds that fails or is skipped records FAIL or skipped and is never promoted to PASS, and no scorecard cell changes verdict because a diagnostic kind was admitted.
  - IA-004 -- The registry, preset, and schema extracted from the packed tarball are byte-identical to source, every sweep read-kind reading validates against the packed schema, and no effect other than read appears in the sweep preset.
  - IA-005 -- A registry entry declared as intentionally unsupported by the schema is refused before the sensor runs with a named code, never emitted as an invalid reading.
---

# Every sweep read kind is admitted by the packaged SensorReading schema

## Status

Accepted on 2026-09-30 by the Architect before round R-0308 opened; proposed on
2026-09-29 from DETRAN R-0020 CTG-0004 (#184). Extends
the reading contract of ADR-SCR-0002 and ADR-SCR-0005 by one invariant; the
recording order and supersession rules of ADR-SCR-0008 are unchanged.

## Context

`law/policy/sensor-registry.json` declares fifty-nine kinds, forty-nine of
them `effect: read`, and `law/policy/sense-presets.json` selects every read
kind into the `sweep` preset. The kind enum in
`law/schemas/sensor-reading.schema.json` lists sixty values, and four
registry kinds are not among them: `decision_record_integrity`,
`decision_citation_resolution`, `archive_immutability`, and
`round_record_integrity`. Five enum values name no registry entry. The
sweep therefore emits four readings that the package's own schema rejects,
the adopter preflight reports four `SENSOR_KIND_NOT_IN_SCHEMA` failures, and
DETRAN's full check stops at that gate (#184). Verified against this
checkout on 2026-09-29: each of the four occurs three times in the registry
and zero times in the schema.

The four are diagnostic kinds. None maps to a scorecard cell, so admitting
them changes no cell verdict. No test today relates the registry, the preset,
and the schema, so the gap was only found by an adopter comparing package
files.

## Decision

The kind enum admits the four kinds. The schema stays closed, every other
required field is unchanged, and the runtime validator in
`packages/sensors/src/sensor-reading.ts` and the schema roster in
`packages/schemas/src/index.ts` agree with the enum, so source and package
never disagree on the admitted set.

The registry and preset contract gains one invariant: every kind a preset
can select is admitted by the packaged schema. A source-level test computes
the registry-minus-schema set over every read kind in `sweep` and asserts it
is empty. If a registry entry is ever intentionally unsupported by the
schema, the registry says so on the entry and the runner refuses the sensor
before it starts with a named code; an invalid reading is never emitted.

The five schema-only legacy values are kept in this record and listed on the
sensor-kinds reference as legacy. Retiring them is a separate decision,
because readings recorded under them exist in adopter stores and ADR-SCR-0008
forbids rewriting a recorded reading.

The packed artifact is tested, not only source. The publication proof of
ADR-REL-0033 extracts the tarball, compares its registry, preset, and schema
to source, validates every sweep read-kind reading against the packed
schema, and confirms no effectful kind is in the read-only sweep.

## Consequences

The sweep emits forty-nine schema-valid readings, and DETRAN's preflight
gate can pass on a release that carries this record. The invariant test
turns red on the next kind added to the registry without the schema, so the
gap cannot recur silently. The four kinds remain diagnostic; F4 and F5 cells
read exactly what they read before. The enum grows to sixty-four values, and
the sensor-kinds reference is regenerated from the registry.

## Alternatives Considered

Dropping the four kinds from the sweep preset is rejected because DETRAN's
Owner requires a complete sweep and the kinds carry real diagnostics.
Relaxing the enum to a free string is rejected because the closed schema is
what lets an adopter refuse an unknown reading. Bypassing schema validation
for diagnostic kinds is rejected because a failed or skipped diagnostic must
still be a rejected-or-recorded reading, never a silent pass. Retiring the
five legacy values in the same change is deferred for the reason stated in
the decision.

## Affected Rules

- `law/schemas/sensor-reading.schema.json` admits the four kinds and lists the legacy values.
- `law/policy/sensor-registry.json` and `law/policy/sense-presets.json` carry the admitted-kind invariant and the intentionally-unsupported marker.
- `packages/sensors/src/sensor-reading.ts` and `packages/schemas/src/index.ts` keep the runtime validator and the roster aligned with the enum.
- `docs/reference/cli/sensor-kinds.md` and `docs/adopters/sensor-inputs.md` state the invariant and the legacy list.

## Inspector Adversarial Acceptance

Run the invariant test, then delete one of the four kinds from the enum and
confirm it turns red. Emit each of the four through `sense run` and validate
the reading with the installed schema; then alter the kind to an unknown
value and confirm rejection. Force one of the four sensors to fail and
confirm FAIL is recorded and no cell verdict changes. Pack the candidate,
extract it, and diff its registry, preset, and schema against source; validate
every sweep read-kind reading against the packed schema; grep the sweep
preset for any effect other than read. Mark a registry entry as
intentionally unsupported and confirm the runner refuses it before start
with a named code.
