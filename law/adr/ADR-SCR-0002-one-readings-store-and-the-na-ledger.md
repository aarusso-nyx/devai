---
id: ADR-SCR-0002
title: One readings store for the scorecard and one ledger for N/A cells
type: adr
status: accepted
date: 2026-09-27
authority: Architect
supersedes: []
provenance:
  - law/constitution.md#article-5-transversal-properties
  - law/constitution.md#article-32-sensor-adapter-uniformity
  - packages/loop/src/scorecard/inputs.ts
  - packages/cli/src/commands/audit/scorecard.ts
  - law/policy/scorecard-na.json
affected_rules:
  - packages/cli/src/commands/audit/scorecard.ts
  - packages/loop/src/scorecard/inputs.ts
  - packages/loop/src/loop/scorecard.ts
  - law/policy/scorecard-na.json
  - law/policy/adopter-defaults/scorecard-na.json
  - .devai/config/scorecard-na.json
inspector_acceptance:
  - IA-001 -- A reading persisted by sense record is visible to audit scorecard at the same head without any copy or rebuild step.
  - IA-002 -- Removing F4:T5 from the ledger makes the computed grid score that cell; the loop holds no second list of degenerate cells.
  - IA-003 -- A ledger entry outside the declared grid, or without a reason, is rejected by the schema and by check schemas.
  - IA-004 -- The materialized copy under .devai/config differs from the law ledger only when check-policy-materialization fails.
---

# One readings store for the scorecard and one ledger for N/A cells

## Status

Accepted on 2026-09-27 by maintainer decision. Implemented by campaign CMP-0002, round R-0201.

## Context

`sense record` persists readings under `.devai/state/sensor-readings/<kind>/`
and the loop's scorecard input resolver walks that directory. The
`audit scorecard` facade reads `record/proofs/freshness/readings/` instead,
so a recorded reading never reaches the on-demand scorecard. Separately,
`law/policy/scorecard-na.json` declares one N/A cell (F1:T1) while the loop
hardcodes a second degenerate cell (F4:T5), so the scoreable cell count is
44 by law and 43 by runtime.

## Decision

The scorecard has one readings store: the directory the loop resolver walks.
The facade calls the resolver and reads nothing else. The N/A ledger in
`law/policy/scorecard-na.json` is the sole source of cells forced to N/A;
the loop derives its degenerate set from the ledger and holds no list of its
own. The ledger records F4:T5 with its Article 5 reason. The adopter default
and the materialized copy mirror the ledger under the materialization pairing
rule. For the framework repository the grid is 45 cells, 2 N/A, 43 scoreable.

## Consequences

`audit scorecard` becomes a faithful read of what the inspector recorded. A
future change to the degenerate set is a law change with a reason, reviewed
like any other ledger edit. Documentation states one number.

## Alternatives Considered

Keeping two stores and syncing them is rejected because a sync step is a
place for drift. Keeping the runtime list and deleting the ledger is rejected
because N/A is a product decision that belongs in law, not in code.

## Affected Rules

- `packages/cli/src/commands/audit/scorecard.ts` reads through `packages/loop/src/scorecard/inputs.ts`.
- `packages/loop/src/loop/scorecard.ts` derives degenerate cells from the ledger.
- `law/policy/scorecard-na.json`, its adopter default, and `.devai/config/scorecard-na.json` carry F4:T5.

## Inspector Adversarial Acceptance

Discharged by `packages/cli/tests/unit/cli-shard09-audit-scorecard-input-surface.test.ts` and `packages/loop/tests/scorecard-inputs.test.ts`.
