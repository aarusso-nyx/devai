---
id: ADR-CHK-0009
title: The commit-range author-path table admits the Engineer's focused regression tests
type: adr
status: accepted
date: 2026-10-21
authority: Architect
supersedes:
  - ADR-CHK-0008
provenance:
  - ADR-CHK-0008
  - ADR-GOV-0026
  - law/constitution.md Article 6 and Article 7 at 1.1.0
  - GitHub issue aarusso-nyx/devai#412
affected_rules:
  - scripts/check-commit-range.mjs
inspector_acceptance:
  - IA-001 -- An Engineer commit that changes packages/x/src/a.ts and adds or modifies a test file that imports packages/x/src/a.ts passes the commit-range check.
  - IA-002 -- An Engineer commit that adds or modifies a test file importing no file the same commit changed is refused.
  - IA-003 -- An Engineer commit that deletes a test file is refused, whatever else the commit changes.
  - IA-004 -- Inspector commits under tests/ and packages/*/tests/ are judged exactly as before.
---

# The commit-range author-path table admits the Engineer's focused regression tests

## Status

Accepted on 2026-10-21 by the Architect after the Owner ratified ADR-GOV-0026 and the
amended Articles 6, 7 and 10 (constitution 1.1.0). ADR-CHK-0008 states that a change to
its author-path table is a change to that record, and an accepted record is never edited,
so this forward record carries the change. It replaces only the `tests/`,
`packages/*/tests/` row of the ADR-CHK-0008 table; every other row and every other rule
of ADR-CHK-0008 stays byte-exact and binding. Like ADR-GOV-0026, it takes effect only in
the release that ships the verb registration and its enforcement.

## Context

The commit-range check judges each commit of a pull-request range against the
ADR-CHK-0008 author-path table, which binds `tests/` and `packages/*/tests/` to the
Inspector alone. Constitution 1.1.0 gives the Engineer a focused-regression verb on those
paths (ADR-GOV-0026), so the row as written would refuse every Engineer commit that
exercises the verb.

## Decision

The `tests/`, `packages/*/tests/` row of the ADR-CHK-0008 table is replaced by:

| Path                          | Admitted authors                                                                                                                                               | Basis                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `tests/`, `packages/*/tests/` | Inspector; or Engineer when the same commit changes a file under `packages/` that the test file imports, and the test file is added or modified, never deleted | Article 6 and Article 7 at constitution 1.1.0 |

A test file imports a changed file when one of its relative or workspace imports resolves
to that file. A commit still passes only when its author is admitted for every path it
changes.

## Consequences

- An Engineer commit may now hold sources and their adjacent tests together.
- The independent-assurance designation is not visible to the commit-range check, so it is
  enforced in dispatch, and in review for maintainer work.
- Assertion edits to tests the task did not add are not distinguishable from the commit
  alone; dispatch and the test-weakening sensor carry that rule (ADR-GOV-0026).

## Alternatives Considered

- **Edit the ADR-CHK-0008 table in place.** Rejected: an accepted record is never edited.
- **Admit the Engineer on every test path.** Rejected: ADR-GOV-0026 bounds the verb by
  adjacency to the commit's own source changes.

## Affected Rules

- scripts/check-commit-range.mjs

## Inspector Adversarial Acceptance

- IA-001 -- An Engineer commit that changes packages/x/src/a.ts and adds or modifies a test file that imports packages/x/src/a.ts passes the commit-range check.
- IA-002 -- An Engineer commit that adds or modifies a test file importing no file the same commit changed is refused.
- IA-003 -- An Engineer commit that deletes a test file is refused, whatever else the commit changes.
- IA-004 -- Inspector commits under tests/ and packages/*/tests/ are judged exactly as before.
