---
id: ADR-CHK-0008
title: Admit the update branch with the rebase method only, driven by a rebase-update workflow when main moves
type: adr
status: accepted
date: 2026-10-08
authority: Architect
supersedes: []
provenance:
  - ADR-CHK-0004
  - ADR-CHK-0007
  - ADR-GOV-0018
  - ADR-REL-0027
  - .github/workflows/pull-request-checks.yml
  - docs/dev/operations/remote-preflight-contract.md
affected_rules:
  - .github/workflows/update-pull-request-branches.yml
  - scripts/check-workflows.mjs
  - docs/dev/operations/remote-preflight-contract.md
inspector_acceptance:
  - IA-001 -- A push to main rebases every open, non-draft pull request against main that is behind it through the update-branch API with update_method rebase and the expected head sha, and no update ever creates a merge commit on a pull-request branch.
  - IA-002 -- A pull request whose rebase conflicts is skipped and reported without failing the update of the others, and its gate run is neither started nor cancelled by the update workflow.
  - IA-003 -- A rebased head started by the update workflow starts a gate run, because the push is made with a GitHub App installation token; an update made with GITHUB_TOKEN would start none and is refused by the workflow checker.
  - IA-004 -- When the rebased head arrives while the previous head's gate is running, the per-pull-request concurrency group cancels the superseded run, which ends cancelled rather than failed and is excluded from harness_green_main.
  - IA-005 -- scripts/check-workflows.mjs fails when the update workflow loses its push-to-main trigger, its rebase update method, its expected-head-sha guard, its App-token credential, or its least-privilege permissions, and strict up-to-date protection and the single required check devai-release-gate are unchanged.
  - IA-006 -- With TASK-0728 merged, the commit-range check fails a pull-request commit whose committer is neither its author role nor the recorded update-branch App, or whose author role lacks Article 6 authority over a path it touches; a rebase update by the App never fails it.
  - IA-007 -- With TASK-0728 merged, the commit-range check fails any pull-request range that contains a commit with more than one parent, so a merge update pressed in the GitHub interface reddens the gate; the grammar exemption for merge commits is unchanged.
  - IA-008 -- The commit-range check admits each path only for the authors its table row names, so an Architect commit under packages/, an Engineer commit under law/ or docs/, a commit mixing two roles, and a committed file under scratch/ other than its README each fail, while a Machine commit under record/ and an Architect commit pairing law/policy with its .devai/config copy pass.
---

# Admit the update branch with the rebase method only

## Status

Accepted on 2026-10-08 by the Architect for campaign CMP-0007, round R-0702,
under Owner decision D2 of 2026-10-07: enable the auto-update branch rather
than a merge queue. This record narrows one alternative ADR-CHK-0004
rejected and leaves every other part of that record in force: strict
up-to-date branch protection, the single required check, the
`merge_group` lane, serialized admission while no queue is enabled, and the
rebase merge method.

## Context

Over the 30 days to main 92526921, 13 of the 47 failed pull-request gate runs
were the `base-up-to-date` probe reporting that main had moved. Those runs
count against F5:T9 (`harness_green_main`). ADR-CHK-0004 rejected
`allow_update_branch` because GitHub's default update merges main into the
branch, and a merge commit breaks linear history and the single-family
commit grammar (ADR-GOV-0018). GitHub's update-branch operation also has a
rebase method, which replays the branch's commits onto the new tip and
creates no merge commit. The setting by itself updates nothing: it only lets
someone press the button or call the API.

A push made with the workflow's `GITHUB_TOKEN` starts no workflow run. An
update performed with it would leave the rebased head ungated.

## Decision

`allow_update_branch` is admitted with one update method, rebase. A merge
update of a pull-request branch is refused by this record as ADR-CHK-0004
refused it.

The setting also exposes GitHub's merge-update button, so the refusal is
enforced by the gate, not by convention. `scripts/check-commit-range.mjs`,
which `release:pr-gate` runs over the pull request's range, fails a range
that contains any commit with more than one parent (CMP-0007 TASK-0728,
Engineer; tests in TASK-0729, Inspector). This is a linear-history rule
beside the commit grammar. The grammar's `merge_commits` exemption still
means a merge commit is not judged for its subject, but a pull-request
range may not contain one. OE-02 is not performed before TASK-0728 merges.

The mechanism that keeps pull requests current is the rebase-update
workflow `.github/workflows/update-pull-request-branches.yml` (CMP-0007
TASK-0726):

1. **Trigger.** It runs on every push to main.
2. **Update.** For every open, non-draft pull request against main that is
   behind it, it calls
   `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` with
   `update_method: rebase` and the pull request's current head sha as the
   expected head.
3. **Credential.** It acts with a GitHub App installation token, never with
   `GITHUB_TOKEN`, so the rebased head starts a gate run. The workflow holds
   the least permissions it needs.
