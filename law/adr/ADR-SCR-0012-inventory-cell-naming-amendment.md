---
id: ADR-SCR-0012
title: Inventory cell names follow the sensor registry without changing applicability
type: adr
status: accepted
date: 2026-10-01
authority: Architect
supersedes:
  - ADR-SCR-0008
provenance:
  - ADR-SCR-0008
  - docs/dev/operations/open-issue-closure-campaign/decision-register.md
  - product/campaigns/CMP-0006-open-issue-closure/issue-snapshot.json
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
  - IA-006 -- inventory_regeneration maps to F4:T9 and inventory_adherence to F4:T4; framework N/A for either measured cell is refused while its measured inputs exist, and absent required inventory bodies produce a diagnostic rather than an empty PASS.
---

# Inventory cell names follow the sensor registry without changing applicability

## Status

Accepted by the Owner in this preparation session on 2026-10-01: “I Accept all four ADR proposed.” The Architect records that acceptance here. The predecessor stays byte-exact; this forward record is the accepted superseding decision. The catalogue is regenerated and its exception digest repinned. Acceptance does not report implementation or authorize an external effect.

## Context

Issue #240 confirms the CMP-0004 naming ruling; #237 confirms production of the required inventory. The predecessor reverses the sensor-to-cell pairing in its final paragraph and IA-006.

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
`inventory_coverage` kinds, both present on the framework, so F4:T9 is
measured and the ledger check rejects an N/A entry for it while those kinds
have readings. `inventory_adherence` is N/A only when every surface it
measures is declared absent in `.devai/config/sensor-inputs.json`; the
framework declares `actions` present, so the adapter is repaired and F4:T4
is measured. Each cell reads a measured verdict or a ledger-anchored N/A
with its reason, never an unexplained blank.

The registry pairing governs every reference: inventory_adherence is F4:T4; inventory_regeneration is F4:T9. The Owner comment on #237 chooses inventory production. Both framework cells remain measured. This is a naming amendment only; it grants no N/A declaration and changes no applicability decision.

## Consequences

All substantive predecessor obligations and adversarial acceptance not expressly replaced below remain binding. This record changes no role, threshold, publication consent, historical proof byte, or default write scope.

## Alternatives Considered

Amending cell applicability to N/A is explicitly ruled out by the Owner on #237. Changing the registry to match the reversed prose is rejected.

## Affected Rules

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

## Inspector Adversarial Acceptance

- IA-001 -- Recording a reading whose id exists with a different body still fails with SENSE_RECORD_ID_CONFLICT, and a later reading of the same kind for the same candidate lands as a new file whose supersedes names the earlier id; the scorecard selects the later one and the earlier bytes are unchanged.
- IA-002 -- Deleting the chain entry of a recorded reading and re-running sense record on the same file appends one entry naming the file digest and rewrites nothing; editing the recorded file afterwards makes the digest check fail.
- IA-003 -- On a fresh worktree with an empty store the ordered protocol records the first pass before inventory_performance runs, so F4:T7 and F5:T4 read PASS or FAIL from the substrate and never REVIEW for an empty store.
- IA-004 -- A sense record initiated by an engineer, or under a self-dogfood row that omits the chain path, is refused; the alignment sensor ignores a store reading whose candidate binding is missing or does not match the candidate head.
- IA-005 -- A backlog.json with an unknown top-level key, an observation without its cell, or a delta naming a cell absent from the current observation fails law/schemas/observation-backlog.schema.json, and a hook that resolves readings from the detached worktree instead of the bound checkout fails the resolver test.
- IA-006 -- inventory_regeneration maps to F4:T9 and inventory_adherence to F4:T4; framework N/A for either measured cell is refused while its measured inputs exist, and absent required inventory bodies produce a diagnostic rather than an empty PASS.
