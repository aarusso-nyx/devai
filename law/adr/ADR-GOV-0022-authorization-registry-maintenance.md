---
id: ADR-GOV-0022
title: Validated append-only authorization registry maintenance is not an invariant mutation
type: adr
status: proposed
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-GOV-0002
  - ADR-AUT-0001
  - docs/dev/operations/harness-convergence-proposals.md
  - packages/skills/src/forbidden-actions/scan.ts
  - law/schemas/forbidden-action-authorizations.schema.json
affected_rules:
  - packages/skills/src/forbidden-actions/scan.ts
  - packages/skills/src/forbidden-actions/authorizations.ts
  - packages/skills/tests/unit/forbidden-registry-boundaries.test.ts
  - packages/skills/tests/unit/forbidden-authorization-boundaries.test.ts
  - packages/skills/tests/unit/forbidden-git-paths.test.ts
inspector_acceptance:
  - IA-001 -- Record eight receipts in one commit that touches only the authorization registry and confirm the scanner yields zero findings with --strict.
  - IA-002 -- Delete one receipt from the registry in a commit and confirm the scanner yields exactly one FORBID-MUTATE-INVARIANTS finding.
  - IA-003 -- Alter the digest of an existing receipt while appending a new one and confirm the commit is a finding, since the change is not append-only.
  - IA-004 -- Append a receipt that fails the registry schema and confirm the commit is a finding, so malformed maintenance cannot pass as maintenance.
  - IA-005 -- Append a receipt and edit law/constitution.md in the same commit and confirm the constitution path is still a finding.
---

# Authorization registry maintenance

## Status

Proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Binds nothing until the Architect sets it to accepted
before the round that implements it opens. Narrows one finding of the
forbidden-actions scanner for one path under one validated condition; every
other rule of the scanner and of Article 6 is unchanged.

## Context

The forbidden-actions scanner in `packages/skills/src/forbidden-actions/scan.ts`
inspects each commit twice: a `diff-tree --name-status` pass that synthesizes
`git add` and `git rm` operation lines for every changed path, and a patch
pass over the semantic diff. The patch pass excludes
`law/policy/forbidden-action-authorizations.json`, the configured
authorization registry, so the receipt bytes themselves never match a
pattern. The name-status pass does not exclude it, so a commit that records
a receipt synthesizes `git add law/policy/forbidden-action-authorizations.json`,
and `FORBID-MUTATE-INVARIANTS` matches that line. Recording a receipt is
therefore itself a finding, and the adopter report against 1.4.5 that showed
eight receipts recorded in one commit producing eight findings is unchanged
in 1.6.0 (#67). The author-based skip in the scanner does not help an
adopter whose receipts are recorded under a role other than the Architect.

## Decision

The scanner treats a change to the configured authorization registry as
registry maintenance when two conditions hold on the commit: the resulting
file validates against `law/schemas/forbidden-action-authorizations.schema.json`,
and the change is append-only, meaning every authorization present in the
parent's version of the file is present in the child's version with identical
bytes and the child adds zero or more authorizations after them. Registry
maintenance produces no `FORBID-MUTATE-INVARIANTS` finding in any inspection:
the name-status pass omits the registry path from the operation lines it
matches for that rule, and the patch pass keeps its existing exclusion. The
scanner reads both versions of the file from the commit's tree objects, never
from the working tree, so the classification is a property of the commit.

A commit that removes an authorization, alters the bytes of an existing one,
reorders them, changes the root keys or `schemaVersion`, or produces a file
that fails the schema is not maintenance and is still a finding. A commit
that also touches any other `law/` path is still a finding for that path, and
a commit whose message matches a forbidden pattern is still a finding. The
exemption applies to the one configured registry path and to no other file,
including `law/policy/forbidden-actions.json` and
`.devai/config/forbidden-actions.json`. Role authority over `law/`, the
exact-commit scope of every receipt, and the runtime write boundary of
Article 6 are unchanged; no receipt may cover the commit that introduces it.

## Consequences

Recording receipts becomes a clean commit under `--strict`, so an adopter's
authorization workflow no longer needs a receipt for the act of recording
receipts. The scanner gains a schema validation of the registry per commit,
which costs one parse of two blobs for commits that touch the path and
nothing otherwise. The existing forbidden-path tests stay green because no
other path or rule changes; the registry boundary suite gains the deletion,
alteration, malformed, and mixed-commit cases.

## Alternatives Considered

Excluding the registry from the name-status pass unconditionally is rejected
because a deletion or alteration of a receipt would then pass unseen. Waiving
`FORBID-MUTATE-INVARIANTS` through a receipt that covers the recording commit
is rejected by the non-decisions of the proposal set: no receipt covers the
commit that introduces it, and the waiver would be recursive. Extending the
author-based skip to a registry role is rejected because authorship is not
the property that makes maintenance safe; append-only validity is.

## Affected Rules

- `packages/skills/src/forbidden-actions/scan.ts` for the maintenance
  classification and the name-status exemption.
- `packages/skills/src/forbidden-actions/authorizations.ts` for the
  append-only comparison of two registry versions.
- `packages/skills/tests/unit/forbidden-registry-boundaries.test.ts`,
  `packages/skills/tests/unit/forbidden-authorization-boundaries.test.ts`, and
  `packages/skills/tests/unit/forbidden-git-paths.test.ts` for the
  reproduction, deletion, alteration, malformed, and mixed-commit fixtures.

## Inspector Adversarial Acceptance

Record eight receipts in one commit and confirm zero findings with
`--strict`. Delete one receipt in a commit and confirm exactly one
`FORBID-MUTATE-INVARIANTS` finding. Append a receipt while altering the
digest of an existing one and confirm a finding. Append a receipt that fails
the schema and confirm a finding. Append a receipt and edit
`law/constitution.md` in the same commit and confirm the constitution path is
a finding while the registry path is not.