4. **Conflicts.** A pull request whose rebase conflicts is skipped and
   reported; the others are still updated, and a conflict is resolved by its
   author.

The rebased head arrives as a `synchronize` event. The existing concurrency
group of `pull-request-checks.yml`, keyed by workflow and pull-request number
with `cancel-in-progress: true`, cancels the superseded head's run. That run
ends cancelled, not failed, and the sensors exclude cancelled runs. The gate,
its three jobs (ADR-CHK-0007 rule 11), strict up-to-date protection, and the
single required check `devai-release-gate` are unchanged.

The Owner performs one effect, OE-02 of CMP-0007: enable
`allow_update_branch` on the repository and install the GitHub App with its
credential. No task performs it, and this record changes no setting.

## Consequences

A pull request no longer fails its gate because main moved: it is rebased
and re-gated instead. The only remaining main-moved failure is a run that
completed against a base that moved before the update workflow reacted.

A rebase update replays the pull request's commits, so their committer
becomes the update identity while their authorship is unchanged. Commit
provenance therefore works as follows:

- **The author carries the role.** A commit's role is its author identity,
  for example `DEVAI Architect <architect@devai.local>`.
- **Admitted committers.** The committer must be one of:
  - the same role as the author;
  - the human merger, when a rebase merge onto main re-commits the commit
    (main already reads `DEVAI <Role>` as author and the merger as
    committer);
  - the update-branch GitHub App, when it performs a rebase update under
    this record.
- **Defect.** Any other committer on a commit inside a role-scoped pull
  request is a provenance defect.
- **No replay.** Role sessions are not required to replay their commits
  after a rebase update; requiring it would defeat the update.
- **Enforcement.** TASK-0728 (Engineer) extends
  `scripts/check-commit-range.mjs` to check every commit of a pull request's
  range on two counts:
  - its author is a role identity whose Article 6 path authority covers every
    path the commit touches;
  - its committer is either that role or the update-branch App identity the
    Owner records with OE-02.

  The human-merger committer appears only on main, after a merge, so it is
  never inside a pull-request range. TASK-0729 (Inspector) tests the check.
  Until both merge, this rule is binding and checked in review by hand.

The commit grammar, the single-family rule, and the version-bump derivation
of ADR-REL-0027 are evaluated on the rebased commits and are unaffected.

### Author-path table for the commit-range check

TASK-0728 judges each commit of a pull-request range against this table.
Identities are exact: a role author is `DEVAI <Role> <<role>@devai.local>`
for Owner, Architect, Inspector, or Engineer, and the machine author is
`DEVAI Machine <machine@devai.local>`. For each changed path, the most
specific row that matches decides which authors are admitted. A commit
passes only when its author is admitted for every path it changes, so one
commit never mixes the paths of two roles.

