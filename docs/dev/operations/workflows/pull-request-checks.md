# pull-request-checks.yml

The non-attesting merge preflight. It runs on every pull-request head and on every
merge-queue entry, produces no attested evidence, and can never sign, export, or
supplement a candidate receipt. Its contract is the
[remote preflight contract](../remote-preflight-contract.md); this page describes the
file as it stands.

<!-- devai:workflow-metadata -->

```yaml
workflow: .github/workflows/pull-request-checks.yml
triggers:
  - pull_request
  - merge_group
jobs:
  - preflight
```

## Triggers and path scope

| Event          | Activity types                                          | Candidate                            | Base                                 |
| -------------- | ------------------------------------------------------- | ------------------------------------ | ------------------------------------ |
| `pull_request` | `opened`, `synchronize`, `reopened`, `ready_for_review` | `github.event.pull_request.head.sha` | `github.event.pull_request.base.sha` |
| `merge_group`  | `checks_requested`                                      | `github.event.merge_group.head_sha`  | `github.event.merge_group.base_sha`  |

Neither trigger carries a path filter: the lane is selected from the change taxonomy
(the planning lane for `plan`-only changes, the affected profile otherwise), never from
a workflow path filter (ADR-CHK-0003). The base is exported to every step as
`DEVAI_PREFLIGHT_BASE`.

The concurrency group is `<workflow name>-pr-<pull-request number>` under
`pull_request` and `<workflow name>-mq-<queue head sha>` under `merge_group`, with
`cancel-in-progress: true`: a new head of the same pull request cancels the previous
head's run, and no queue entry cancels another (ADR-CHK-0004).

## Jobs and their order

One job, `preflight`, whose check name is `devai-release-gate`. It runs on
`ubuntu-latest` with a 20 minute timeout.

## Environments and who stops there

None. The job declares no `environment`, so nobody stops here; the run starts on the
event alone. The workflow-level `permissions` block is `contents: read` and the job
declares no override.

## Secrets and variables each job reads

| Job         | Secrets | Variables | Token                                                 |
| ----------- | ------- | --------- | ----------------------------------------------------- |
| `preflight` | none    | none      | the job-scoped `GITHUB_TOKEN` is not read by any step |

The checkout uses `persist-credentials: false`, so no credential survives the checkout
step.

## What each job runs

`preflight` runs these steps in order:

1. **Check out exact candidate**: `actions/checkout` at the candidate sha above with
   `fetch-depth: 0` and `persist-credentials: false`.
2. **Set up pnpm and Node**: the local composite action
   `.github/actions/setup-node-toolchain` with `setup-pnpm: 'true'` and `cache: pnpm`.
3. **Restore the check runner bootstrap** (`id: bootstrap-cache`): `actions/cache` on
   `.devai/state/pr-bootstrap`, keyed by the digest of the lockfile, the TypeScript
   project files, every `packages/*/src/**/*.ts`, every `packages/*/package.json`, and
   `scripts/process/bootstrap-check-runner.mjs` (ADR-CHK-0003).
4. **Compile the check runner bootstrap** (`id: install`): `pnpm install --frozen-lockfile`,
   then `pnpm run release:bootstrap` only when the cache missed.
5. **Preflight probes** (`id: preflight`): copies the vendored verifier from
   `packages/cli/vendor/evidence-verification` into `$RUNNER_TEMP`, checks the package
   identity, the five `bin` entries, the provenance `schemaVersion` and `sourceCommit`,
   the file population, and every file digest against `provenance.json`; exports
   `DEVAI_EVIDENCE_POLICY`, `DEVAI_EVIDENCE_VERIFY`, and `DEVAI_EVIDENCE_BUNDLE_VERIFY`;
   then runs `init bind --target . --as-role architect --write` and
   `check --preflight --run --base "$DEVAI_PREFLIGHT_BASE" --as-role inspector --write`
   through the bootstrapped runner.
6. **Affected checks and profile-selected candidate preflight** (`id: affected`):
   `pnpm run release:pr-gate -- "$DEVAI_PREFLIGHT_BASE"` (commit-range hygiene, the bump
   floor, and the release profile preflight for a version-changing pull request), then
   `check --affected --run --base "$DEVAI_PREFLIGHT_BASE" --as-role inspector --write`.

Each step fails the job on its own; the runner report is the lane's verdict and the
task DAG marks the dependents of a `BLOCKED` probe blocked-environment (ADR-CHK-0001).

## Direct effects

- The `devai-release-gate` check on the pull-request head or on the queue entry. It is
  the required check that admits a head to the queue and, under `merge_group`, the
  binding result for `main`.
- A transient preflight receipt that gates only the current run. It is never uploaded.

## Side effects

- One Actions cache entry per bootstrap key (`.devai/state/pr-bootstrap`); a stale key
  only causes a recompile.
- No artifact, no evidence upload, no release claim, no write to any protected ledger.

## Recovery paths

- **A red run on a sound head**: re-run the job from the Actions page. The lane is
  deterministic for the same base and candidate; a different result on re-run is a
  defect to report, not a flake to retry past.
- **A `BLOCKED` probe**: the report names the environment prerequisite (toolchain
  identity, verifier-package identity, base freshness). Fix the environment or rebase;
  a `BLOCKED` probe is never a candidate defect.
- **Cancelled by a newer head**: nothing to do; the newer head's run is the one that
  counts.
- **Failed queue entry**: the queue removes the entry and the pull request needs a new
  `pull_request` run before it can be re-queued (ADR-CHK-0004).
- **Cache poisoning suspicion**: change any file in the cache key (a source file
  suffices) so the next run recompiles; the cache holds only compiled output.

## Steps an adopter may reuse

- The exact-candidate checkout with `fetch-depth: 0` and `persist-credentials: false`.
- The bootstrap cache keyed by the digest of the compile inputs (step 3) together with
  the compile-on-miss step (step 4).
- The composite setup action shape: one local action for post-checkout toolchain setup,
  never for the first checkout.
- Not reusable as-is: the verifier-package materialization in step 5 checks DEVAI's own
  vendored verifier; an adopter has no such vendor tree and runs `check --preflight`
  against its own `test-tasks.json`.
