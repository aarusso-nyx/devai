---
id: ADR-SCR-0008
title: Immutable readings, supersession by instance, recording order, and cell applicability
type: adr
status: accepted
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0002
  - ADR-SCR-0003
  - ADR-SCR-0005
  - ADR-GOV-0002
  - ADR-AUT-0001
  - docs/dev/operations/harness-convergence-proposals.md
affected_rules:
  - packages/sensors/src/sensor-reading.ts
  - law/schemas/sensor-reading.schema.json
  - packages/cli/src/commands/sense/record.ts
  - packages/loop/src/scorecard/inputs.ts
  - law/policy/sense-presets.json
  - law/policy/self-dogfood.json
  - packages/sensors/src/harness-invariant-alignment-evidence.ts
  - law/schemas/observation-backlog.schema.json
  - packages/skills/src/operations/backlog.ts
  - packages/skills/src/post-merge-auditor/observation-bundle.ts
  - packages/sensors/src/inventory-performance.ts
  - packages/cli/src/commands/sense/readings-rebuild.ts
  - packages/sensors/src/inventory-adherence.ts
  - law/policy/scorecard-na.json
  - .devai/config/scorecard-na.json
inspector_acceptance:
  - IA-001 -- Recording a reading whose id exists with a different body still fails with SENSE_RECORD_ID_CONFLICT, and a later reading of the same kind for the same candidate lands as a new file whose supersedes names the earlier id; the scorecard selects the later one and the earlier bytes are unchanged.
  - IA-002 -- Deleting the chain entry of a recorded reading and re-running sense record on the same file appends one entry naming the file digest and rewrites nothing; editing the recorded file afterwards makes the digest check fail.
  - IA-003 -- On a fresh worktree with an empty store the ordered protocol records the first pass before inventory_performance runs, so F4:T7 and F5:T4 read PASS or FAIL from the substrate and never REVIEW for an empty store.
  - IA-004 -- A sense record initiated by an engineer, or under a self-dogfood row that omits the chain path, is refused; the alignment sensor ignores a store reading whose candidate binding is missing or does not match the candidate head.
  - IA-005 -- A backlog.json with an unknown top-level key, an observation without its cell, or a delta naming a cell absent from the current observation fails law/schemas/observation-backlog.schema.json, and a hook that resolves readings from the detached worktree instead of the bound checkout fails the resolver test.
  - IA-006 -- Declaring F4:T4 as N/A while inventory_dep_graph or inventory_coverage readings exist is rejected by the ledger check, and F4:T9 is N/A only when every surface it measures is declared absent in sensor-inputs.json.
---

# Immutable readings, supersession by instance, recording order, and cell applicability

## Status

Accepted on 2026-10-01 by the Architect as drafted, after the Owner
accepted it on 2026-10-01; round R-0402 of CMP-0004 implements it. Proposed on
2026-09-28 from the harness convergence brainstorm and its independent
review. Extends the one-store rule of
ADR-SCR-0002 with reading identity, recording order, a backlog schema, and per-cell applicability.

## Context