| Path                                                                                                                                                                                                                                                                                               | Admitted author                                                                                   | Basis                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `law/glossary/`                                                                                                                                                                                                                                                                                    | Architect or Owner                                                                                | Article 6, joint row                                                                                      |
| `law/`                                                                                                                                                                                                                                                                                             | Architect                                                                                         | Article 6                                                                                                 |
| `product/`                                                                                                                                                                                                                                                                                         | Owner                                                                                             | Article 6                                                                                                 |
| `docs/`                                                                                                                                                                                                                                                                                            | Architect                                                                                         | Article 6                                                                                                 |
| `README.md`, `CLAUDE.md`, `AGENTS.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`                                                                                                                                                                                                                         | Architect                                                                                         | Article 6, root prose; the change taxonomy binds them to `docs`                                           |
| `tests/`, `packages/*/tests/`                                                                                                                                                                                                                                                                      | Inspector                                                                                         | Article 6                                                                                                 |
| `packages/`                                                                                                                                                                                                                                                                                        | Engineer                                                                                          | Article 6                                                                                                 |
| root workspace configuration: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig*.json`, `vitest.config.ts`, `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.npmrc`, `.node-version`, `.gitignore`, `test-tasks.json`, `test-task-exclusivity.json` | Engineer                                                                                          | Article 6, root workspace configuration                                                                   |
| `scripts/`, `.githooks/`, `.github/`                                                                                                                                                                                                                                                               | Engineer                                                                                          | Article 6, host-tool directories classified by content as repository automation                           |
| `.claude/` (tracked files only)                                                                                                                                                                                                                                                                    | Architect                                                                                         | Article 6, agent permission policy is F5-host under Architect authority                                   |
| `.devai/config/` copies of a `law/policy/` source: `change-taxonomy.json`, `domains.json`, `forbidden-actions.json`, `glob-guards.json`, `release-verification.json`, `scorecard-na.json`, `subprocess-effects.json`, `thresholds.json`                                                            | Architect, in the commit that changes the source (the `law` with `generated` pairing), or Machine | Article 6; materialized only by `init apply` or `init bind`                                               |
| `.devai/pin/`, `.devai/constitution.md`, `.devai/config/project.json`, `.devai/config/adopter-policy-binding.json`                                                                                                                                                                                 | Machine, or Architect in the commit that changes the pinned law source                            | written by `init apply` or `init bind`                                                                    |
| `.devai/config/change-taxonomy-binding.json`, `.devai/config/credential-requirements-binding.json`, `.devai/config/sensor-inputs.json`                                                                                                                                                             | Architect                                                                                         | adopter-owned bindings that declare policy: change classes, bound credentials, plant surfaces             |
| `.devai/config/toolchain.json`, `.devai/config/preflight-probes.json`                                                                                                                                                                                                                              | Engineer                                                                                          | adopter-owned bindings that declare toolchain identity and probe nodes, like root workspace configuration |
| `record/`                                                                                                                                                                                                                                                                                          | Machine, or the role of the session whose executing verb wrote it                                 | Article 6, machine only; integrity is proven by chain verification (ADR-EVI-0002), not by authorship      |
| `scratch/README.md`                                                                                                                                                                                                                                                                                | Architect                                                                                         | the only committed scratch file                                                                           |
| `.devai/state/.gitkeep`, `.devai/worktrees/.gitkeep`                                                                                                                                                                                                                                               | Engineer                                                                                          | workspace placeholders                                                                                    |
| any other path under `scratch/`, `.devai/state/`, `.devai/worktrees/`, `.devai/local/`                                                                                                                                                                                                             | none, refused                                                                                     | never committed                                                                                           |

Two rules close the table:

- **Unlisted paths are refused.** Article 6 decides authority by table
  lookup, never by a default remainder, so a path no row names fails the
  check. A new root file or directory needs a row here before it can be
  committed.
- **Machine commits.** A commit by the machine author may touch only the rows
  that admit Machine. Its committer is the machine identity or the update
  App.

- **Release pull requests need two roles.** The version roll touches the
  package manifests (`package.json`, `packages/*/package.json`, Engineer) and
  `CHANGELOG.md` (Architect). A release pull request therefore carries at
  least two commits: an Engineer commit for the manifests and an Architect
  commit for the changelog. Release preparation plans both sessions; one
  commit carrying both fails the check.

TASK-0728 carries this table in the checker. A change to the table is a
change to this record.

## Alternatives Considered

The merge update method stays rejected for the reason ADR-CHK-0004 gives.
A merge queue was the alternative D2 did not choose; ADR-CHK-0004 still
governs it if it is ever enabled. Updating with `GITHUB_TOKEN` is rejected
because the rebased head would never be gated. Retrying a blocked
`base-up-to-date` probe is rejected as before: a retry reproduces the race.
Relying on the setting alone is rejected because nobody would press the
button for every open pull request on every merge.

## Affected Rules

- `.github/workflows/update-pull-request-branches.yml`: the push-to-main
  trigger, the rebase update with the expected head sha, the App-token
  credential, conflict reporting, and least-privilege permissions.
- `scripts/check-workflows.mjs`: pins for the trigger, the rebase method, the
  expected-head guard, the credential, and the permissions.
- `docs/dev/operations/remote-preflight-contract.md`: the update path and the
  exact Owner effect.

## Inspector Adversarial Acceptance

- IA-001 -- A push to main rebases every open, non-draft pull request against main that is behind it through the update-branch API with update_method rebase and the expected head sha, and no update ever creates a merge commit on a pull-request branch.
- IA-002 -- A pull request whose rebase conflicts is skipped and reported without failing the update of the others, and its gate run is neither started nor cancelled by the update workflow.
- IA-003 -- A rebased head started by the update workflow starts a gate run, because the push is made with a GitHub App installation token; an update made with GITHUB_TOKEN would start none and is refused by the workflow checker.
- IA-004 -- When the rebased head arrives while the previous head's gate is running, the per-pull-request concurrency group cancels the superseded run, which ends cancelled rather than failed and is excluded from harness_green_main.
- IA-005 -- scripts/check-workflows.mjs fails when the update workflow loses its push-to-main trigger, its rebase update method, its expected-head-sha guard, its App-token credential, or its least-privilege permissions, and strict up-to-date protection and the single required check devai-release-gate are unchanged.
- IA-006 -- With TASK-0728 merged, the commit-range check fails a pull-request commit whose committer is neither its author role nor the recorded update-branch App, or whose author role lacks Article 6 authority over a path it touches; a rebase update by the App never fails it.
- IA-007 -- With TASK-0728 merged, the commit-range check fails any pull-request range that contains a commit with more than one parent, so a merge update pressed in the GitHub interface reddens the gate; the grammar exemption for merge commits is unchanged.
- IA-008 -- The commit-range check admits each path only for the authors its table row names, so an Architect commit under packages/, an Engineer commit under law/ or docs/, a commit mixing two roles, and a committed file under scratch/ other than its README each fail, while a Machine commit under record/ and an Architect commit pairing law/policy with its .devai/config copy pass.
