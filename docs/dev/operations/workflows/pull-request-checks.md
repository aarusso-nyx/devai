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
  - gate-cli
  - gate-rest
  - gate
```

## Triggers and path scope

| Event          | Activity types                                          | Candidate                            | Base                                 |
| -------------- | ------------------------------------------------------- | ------------------------------------ | ------------------------------------ |
| `pull_request` | `opened`, `synchronize`, `reopened`, `ready_for_review` | `github.event.pull_request.head.sha` | `github.event.pull_request.base.sha` |
| `merge_group`  | `checks_requested`                                      | `github.event.merge_group.head_sha`  | `github.event.merge_group.base_sha`  |

Neither trigger carries a path filter. The lane is selected from the change taxonomy
(the planning lane for `plan`-only changes, the affected profile otherwise), never from
a workflow path filter (ADR-CHK-0003). Both partition jobs export the base to every step
as `DEVAI_PREFLIGHT_BASE` and check out the same candidate.

The concurrency group is `<workflow name>-pr-<pull-request number>` under
`pull_request` and `<workflow name>-mq-<queue head sha>` under `merge_group`, with
`cancel-in-progress: true`. It covers all three jobs of a run. A new head of the same
pull request cancels the previous head's run, and no queue entry cancels another
(ADR-CHK-0004).

## Jobs and their order

The affected plan of one head is split across two partition jobs, and a third job
aggregates their reports (ADR-CHK-0007 rule 11).

| Job         | Check name           | Needs                   | Condition  | Runner          | Timeout    |
| ----------- | -------------------- | ----------------------- | ---------- | --------------- | ---------- |
| `gate-cli`  | `gate-cli`           | none                    | always     | `ubuntu-latest` | 20 minutes |
| `gate-rest` | `gate-rest`          | none                    | always     | `ubuntu-latest` | 20 minutes |
| `gate`      | `devai-release-gate` | `gate-cli`, `gate-rest` | `always()` | `ubuntu-latest` | 10 minutes |

- `gate-cli` and `gate-rest` start together.
- `gate` starts when both have finished, whatever their result, so a failed or
  cancelled partition still reaches the aggregator and fails the required check.
- Branch protection requires only `devai-release-gate`.

## Environments and who stops there

None. No job declares an `environment`, so nobody stops here: the run starts on the event
alone.

The workflow-level `permissions` block is `contents: read`. `gate` overrides it with
`contents: read` and `actions: read`, which it needs to download the partition reports of
the same run.

## Secrets and variables each job reads

| Job         | Secrets | Variables | Token                                                                                |
| ----------- | ------- | --------- | ------------------------------------------------------------------------------------ |
| `gate-cli`  | none    | none      | the job-scoped `GITHUB_TOKEN` is not read by any step                                |
| `gate-rest` | none    | none      | the job-scoped `GITHUB_TOKEN` is not read by any step                                |
| `gate`      | none    | none      | the job-scoped `GITHUB_TOKEN`, used only by `actions/download-artifact` for this run |

Every checkout uses `persist-credentials: false`, so no credential survives the checkout
step.

## What each job runs

`gate-cli` and `gate-rest` share their first five steps:

1. **Check out exact candidate**: `actions/checkout` at the candidate sha above with
   `fetch-depth: 0` and `persist-credentials: false`.
2. **Set up pnpm and Node**: the local composite action
   `.github/actions/setup-node-toolchain` with `setup-pnpm: 'true'` and `cache: pnpm`.
3. **Restore the check runner bootstrap** (`id: bootstrap-cache`): `actions/cache` on
   `.devai/state/pr-bootstrap` and `packages/*/dist`. The key is the digest of:
   - the lockfile;
   - the TypeScript project files;
   - every `packages/*/src/**/*.ts`;
   - every `packages/*/package.json`;
   - `scripts/process/bootstrap-check-runner.mjs` (ADR-CHK-0003).

   The two jobs share the key.

4. **Compile the check runner bootstrap** (`id: install`): `pnpm install --frozen-lockfile`,
   then `pnpm run release:bootstrap` only when the cache missed.
5. **Preflight probes** (`id: preflight`):
   - It copies the vendored verifier from `packages/cli/vendor/evidence-verification` into
     `$RUNNER_TEMP` and checks it: the package identity, the five `bin` entries, the
     provenance `schemaVersion` and `sourceCommit`, the file population, and every file
     digest against `provenance.json`.
   - It exports `DEVAI_EVIDENCE_POLICY`, `DEVAI_EVIDENCE_VERIFY`, and
     `DEVAI_EVIDENCE_BUNDLE_VERIFY`.
   - Through the bootstrapped runner, it runs `init bind --target . --as-role architect --write`,
     then `check --preflight --run --base "$DEVAI_PREFLIGHT_BASE" --as-role inspector --write`.
   - In `gate-rest` only, it then runs the four gate invariant producers of ADR-SCR-0013,
     each failing the step on its own:

     | Command                                                       | Invariant       |
     | ------------------------------------------------------------- | --------------- |
     | `sense run trace_resolution`                                  | INV-DEVAI-002   |
     | `audit scorecard --at` the checked-out head                   | INV-HARNESS-006 |
     | `check --only blueprint` on the committed gate fixture        | INV-DEVAI-010   |
     | `sense inventory --slice pack` on the committed packs fixture | INV-HARNESS-010 |

Then each partition job runs its share of the affected plan and uploads its report.

6. **`gate-cli`, Affected checks owned by test:cli** (`id: affected`):
   `check --affected --run --base "$DEVAI_PREFLIGHT_BASE" --partition-include test:cli --as-role inspector --write`.
   It writes the report to `$RUNNER_TEMP/devai-gate-report-cli/report.json`. On failure,
   `scripts/process/summarize-check-report.mjs` names each failing node.

   **`gate-rest`, Affected checks and profile-selected candidate preflight**
   (`id: affected`) runs two commands:
   - `pnpm run release:pr-gate -- "$DEVAI_PREFLIGHT_BASE"`: commit-range hygiene, the bump
     floor, and the release profile preflight for a version-changing pull request;
   - `check --affected --run --base "$DEVAI_PREFLIGHT_BASE" --partition-exclude test:cli --as-role inspector --write`.
     It writes the report to `$RUNNER_TEMP/devai-gate-report-rest/report.json`, with the
     same failure summary.

7. **Upload the partition report** (`if: always()`): `actions/upload-artifact` uploads
   the report as `devai-gate-report-cli` or `devai-gate-report-rest`.
   - Retention is 7 days.
   - `if-no-files-found: ignore`: a missing report is caught by the aggregator, never
     here.

The partition decides which planned nodes each job owns:

- **Owned nodes.** `gate-cli` owns `test:cli` and every planned node that depends on it.
  `gate-rest` owns every other planned node.
- **Prerequisites.** `gate-cli` also runs the dependency closure of `test:cli` as
  prerequisites, which `gate-rest` owns.
- **Partitioned-out nodes.** Every other planned node appears in a report as
  `partitioned-out`, outcome `SKIPPED`.
- **Fallback plan.** In the `test:local-full` fallback plan, `gate-cli` owns everything.
- **No `test:cli` in the plan.** `gate-cli` owns nothing and passes.
- **No receipt.** A partitioned run writes no receipt.

`gate` (check name `devai-release-gate`) runs these steps:

1. **Check out exact candidate**: `actions/checkout` at the candidate sha with
   `fetch-depth: 1` and `persist-credentials: false`, for the aggregation script only.
2. **Set up Node**: the local composite action `.github/actions/setup-node-toolchain`.
3. **Download the partition reports**: `actions/download-artifact` with pattern
   `devai-gate-report-*` into `$RUNNER_TEMP/gate-reports`.
4. **Aggregate the partition reports** (`id: aggregate`): `scripts/aggregate-gate-partitions.mjs`
   with the include and exclude report directories and the two job results.

The aggregator executes no check node. It fails unless all of these hold:

- both jobs succeeded;
- exactly one include report and one exclude report exist over the same listed nodes;
- the two reports agree on candidate, base, descriptor and task-policy digests, and
  planned node set;
- each report holds one entry per planned node;
- every planned node has exactly one owned entry across the pair, and that entry is a
  PASS, executed or reused.

Each step fails its job on its own. A partition job's verdict is its report's verdict over
the nodes it owns, and the task DAG marks the dependents of a `BLOCKED` probe
blocked-environment (ADR-CHK-0001).

## Direct effects

- The `devai-release-gate` check on the pull-request head or on the queue entry. It is
  the required check that admits a head to the queue and, under `merge_group`, the
  binding result for `main`.
- The `gate-cli` and `gate-rest` checks, which are informative and not required.
- A transient preflight receipt in each partition job that gates only that job. It is
  never uploaded.

## Side effects

- One Actions cache entry per bootstrap key (`.devai/state/pr-bootstrap` and
  `packages/*/dist`), shared by both partition jobs. A stale key only causes a
  recompile.
- Two run-scoped artifacts, `devai-gate-report-cli` and `devai-gate-report-rest`. Each
  holds one non-attesting check report and is retained for 7 days. They are not
  evidence and not a release claim.
- No write to any protected ledger.

## Recovery paths

- **A red run on a sound head.** Re-run the failed jobs from the Actions page. A re-run of
  a partition job re-runs `gate` too. The lane is deterministic for the same base and
  candidate, so a different result on re-run is a defect to report, not a flake to
  retry past.
- **`devai-release-gate` red while both partitions are green.** The aggregation found a
  report missing, a mismatch between the reports, or a node not owned exactly once. Its
  log names the rule. Re-run all jobs. If it repeats, report the runner defect.
- **A `BLOCKED` probe.** The report names the environment prerequisite: toolchain
  identity, verifier-package identity, or base freshness. Fix the environment or rebase;
  a `BLOCKED` probe is never a candidate defect.
- **Cancelled by a newer head.** Nothing to do. The newer head's run is the one that
  counts.
- **Failed queue entry.** The queue removes the entry, and the pull request needs a new
  `pull_request` run before it can be re-queued (ADR-CHK-0004).
- **Cache poisoning suspicion.** Change any file in the cache key (a source file
  suffices) so the next run recompiles. The cache holds only compiled output.

## Steps an adopter may reuse

- The exact-candidate checkout with `fetch-depth: 0` and `persist-credentials: false`.
- The bootstrap cache keyed by the digest of the compile inputs (step 3), together with
  the compile-on-miss step (step 4).
- The composite setup action shape: one local action for post-checkout toolchain setup,
  never for the first checkout.
- The partitioned gate: two `check --affected --run` jobs with `--partition-include`
  and `--partition-exclude` over the same node list, plus an aggregator under `always()`
  that carries the single required check name.
- Not reusable as-is: the verifier-package materialization in step 5 checks DEVAI's own
  vendored verifier. An adopter has no such vendor tree and runs `check --preflight`
  against its own `test-tasks.json`.

## Public trust input boundary

No step of the workflow as it stands reads `DEVAI_SOFT_GATE_TRUST_JSON`. The boundary
below governs the declared provider-free `soft-gate` step whenever it is present.

The sole additional variable read is the exact public trust expression above, once at
the declared provider-free step. All secrets, other vars, whole contexts, bracket reads,
duplicate or relocated reads and unknown fields remain refused. The independently
controlled tuple binds immutable evidence commit/payload digest, Ed25519 SPKI/key identity,
reviewed producer control and exact working/evaluator/candidate/base identities. It is
not candidate-authored law or a fixture. Fetch/signature/member/host observation checks
and gate consumption preserve the same frozen verified bytes privately or fully reverify
them; a serialized `verified:true` field conveys no authority. PR-head and merge-group
evidence are distinct; movement requires new separately bounded evaluation/selection.
