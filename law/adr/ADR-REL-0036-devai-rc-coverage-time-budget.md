---
id: ADR-REL-0036
title: Bound DEVAI RC coverage execution to 45 minutes
type: adr
status: accepted
date: 2026-10-28
authority: Architect
supersedes: []
provenance:
  - law/adr/ADR-REL-0035-trust-published-verifier-2-4.md
affected_rules:
  - scripts/process/release-prerequisites.mjs
  - docs/dev/operations/process-simplification-rollout.md
inspector_acceptance:
  - IA-001 -- The DEVAI candidate certification helper invokes its dedicated packaged entrypoint through the existing Inspector check authority and exclusive validation runner; the unique planned RC coverage task receives 2700000 milliseconds and every other task receives 1800000 milliseconds.
  - IA-002 -- Scope and coverage uniqueness are checked before execution, and export refuses unless the coverage task actually executes and passes; a cached pass is not a fresh coverage execution.
  - IA-003 -- Existing timeout failure, task population, coverage thresholds, isolation, signing, receipt and historical verification semantics remain unchanged; the signed export is not represented as attesting the timeout or unsigned operational log.
---

# Bound DEVAI RC coverage execution to 45 minutes

## Status

Accepted under the Owner amendment to mandate #299 for the DEVAI candidate
certification helper.

## Context

Owner mandate #299 established a 30-minute certification per-task limit. The
Owner has amended that mandate for DEVAI's own RC certification: the coverage
task may take 45 minutes while all other certification tasks retain 30 minutes.
This is a task budget, not a relaxation of the coverage gate or its test
population. A new signed RC is required for the integrated candidate; this
decision alone is not evidence that an RC ran or passed.

## Decision

For the DEVAI candidate certification helper's `check --rc --run`, use
2,700,000 ms for exactly the unique planned `test:coverage:rc` node and
1,800,000 ms for every other task. A dedicated packaged host entrypoint invokes
the existing CLI as Inspector with write authority and activates a fixed,
internal runner context. The helper invokes it under the exclusive validation
runner. There is no generic public per-node timeout option. Validate the
certification scope and unique coverage node before task execution. The helper
requires one executed, passing coverage result before signed export; reused
coverage is not a fresh execution. Existing cache and historical evidence are
preserved.

The entrypoint checks checkout, control path, project identity and coverage
identity as operational safeguards against accidental scope mistakes. The local
checkout, its Git configuration and descriptor are mutable, so these checks do
not establish cryptographic repository provenance. This decision does not change
the separately protected release certification provider or any other target's
limits. Before a run, the host must verify that its enclosing deadline permits
the complete task graph, setup, cleanup and signing.

The ordinary candidate receipt is unsigned and does not bind applied timeouts.
The subsequent signed export binds its existing evidence, not the helper's
invocation or execution log. Retain those logs as unsigned operational evidence;
do not claim the signature proves the timeout. Historical receipt verification,
signers and signing behavior remain unchanged. Independently verifiable signed
timeout evidence would need a separate reviewed versioned design.

## Consequences

Timeouts remain failures, with existing dependency and receipt behavior. Test
population, coverage thresholds, isolation and signing are unchanged. This
record grants no merge, publication, tag, deployment or downstream authority,
and excludes PORM. Review and integration precede a fresh signed RC; the RC
result and any later publication must each be observed independently.

## Alternatives Considered

A general per-node CLI timeout would widen the exception beyond the approved
DEVAI certification route. Leaving the coverage task at 30 minutes would not
implement the Owner amendment. Both alternatives are rejected.

## Affected Rules

The local release prerequisite helper and its operational documentation apply
this decision. The runner and dedicated entrypoint implement the fixed budgets
within that route. No protected provider or historical receipt rule changes.

## Inspector Adversarial Acceptance

Verify the three frontmatter acceptance conditions against the built helper,
including wrong scope, missing or duplicate coverage, a reused coverage result,
timeout failure, and the distinction between signed export and unsigned logs.
Verify the actual enclosing deadline before any authorized RC.
