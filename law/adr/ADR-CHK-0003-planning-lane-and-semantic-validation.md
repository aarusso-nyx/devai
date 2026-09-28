---
id: ADR-CHK-0003
title: Select a planning lane from the change taxonomy and validate plans semantically
type: adr
status: proposed
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-GOV-0017
  - ADR-CHK-0001
  - ADR-014
  - ADR-GOV-0002
  - scripts/process/bootstrap-check-runner.mjs
  - docs/dev/operations/workflow-economy-proposals.md
  - docs/dev/operations/harness-convergence-proposals.md
affected_rules:
  - test-tasks.json
  - .github/workflows/pull-request-checks.yml
  - scripts/run-pr-release-gate.mjs
  - scripts/check-campaign.mjs
  - law/policy/campaign-execution.json
  - law/policy/adopter-defaults/change-taxonomy-binding.json
  - .devai/config/change-taxonomy-binding.json
  - .devai/config/project.json
  - packages/cli/src/commands/check/docs-governance-publish-checks.ts
  - docs/adopters/docs-layout.md
  - docs/dev/operations/workflow-economy-proposals.md
inspector_acceptance:
  - IA-001 -- A pull request that changes one prompt and the campaign ledger plans exactly the planning-lane nodes, reports the campaign check result, and restores the check-runner bootstrap from cache instead of compiling.
  - IA-002 -- A pull request that changes a prompt and a package source, or that renames or deletes a plan-class path, plans the affected profile, and editing the workflow path filter in the same candidate cannot move it into the planning lane because the runner selects the lane from the taxonomy.
  - IA-003 -- `check --only docs-governance` passes on main, and removing `repo.kind` or `docs.builder` from `.devai/config/project.json` fails it through `docs:validate`.
  - IA-004 -- A campaign whose Owner effect lacks `performed_at` when its `required_before` round closes fails `scripts/check-campaign.mjs`, and the campaign execution policy loads with status accepted.
  - IA-005 -- A `record/` change whose rendered scorecard page is stale fails `plan:validate` through the page check without any `generate` or `build` node executing.
---

# Planning lane and semantic validation

## Status

Proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Binds nothing until the Architect sets it to accepted
before the round that implements it opens. Narrows the lane plan-class
changes take, adds the two checks they need, and accepts the campaign policy.

## Context