A reading id is content-derived in `packages/sensors/src/sensor-reading.ts`
and omits the timestamp unless a sensor opts in, while `sense record` in
`packages/cli/src/commands/sense/record.ts` compares the whole object and
throws `SENSE_RECORD_ID_CONFLICT` when only the timestamp differs (#158).
The `sweep` preset in `law/policy/sense-presets.json` runs
`inventory_performance` as member 42 of 49 in one pass; it reads
`.devai/state/sensor-readings`, empty on a fresh worktree, so F4:T7 reads
REVIEW for the absence of its own inputs. `sense record` writes only the
reading file, while `harness-invariant-alignment-evidence.ts` searches
`record/proofs/chain.json` for a `sense.readings.record` entry to bind the
candidate, so F5:T4 never sees a recorded reading (#157). The backlog that
`audit observe` writes has no schema, and the post-merge hook receives the
detached worktree root rather than the bound checkout (#160).
`scorecard-na.json` declares F1:T1 and F4:T5 only; F4:T4 and F4:T9 have no
applicability decision, although `readings-rebuild.ts` regenerates the
`inventory_dep_graph` and `inventory_coverage` kinds on the framework (#159).

## Decision

A recorded reading is immutable. Its id stays content-derived by the current
rule, and the file under `.devai/state/sensor-readings/<kind>/<id>.json` is
never rewritten. A later reading of the same kind for the same candidate is a
new instance: `law/schemas/sensor-reading.schema.json` gains an optional
`supersedes` field naming the earlier id, the sensors set it when a prior
instance exists, and `packages/loop/src/scorecard/inputs.ts` selects the
latest instance per kind and candidate by following the `supersedes` links,
never by file time. `SENSE_RECORD_ID_CONFLICT` remains the answer to a
same-id different-body write; a same-id same-body write stays `already-recorded`.

The sweep stays read-only. The `sweep` preset gains an ordered second pass
listing the store-reading sensors, today `inventory_performance` and any
later consumer that declares a store read, and the recording protocol is
first pass, record, second pass, record, where recording is the inspector's
harness-write step and the preset never records. The two writes of a
recording are ordered and recoverable: the reading file is written first
with `wx`, then `sense record` appends a `sense.readings.record` entry to
`record/proofs/chain.json` naming the reading id, kind, and the SHA-256 of
the file bytes. A missing entry is repaired by re-running `sense record` on
the same file, which appends and edits nothing; a digest mismatch is a
finding, not a repair.

`law/policy/self-dogfood.json` gains, on the `sense record` row, the chain
path beside the readings directory, so the append is a declared
harness-write. The alignment sensor accepts a reading found in the canonical
store when the reading carries its candidate binding or its chain entry
carries the candidate head; a reading with neither is ignored, so the
candidate-binding requirement is not weakened.

`law/schemas/observation-backlog.schema.json` describes what `audit observe`
writes through `packages/skills/src/operations/backlog.ts`: the observed
merge sha, the timestamp, one observation per scorecard cell with its
verdict and reading ids, and the deltas against the previous bundle. The
skills suites validate every committed `backlog.json` against it, and the
post-merge hook in `observation-bundle.ts` resolves readings from the bound
checkout's `.devai/state/sensor-readings`, with a resolver test that fails
when the detached worktree root is passed instead.

Applicability of F4:T4 and F4:T9 is decided per cell from the subject the
cell measures. `inventory_regeneration` covers the `inventory_dep_graph` and
`inventory_coverage` kinds, both present on the framework, so F4:T4 is
measured and the ledger check rejects an N/A entry for it while those kinds
have readings. `inventory_adherence` is N/A only when every surface it
measures is declared absent in `.devai/config/sensor-inputs.json`; the
framework declares `actions` present, so the adapter is repaired and F4:T9
is measured. Each cell reads a measured verdict or a ledger-anchored N/A
with its reason, never an unexplained blank.

## Consequences

The store becomes an append-only history per kind and candidate, and the
scorecard reads the newest instance without a rebuild. F4:T7 and F5:T4
measure the substrate, so either can read FAIL on a slow inventory or a
missing binding, which is the intended visibility. The backlog gains a
contract adopters can validate, the inventory cells stop reading REVIEW for
non-inventory reasons, and recording takes two ordered inspector steps.

## Alternatives Considered

Including the timestamp in every reading id is rejected because every run
would become a new id and hide a genuine same-content re-run. Rewriting a
reading in place is rejected because the store is evidence. Letting the
sweep record between its passes is rejected because the sweep is read-only
for every role. Writing the chain entry before the file is rejected because
a crash would leave an entry naming bytes that do not exist. A blanket N/A
for F4:T4 and F4:T9 is rejected because both cells have subjects on the
framework.

## Affected Rules

- `packages/sensors/src/sensor-reading.ts` and `law/schemas/sensor-reading.schema.json` carry the `supersedes` field.
- `packages/cli/src/commands/sense/record.ts` appends the digest-bearing chain entry and repairs a missing one; `packages/loop/src/scorecard/inputs.ts` selects the latest instance.
- `law/policy/sense-presets.json` carries the ordered second pass; `law/policy/self-dogfood.json` covers the chain path on the `sense record` row; `packages/sensors/src/harness-invariant-alignment-evidence.ts` accepts canonical-store readings with a candidate binding.
- `law/schemas/observation-backlog.schema.json` is created; `packages/skills/src/operations/backlog.ts` and `packages/skills/src/post-merge-auditor/observation-bundle.ts` conform to it and resolve from the bound checkout.
- `packages/sensors/src/inventory-performance.ts`, `packages/cli/src/commands/sense/readings-rebuild.ts`, and `packages/sensors/src/inventory-adherence.ts` read under the second pass; `law/policy/scorecard-na.json` and `.devai/config/scorecard-na.json` carry no entry for F4:T4.

## Inspector Adversarial Acceptance

Record a reading, alter one metric, and record again under the same id;
confirm `SENSE_RECORD_ID_CONFLICT`. Record a second instance for the same
candidate and confirm it names the first in `supersedes`, the first file is
byte-identical, and `audit scorecard` reads the second. Delete the chain
entry, re-record, and confirm one appended entry with the file digest; edit
the file and confirm the digest check fails. Run the ordered protocol on a
fresh worktree and confirm F4:T7 and F5:T4 read PASS or FAIL, not REVIEW.
Run `sense record` as engineer, then under a row without the chain path, and
confirm both refusals. Corrupt a `backlog.json` in the three listed ways and
confirm each rejection; pass the detached root to the hook and confirm the
resolver test fails. Add an F4:T4 ledger entry while dep-graph readings
exist and confirm the ledger check rejects it.
