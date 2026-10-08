# Remote preflight contract

Status: accepted for DEVAI's own repository. Adopter workflow authority is unchanged.

## Invariant

Remote CI does not execute the attested RC closure, and remote execution never
produces, substitutes for, or supplements a candidate receipt in the protected
ledger. A transient preflight receipt coordinates the current run; it is not uploaded.
An unsigned local cache record from an untrusted run is not signing authority.

One required `devai-release-gate` runs on every pull-request head and on every
merge-queue entry (ADR-CHK-0004). It is the aggregator of two partition jobs that
split one affected plan (ADR-CHK-0007 rule 11; see [Three gate jobs](#three-gate-jobs)).
Each partition job, step by step on the
[workflow page](workflows/pull-request-checks.md), restores or compiles the check runner
bootstrap, runs the preflight probes, then runs its share of the affected checks. The preflight step
runs `check --preflight --run` against the event base, which is the pull-request base
under `pull_request` and the queue base under `merge_group`, executing the preflight
probes of `test-tasks.json` (verifier-package materialization, toolchain identity, base
freshness) as DAG nodes (ADR-CHK-0001); the affected step runs `release:pr-gate` and
then `check --affected --run`, the unconditional cheap floor plus affected selection on
Linux. It proves only
execution outcomes and consistency on that runner. It does not prove the local RC
closure executed, and a signed local claim does not prove Linux execution. These
observations answer different questions.

The affected plan is planned identically in both partition jobs, and each planned node
is owned, executed and counted by exactly one of them. `release:pr-gate` runs once,
in `gate-rest`, before its affected check, and keeps commit-range hygiene, the bump floor and, for a
version-changing pull request, the release profile preflight; it no longer plans the
affected target a second time (ADR-CHK-0003).

When every changed path is an addition or modification that the change taxonomy
classifies as `plan` under both the base and the candidate binding, the affected check
plans the planning lane instead of the affected floor: the preflight nodes,
`plan:validate` (journeys, the campaign check and the scorecard-page check) and
`format`, none of which depends on `generate` or `build`. A rename, a deletion, a path
of any other class, or a candidate that rebinds the taxonomy falls back to the
affected profile. The lane is selected from the taxonomy, never from a workflow path
filter, so neither trigger carries one.

## Three gate jobs

The pull-request workflow splits the affected plan of one head across two partition jobs.
`test:cli` is CPU-bound and alone saturates the 4-vCPU runner, so the runner's parallel
workers could not bring the median below 600 s (ADR-CHK-0007, decision D1 of CMP-0007).

| Job                  | Runs                                                                                                                                                             | Uploads                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `gate-cli`           | bootstrap, `check --preflight --run`, then `check --affected --run --partition-include test:cli`                                                                 | `devai-gate-report-cli`  |
| `gate-rest`          | bootstrap, `check --preflight --run`, the gate invariant producers (ADR-SCR-0013), `release:pr-gate`, then `check --affected --run --partition-exclude test:cli` | `devai-gate-report-rest` |
| `devai-release-gate` | needs both jobs and runs under `always()`; reads the two reports and the two job results; executes no check node                                                 | nothing                  |

Both partition jobs check out the same candidate and pass the same `--base`. They plan
the same plan with the same task keys and task-policy digest. The partition decides only
which planned nodes a job owns:

- **Owned.** `gate-cli` owns `test:cli` and every planned node that depends on it.
  `gate-rest` owns every other planned node.
- **Prerequisites.** `gate-cli` also executes the dependency closure of `test:cli`
  (`generate`, `build`, `test:package-staging`, and the preflight nodes, about 30 s).
  These run as prerequisites. `gate-rest` owns them, so they never count twice.
- **Not separable.** When a planned node depends on `test:cli` and on a node outside its
  closure, as in the `test:local-full` fallback plan, `gate-cli` owns the whole plan and
  `gate-rest` owns nothing.
- **`test:cli` not planned.** When the plan does not select `test:cli`, `gate-cli` owns
  nothing and passes.

Each report lists every planned node once, in plan order:

- an owned node has its ordinary entry;
- a prerequisite node has its ordinary entry, marked `prerequisite`;
- every other node is `partitioned-out`, with outcome `SKIPPED`. It is never started.

A partitioned run writes no receipt. Each partition job fails on its own when one of its
owned entries is not PASS.

The aggregator carries the required check name and passes only when all of these hold:

- both jobs passed;
- exactly the two named reports exist, one `include` and one `exclude` over the same
  node list;
- they agree on candidate, base, descriptor digest, task-policy digest, and planned node
  set;
- each holds one entry per planned node;
- every planned node has exactly one owned entry across the pair, and that entry is a
  PASS, executed or reused.

A missing, cancelled, or extra report fails it. Branch protection keeps the single
required check `devai-release-gate`, and the same three jobs run under `merge_group`.
`scripts/check-workflows.mjs` pins the jobs, both partition commands, the aggregator's
needs, its `always()` condition, and the check name.

## Pre-push preflight

Most failed gate runs are real defects that a local run would have caught: test, lint,
type, format, and commit-grammar failures. The pre-push preflight runs the same checks
before a push leaves the machine (CMP-0007 decision D3).

- **What it runs.** `.githooks/pre-push` runs `scripts/pre-push-preflight.mjs`, which:
  1. fetches the base branch;
  2. runs `scripts/check-commit-range.mjs` over the commits being pushed, from the fetched
     base to the pushed head;
  3. runs `check --affected --run` against the fetched base.

  It refuses the push on a failure and names the failing commit or node. A `BLOCKED`
  probe names the environment fix, as in the local preflight.

- **Agents: mandatory once it ships.** The hook and the `--pre-push` install flag arrive
  with CMP-0007 TASK-0723. From that merge on, every agent session installs it in its
  worktree with `pnpm run hooks:install -- --pre-push`, keeps it installed, and never
  bypasses it with `--no-verify` (AGENTS.md). Until then, agents run the local preflight
  before pushing.
- **Humans: opt-in.** `pnpm run hooks:install` installs the hook alongside `commit-msg`
  and `pre-commit` but leaves it inactive. `pnpm run hooks:install -- --pre-push`
  activates it for the current worktree by setting the worktree-scoped git config
  `devai.prePushPreflight` to `true`. Without that value the hook exits at once and the
  push proceeds.
- **Never a gate.** The hook is a convenience that catches defects earlier. It never
  replaces, skips, or satisfies the CI gate: `devai-release-gate` runs on every head
  whether or not the hook ran, and a green hook proves nothing to the gate.

## Two validation boundaries

Integration is validated twice, at two boundaries that answer different questions
(ADR-CHK-0004). Neither replaces the other.

1. **Ready for a pull request.** The local preflight of ADR-CHK-0001 runs against a
   named, freshly fetched base: `git fetch origin main`, then
   `check --preflight --run --base origin/main` on the rebased candidate. A `BLOCKED`
   `base-up-to-date` probe here names a stale local base, and the fix is a rebase,
   never a retry. This boundary is the condition for opening a pull request. The
   `pull_request` run of the gate repeats the same node set on the runner against
   `github.event.pull_request.base.sha`; that run is the required check on the head,
   and it is what admits the head to the queue.
2. **Integration.** The `merge_group` run of the gate validates the queue candidate:
   the entry as rebased by the queue onto the current tip of `main`, measured against
   the tip it was rebased onto. Its result is the one that is binding for `main`. The
   pull-request run says the head was sound on its own base; the queue run says the
   commits that are about to reach `main` are sound on `main`.

## Queue admission

`pull-request-checks.yml` triggers on `pull_request` and on `merge_group`. The two
events bind the same lane to different inputs; the Inspector pins the bindings in the
workflow-shape contract and the Engineer implements them.

| Binding                                                            | `pull_request`                             | `merge_group`                                             |
| ------------------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------- |
| Candidate (exact checkout ref)                                     | `github.event.pull_request.head.sha`       | `github.event.merge_group.head_sha`                       |
| Base (`--base` of both check steps, argument of `release:pr-gate`) | `github.event.pull_request.base.sha`       | `github.event.merge_group.base_sha`                       |
| Commit range                                                       | base to candidate                          | base to candidate                                         |
| Check name                                                         | `devai-release-gate`                       | `devai-release-gate`                                      |
| Concurrency group                                                  | workflow name, `pr`, pull-request number   | workflow name, `mq`, `github.event.merge_group.head_sha`  |
| Cancellation                                                       | a new head cancels the previous head's run | none across entries; an entry's head sha is its own group |

The check name is identical under both events, so branch protection keeps exactly one
required check. `cancel-in-progress` stays `true`: under `pull_request` it cancels the
superseded head, and under `merge_group` the group is keyed by the entry's own head sha,
so a queue run can only ever cancel a rerun of the same entry and never another entry.
The checkout fetches full history under both events, so the base commit is present for
the `base-up-to-date` probe and the commit-range check.

**Admission rule.** A pull request enters the queue when its own gate is green on its
head; a red head is refused admission by branch protection and nothing in the queue
retries it. The queue rebases the entry onto the current tip of `main`, which yields a
new candidate head, and runs the gate on that candidate with the tip it was rebased onto
as `github.event.merge_group.base_sha`. On a well-formed entry the queue base is an
ancestor of the candidate by construction, so the `base-up-to-date` probe passes; a
`BLOCKED` probe under `merge_group` means the queue handed the lane a base that is not
an ancestor of the entry, and the entry is refused, not retried. Because the candidate
is the rebased entry, the commit range the queue measures for the commit grammar and
the version-bump derivation (ADR-REL-0027) is the exact set of commits that reaches
`main`.

**Eviction rule.** An entry whose gate fails is evicted with its diagnostic: the runner
report of the failing run is the diagnostic, and the pull request returns to open (its
task returns from `pre_merge` to `in_progress` in the campaign ledger). Eviction does
not cancel the entries behind the evicted one; no queue run cancels another queue run.
The pull request re-enters the queue only from a green head, after its author has
rebased and re-run the local preflight.

**Rebase-method prerequisite.** The queue must merge with the rebase method, keeping
linear history on `main` and the single required check. Squash is forbidden because it
recombines single-family commits (ADR-GOV-0018), and a merge commit breaks linear
history, so rebase is the only method under which the commits the queue tests are the
commits that reach `main`. Enabling the queue with that method is an Owner effect on the
repository settings (OE-01 of CMP-0003), verified and performed before the round that
delivers the `merge_group` lane closes. `allow_update_branch` is not a prerequisite of
either delivery; with no queue enabled it is admitted, rebase only, as the update path
below (ADR-CHK-0008).

## Update path

Without a merge queue, a pull request whose base fell behind `main` used to fail its gate
on the `base-up-to-date` probe. ADR-CHK-0008 keeps pull requests current instead.

- **Rebase only.** `allow_update_branch` is admitted with the rebase update method alone.
  A merge update would put a merge commit on the branch and is refused, as ADR-CHK-0004
  refuses it. The setting still shows GitHub's merge-update button, so the gate enforces the
  refusal: `scripts/check-commit-range.mjs` fails a pull-request range that contains any
  commit with more than one parent (TASK-0728, tested by TASK-0729).
- **The workflow is the mechanism.** `.github/workflows/update-pull-request-branches.yml`
  (CMP-0007 TASK-0726) runs on every push to `main`. For each open, non-draft pull
  request against `main` that is behind it, the workflow calls
  `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` with `update_method: rebase`
  and the pull request's current head sha as the expected head. The setting alone updates
  nothing.
- **App token.** The workflow acts with a GitHub App installation token. A push made with
  `GITHUB_TOKEN` starts no workflow run, so the rebased head would never be gated.
- **Conflicts.** A pull request whose rebase conflicts is skipped and reported. Its author
  resolves it; the other pull requests are still updated.
- **Cancellation, not failure.** The rebased head arrives as `synchronize`. The gate's
  concurrency group (workflow name, `pr`, pull-request number, `cancel-in-progress: true`)
  cancels the superseded head's run, which ends cancelled and is excluded from
  `harness_green_main`.
- **Unchanged.** Strict up-to-date protection, the three gate jobs, and the single
  required check `devai-release-gate` stay as they are.
- **Committer identity.** A rebase update replays the pull request's commits, so their
  committer becomes the update App while authorship is unchanged. The author carries the
  role. The committer must be the same role, the human merger of a rebase merge, or the
  update App of a rebase update; any other committer inside a role-scoped pull request is
  a provenance defect. Nobody replays commits after an update (ADR-CHK-0008). TASK-0728
  enforces the author-path and committer checks in the commit-range check; until it and
  TASK-0729 merge, review applies the rule by hand.

**Owner effect OE-02 (CMP-0007).** No task performs it, and it is not performed before
TASK-0728 merges, so a merge update can never pass the gate. The Owner:

1. Enables the update branch on the repository: Settings, General, Pull Requests,
   "Always suggest updating pull request branches", which is
   `gh api -X PATCH repos/aarusso-nyx/devai -F allow_update_branch=true`. The update
   method is chosen per call, and the workflow always passes `rebase`.
2. Creates or installs a GitHub App on `aarusso-nyx/devai` with repository permissions
   Contents read and write and Pull requests read and write, and nothing else.
3. Stores the App's id and private key as the repository secrets TASK-0726's workflow
   names, readable only by that workflow.
4. Records the App's committer identity, which TASK-0728's committer check admits.

Branch protection, the required check, and the merge method are not changed by OE-02.

## Serialized admission

Serialized admission by the orchestrator is the accepted first delivery whenever the
queue is not enabled on `main`: because the prerequisite failed, or because the Owner
effect has not yet been performed. On 2026-09-28 the repository had no merge queue and
the lane triggered on `pull_request` only, so this rule is the operative one until
OE-01 is recorded.

The rule is recorded in `law/policy/campaign-execution.json` under
`isolation.serialized_admission` and evaluated at the `task_pre_merge` gate: at most
one pull request targeting `main` is in `pre_merge` at a time. A second task does not
enter `pre_merge` until that pull request is merged or returned to `in_progress`; once
it merges, the next task rebases onto the new tip, re-runs the local preflight against
the fetched base, and only then opens its pull request. Under this rule the `pull_request`
run is the binding run, exactly as before ADR-CHK-0004, and campaign throughput is one
integration at a time. If the prerequisite fails, ADR-CHK-0004 records that the queue is
deferred and why; the fallback is then the standing rule rather than an interim one.

## Own-repository workflow set

Each admitted file has a [reference page](workflows/README.md) that states its
triggers, jobs, environments, credentials, effects, and recovery paths.

| File                      | Required purpose                                                          |
| ------------------------- | ------------------------------------------------------------------------- |
| `pull-request-checks.yml` | Unprivileged merge preflight on pull-request heads and queue entries      |
| `devai-ledger-verify.yml` | Explicit dispatch of the protected ledger verification against one commit |
| `release.yml`             | Tag validation, candidate rehearsal, authorized artifact promotion        |
| `site-publish.yml`        | Owner-dispatched documentation site publication from main                 |

The PR lane has `contents: read` (the aggregator job adds `actions: read` for the run's
own report artifacts), no environment, and reads no secret and no variable. The workflow
checker refuses every secret and `vars` read in it. The provider-free scored soft gate of
ADR-MDL-0004, with its single public variable `vars.DEVAI_SOFT_GATE_TRUST_JSON`, is not
part of the lane: the Owner deferred it on 2026-10-03 and its step was removed
(`0ccab59c`), while its scripts stay in the repository for a later release. The lane uses
pinned actions, exact candidate checkout without persisted credentials, Linux runners
and a bounded timeout. It never uploads evidence or executes the local-only RC closure;
its only artifacts are the two non-attesting partition reports the aggregator reads.
Verifier materialization validates bytes; it never invokes signing or receipt verification.

Cancellation is keyed per event as the table above states: by workflow identity and
pull-request number under `pull_request`, so a new head cancels the previous head's
work, and by workflow identity and the entry's head sha under `merge_group`, so no entry
cancels another. Main and release runs are never cancelled by this mechanism.

The step-level aggregator that once read every workflow step outcome moves into the
runner report: the task DAG aggregates independent failures, marks the dependents of a
`BLOCKED` preflight probe blocked-environment, and the lane's verdict is the report's
verdict (ADR-CHK-0001). Verifier-package materialization and toolchain identity are
preflight probes of that same descriptor, so the local run and the lane run plan the
same node set for the same base and candidate. The DAG owns formatting, lint, type
integrity, schema/generated checks, static integrity, package closure and selected
tests. Both ordinary and version-changing PRs require
the floor. Compile-only bootstrap makes the typed runner executable; it does not
assemble a release package or claim a candidate build result.

## Authority and settings

Merge-ready is not release-ready. Main may contain work that passes cheap checks but
has not completed RC certification. Protected verification on main is observation;
it cannot retroactively prevent a merge. Complete RC evidence and rehearsal remain
mandatory before publication.

The policy's `required_check` is effective only when GitHub requires that actual check.
Changing branch protection is a separate Owner-authorized effect, and so is enabling the
merge queue and its merge method. Remove the sole-owner approving-review quota while
retaining agent role separation, linear history and strict up-to-date checks; the queue
satisfies the up-to-date requirement by construction for every entry it merges.

The generic adopter contract remains controlled by its constitution and materialized
policy. No own-repository exception weakens adopter roles, gates or trust anchors.

## Independent scored admission

Deferred. No step of `pull-request-checks.yml` runs the scored soft gate today, so
nothing below gates a pull request. This section states the contract a re-introduced
`soft-gate` step must meet under ADR-MDL-0004; adding the step, and with it the read of
`vars.DEVAI_SOFT_GATE_TRUST_JSON`, needs the Owner's decision and a workflow-checker
change.

The signed payload and external tuple must bind the exact event candidate/tree/base,
reviewed immutable producer control and all source/lock/toolchain/roster/context/rubric/
threshold/configuration/inventory/help/reply/envelope identities. Every Article18 dimension
is an integer0..4 and must reach3 independently, with verdict=pass and complete valid observations for PASS. Verdict review/fail blocks admission even with high scores; unknown or invalid evidence is an evidence error. Source citations resolve actual frozen
bytes/lines/anchors. Missing observation is error; confidence and averages never substitute.

The complete bounded native stream proves positive completion, effective empty tool/MCP
controls and no inherited configuration/context, with distinct externally established
working/evaluator/custodian identities. Signature alone or a self-declaration is not proof.
Fetch is provider-free, fixed to public `aarusso-nyx/devai` commit/tree/blob endpoints, with
no redirects, token/secret fallback, git pack/history checkout, signing or automatic retry.
Hard candidate checks, signature/canonical/member/input/host verification and freshness
remain fail-closed. Exact selected evidence and public trust effects are separately
recorded and observed under standing Owner authority before admission; missing technical
custody/isolation/availability remains a gate, not an inferred successful outcome.
