---
id: ADR-GOV-0021
title: One reference page per admitted workflow, a generated decision catalogue, and documented recovery paths
type: adr
status: accepted
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-CHK-0003
  - ADR-CHK-0004
  - ADR-REL-0029
  - law/policy/documentation-information-architecture.json
  - packages/loop/src/governance-ledger/render.ts
  - scripts/check-workflows.mjs
  - docs/dev/operations/harness-convergence-proposals.md
affected_rules:
  - law/policy/documentation-information-architecture.json
  - docs/dev/operations/workflows/README.md
  - docs/dev/operations/workflows/pull-request-checks.md
  - docs/dev/operations/workflows/release.md
  - docs/dev/operations/workflows/site-publish.md
  - docs/dev/operations/workflows/devai-ledger-verify.md
  - law/adr/README.md
  - packages/loop/src/governance-ledger/render.ts
  - law/policy/adr-validation.json
  - docs/dev/operations/README.md
  - docs/adopters/sensor-inputs.md
  - docs/dev/operations/remote-preflight-contract.md
  - docs/adopters/docs-layout.md
inspector_acceptance:
  - IA-001 -- Adding a file under `.github/workflows/` without a matching page under `docs/dev/operations/workflows/` fails the information-architecture completeness gate.
  - IA-002 -- A page whose metadata block names a trigger or job the workflow file no longer declares fails the drift check, and a page whose tables drift while the block is current does not.
  - IA-003 -- Adding a record under `law/adr` without regenerating `law/adr/README.md` fails the catalogue freshness check, and the regenerated catalogue is byte-deterministic across two runs.
  - IA-004 -- No operations or adopter page states that CI runs three workflows, that a release builds on push, or that the pull-request lane runs a `preflight-v1` node; each such sentence is gone or corrected.
  - IA-005 -- The docs-links gate and the information-architecture gate both pass on the round head, and the `no-ci-publish` adopter description says publication goes only through the governed Pages journal.
---

# Workflow reference pages

## Status

Accepted on 2026-09-29 by the Architect before the round that implements it
opened; proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Adds a page family and a
completeness gate to the documentation information architecture, turns the
decision index into a generated catalogue, and corrects four stale
statements; it is sequenced last in its campaign so the pages describe the
workflows as the campaign leaves them.

## Context

The repository admits four workflows, `pull-request-checks.yml`,
`release.yml`, `site-publish.yml`, and `devai-ledger-verify.yml`, and pins
their shape in `scripts/check-workflows.mjs`, yet
`law/policy/documentation-information-architecture.json` has no page for
any of them. Three operations pages describe the CI as three workflows, a
push-built release, or a `preflight-v1` node in the pull-request lane, none
of which is true today: `docs/dev/operations/README.md`,
`docs/adopters/sensor-inputs.md`, and
`docs/dev/operations/remote-preflight-contract.md`. The adopter page for the
`docs-governance.no-ci-publish` rule still says CI does not publish the site,
although ADR-REL-0029 publishes it through the governed Pages journal (#167).
`law/adr/README.md` says DEVAI ships no development-history records while
seventy-two records sit beside it (#162, item 5), and
`packages/loop/src/governance-ledger/render.ts` already exports a
`renderDecisionIndex` that nobody wires to that file. A maintainer recovering
from a failed run has no page that says which job stopped, what credential it
held, or how to resume.

## Decision

`docs/dev/operations/workflows/` holds one page per admitted workflow and an
index. Each page states the workflow's triggers and path scope, its jobs and
their order, the environments and who stops there, the secrets and variables
each job reads, what each job runs, its direct effects, its side effects, its
recovery paths, and which steps an adopter may reuse. The recovery paths
include, for the release and site workflows, the manual reconciliation of a
publication whose journal record is unresolved.

`law/policy/documentation-information-architecture.json` gains a `workflows`
page entry with a completeness gate that requires one page per file under
`.github/workflows/`. Drift between a page and its workflow is checked from a
small metadata block on each page naming the workflow file, its triggers, and
its jobs, and never by parsing the page's tables; a page that describes
correctly but reads awkwardly is a docs review, not a gate failure.

`law/adr/README.md` becomes a generated catalogue produced through the
existing `renderDecisionIndex`, listing every record with its id, title,
status, and date in deterministic order, and a freshness check fails when a
record is added or changed without regenerating the catalogue. The prose
that says adopters add their own records moves into the generated preamble.

The stale statements are corrected: the operations README, the adopter
`sensor-inputs.md`, and the remote preflight contract describe the four
admitted workflows and the pull-request lane as ADR-CHK-0003 and ADR-CHK-0004
leave them, and the adopter description of the `no-ci-publish` rule on
`docs/adopters/docs-layout.md` says that publication goes only through the
governed Pages journal, closing the adopter-page half of #167.

## Consequences

Every workflow has one page an operator reads before dispatching or
recovering it, and the information-architecture gate refuses a fifth workflow
without a page. The docs-governance and docs-links gates gain a page family
whose metadata blocks must match the workflow files, so a workflow change
carries a page change in the same pull request. The decision catalogue stops
lying about the record set and becomes one more generated surface, checked
like the scorecard page; because `law/policy/adr-validation.json` pins the
README's digest as a non-record exception, each regeneration re-pins that
entry and the catalogue digest in the same law commit. Because the record is sequenced last, the pages
describe the merge-queue lane, the planning lane, and the release stops in
their post-campaign form and need no second pass.

## Alternatives Considered

Generating the workflow pages entirely from the YAML is rejected because
recovery paths, credential purpose, and adopter reuse are judgments the YAML
does not carry. Parsing the pages' tables for drift is rejected as brittle;
a metadata block gives the gate an exact contract. Writing the catalogue by
hand is rejected because the existing renderer already produces it and a hand
copy is what went stale. Correcting the stale statements without adding the
gate is rejected because the same drift would recur at the next workflow
change.

## Affected Rules

- `law/policy/documentation-information-architecture.json`: the `workflows`
  page entry, its completeness gate, and the drift rule.
- `docs/dev/operations/workflows/README.md` and the four workflow pages:
  the new page family.
- `law/adr/README.md`, `packages/loop/src/governance-ledger/render.ts`, and
  `law/policy/adr-validation.json`: the generated catalogue, its freshness
  check, and the re-pinned exception digest.
- `docs/dev/operations/README.md`, `docs/adopters/sensor-inputs.md`, and
  `docs/dev/operations/remote-preflight-contract.md`: the corrected CI
  statements.
- `docs/adopters/docs-layout.md`: the `no-ci-publish` description.

## Inspector Adversarial Acceptance

Add a fixture `.github/workflows/extra.yml` with no page and confirm the
information-architecture gate fails naming the missing page. Rename a job in
`site-publish.yml` without touching its page and confirm the drift check
fails on the metadata block; then edit only a table cell on the page and
confirm the check still passes. Add a record under `law/adr` without
regenerating and confirm the catalogue check fails; regenerate twice and
confirm byte-identical output. Grep the operations and adopter pages for
"three workflows", "push" as a release trigger, and `preflight-v1` and
confirm no stale sentence remains. Run the docs-links and
information-architecture gates on the round head and confirm both pass, and
read the `no-ci-publish` row on the adopter page for the journal wording.