The workflow economy campaign (CMP-0001) made plan-only pull requests cheap
but not free. A ledger-only pull request still executes the unconditional
floor of the `affected` profile, from `generate` and `build` through
`release:closure`, after the workflow compiles the check runner with
`tsc -b --force` in `scripts/process/bootstrap-check-runner.mjs`. The one
check a plan change needs, `scripts/check-campaign.mjs`, does not run there:
`plan:validate` executes only `journeys`, and the campaign contract test
lives under `test:root`, whose selectors exclude `product/`. The `class`
selector of ADR-GOV-0017 has zero uses in `test-tasks.json`, `work/` is bound
in neither taxonomy binding, and the `plan` class spans all of `product/` and
`record/`, including the scorecards `generate` consumes. `docs:validate` runs
only `cli-reference` although the `docs` class lists `docs-governance`, and
that check fails on the framework because `.devai/config/project.json`
declares neither `repo.kind` nor `docs.builder` (#166); the `no-ci-publish`
remediation still says CI does not publish the site (#167). The gate invokes
the affected run twice. The campaign execution policy still carries
`status: proposed` after governing two campaigns, and the checker never
verifies that an Owner effect was performed before its round closed:
CMP-0002 closed with OE-01 unperformed.

## Decision

The planning population is the whole `plan` class. A pull request whose
changed paths all classify as `plan` (`product/`, `record/`, `work/`) takes
the planning lane; a diff containing a rename, a deletion, or a path of any
other class takes the `affected` profile. The check runner selects the lane
from the taxonomy classification of the commit range, never from a workflow
path filter, so a candidate cannot suppress checks by editing the workflow.

The planning lane executes `preflight`, `plan:validate`, `format`, and the
schema members, and nothing that depends on `build`. `plan:validate` gains
two members: `scripts/check-campaign.mjs`, so every campaign ledger and
prompt change is validated in the gate against
`law/schemas/campaign.schema.json` and the campaign policy's structural
rules, and `scripts/generate-scorecard-page.mjs --check`, so a `record/`
change keeps the rendered page consistent without running `generate`. The
release verification floor of ADR-014 applies to release profiles and is
untouched. `class` selectors bind the floor per class in `test-tasks.json`,
as ADR-GOV-0017 admits, replacing the prefix lists that approximate each
class today; `work/` is bound to `plan` in the adopter default and in the
materialized taxonomy binding, and receives a selector.

The check-runner bootstrap output under `.devai/state/pr-bootstrap` is cached
in the workflow, keyed by the digest of the TypeScript inputs it compiles, so
a candidate that changes no source restores the runner instead of compiling.
The duplicate `check --affected` invocation after `release:pr-gate` is
removed; the gate runs the affected plan once.

`docs:validate` runs every member the `docs` class lists, including
`docs-governance`. `.devai/config/project.json` declares `repo.kind: library`
and `docs.builder: docusaurus` (#166). The `no-ci-publish` rule keeps its
substring matcher, since none of the three action names it tests for appears
in any admitted workflow, and its description and remediation in
`docs-governance-publish-checks.ts` and on `docs/adopters/docs-layout.md`
say that publication goes only through the governed Pages journal (#167).

`scripts/check-campaign.mjs` verifies that every Owner effect carries
`performed_at` before its `required_before` round closes, and
`law/policy/campaign-execution.json` moves from `proposed` to `accepted` in
the same law commit, since it has governed two campaigns already.
`docs/dev/operations/workflow-economy-proposals.md` is annotated as delivered
with its root-cause paragraph restated for the residue. The two-minute figure
for a plan-only pull request is a measured target for the checks after
dependency setup and bootstrap restore, reported in the campaign guide, not
an acceptance criterion.

## Consequences

Every later campaign ledger commit, task prompt, and scorecard record runs a
handful of nodes and one semantic check instead of the full affected floor,
and the campaign contract is enforced in the gate rather than only locally.
The taxonomy becomes the single source of lane selection, so the adopter
default binding and the descriptor must agree, which the materialization
check already enforces; a stale bootstrap cache key can only cause a
recompile, never a stale runner. Accepting the campaign policy binds the
Owner-effect closure rule on CMP-0002's successor, and docs-governance
becomes a real gate member on the framework's documentation.

## Alternatives Considered

A plan branch outside `main` is rejected: the campaign policy binds the
ledger to `main`, and a parallel branch needs its own binding and freshness
design. A workflow-level `paths-ignore` filter is rejected because a candidate
could edit it and the taxonomy already classifies every tracked path.
Narrowing the lane to campaigns and prompts only is rejected by the maintainer
in favour of the whole `plan` class with the scorecard page check joining
`plan:validate`. Keeping the campaign policy `proposed` while enforcing its
new closure rule is rejected as inconsistent with two campaigns under it.

## Affected Rules

- `test-tasks.json`: the planning-lane profile, the `class` selectors, the two
  new `plan:validate` members, and every member of `docs:validate`.
- The pull-request workflow and `scripts/run-pr-release-gate.mjs`: the
  bootstrap cache and the single affected invocation; `check-campaign.mjs`
  and `campaign-execution.json`: the closure rule and the policy status.
- The two taxonomy bindings, `.devai/config/project.json`,
  `docs-governance-publish-checks.ts`, `docs/adopters/docs-layout.md`, and
  the workflow economy proposals page: the `work/` entry, the declarations,
  the `no-ci-publish` wording, and the delivery note.

## Inspector Adversarial Acceptance

Open a fixture pull request that changes one prompt and the campaign ledger
and confirm the planned node set is exactly the planning lane, that the
campaign check reports, and that the bootstrap step restores from cache.
Change a prompt and a package source, or rename a `product/` file, and edit
the workflow path filter in the same candidate; confirm the `affected`
profile is planned. Run `check --only docs-governance` on `main` and confirm
it passes; remove `repo.kind` and confirm `docs:validate` fails. Close a
fixture round whose Owner effect has no `performed_at` and confirm the check
names the effect and the policy loads as accepted. Edit a scorecard record
without regenerating its page; confirm `plan:validate` fails, `build` unrun.
