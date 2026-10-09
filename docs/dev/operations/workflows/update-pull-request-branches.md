# update-pull-request-branches.yml

Keeps open pull requests current with `main` without merge commits, through the
update-branch API with the rebase method and a GitHub App installation token
(ADR-CHK-0008):

- On every push to `main`, it rebases each open, non-draft pull request against `main`
  that is behind it.
- When a pull request against `main` is opened, reopened, or marked ready for review, it
  rebases that pull request alone, if it is behind. Without this, a pull request opened
  from a branch already behind `main` would wait for the next push to `main`, and
  "Update branch" in the GitHub interface would make the user the committer, which the
  commit-range check refuses.
  The rebased head starts its own gate run, which supersedes the
  stale one. This page describes the file as it stands; the
  [remote preflight contract](../remote-preflight-contract.md#update-path) states the
  update path and the Owner effect that provisions it.

<!-- devai:workflow-metadata -->

```yaml
workflow: .github/workflows/update-pull-request-branches.yml
triggers:
  - push
  - pull_request_target
jobs:
  - update-branches
```

## Triggers and path scope

| Event                 | Filter                                                                   | Pull requests touched                                    |
| --------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `push`                | `branches: [main]`                                                       | every open, non-draft, same-repository one behind main   |
| `pull_request_target` | `types: [opened, reopened, ready_for_review]`, `branches: [main]` (base) | that pull request only, if same-repository and not draft |

There is no path filter, because the workflow reads no repository content.

`pull_request_target` runs the workflow as it stands on the base branch, so a pull request
cannot change the steps that hold the App credential. The workflow has no
`actions/checkout` step and never runs pull-request content. It reads the pull request
only through the GitHub API, and passes the pull request's number and head sha to the
script through environment variables, never by expanding them into the script text. A
pull request from a fork, or a draft, skips the job before any credential is read.

The concurrency group is
`<workflow name>-pr-<number>` on `pull_request_target` and `<workflow name>-<ref>` on
`push`, with `cancel-in-progress: true` on both:

- a newer push to `main` cancels a push run still in flight;
- a later event on the same pull request cancels that pull request's earlier run;
- a pull request run and a push run never share a group.

This is the superseding concurrency of the `repository-write` effect class, keyed by the
run's own subject on each event (ADR-CHK-0008). Each update passes the pull request's head
sha as the expected head, so a cancelled or overlapping run never races another.

## Jobs and their order

One job, `update-branches`, named "Rebase pull requests behind main", for both events. It
runs on `ubuntu-latest` with a 10 minute timeout. Its `if` runs it on every push, and on a
pull request event only when the pull request's head repository is this repository and the
pull request is not a draft.

## Environments and who stops there

None. The job declares no `environment`, so nobody stops here, and the run starts on
the event alone.

The workflow-level `permissions` block is `contents: read`, and the job declares no
override. The job's only write credential is the App installation token it mints.

## Secrets and variables each job reads

| Job               | Secrets                                                                                                          | Variables | Token                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `update-branches` | `DEVAI_UPDATE_BRANCH_APP_ID`, `DEVAI_UPDATE_BRANCH_APP_PRIVATE_KEY` (presence probe, then the token action only) | none      | the App installation token, with Contents and Pull requests write; `GITHUB_TOKEN` is never read |

Both secrets are declared in `law/policy/credential-requirements.json` with absence
`degrade`. The Owner provisions them as OE-02 of CMP-0007. They were provisioned on
2026-10-08: the App `devai-update-branch` (App ID 5243994) is private to
`aarusso-nyx`, installed on this repository only, with Contents and Pull requests write and
Metadata read, and no webhook.

## What each job runs

`update-branches` runs these steps in order:

1. **Probe the update-branch App credentials** (`id: credentials`):
   - It reads only whether each secret is non-empty, never a value.
   - When both are present, it sets `present=true`.
   - Otherwise it writes a notice and a step-summary line saying that no pull request
     was rebased, sets `present=false`, and the run passes. This is the degrade
     behaviour while OE-02 is not done.
2. **Mint the update-branch App token** (`id: app-token`, only when `present`):
   `actions/create-github-app-token` at v3.2.0, pinned by digest. It takes the App id
   and private key and requests `contents: write` and `pull-requests: write`.
3. **Rebase pull requests behind main** (`id: rebase`, only when `present`), with
   `GH_TOKEN` set to the App token:
   1. On `push`, it lists the open pull requests against `main`, excluding drafts and
      pull requests from forks. On `pull_request_target`, the list is the event's pull
      request alone, already known to be same-repository and not a draft.
   2. For each one, it compares the head with `github.sha`. A pull request that is not
      behind is reported up to date.
   3. Otherwise it calls `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` with
      `update_method=rebase` and the head sha as `expected_head_sha`.
   4. A refused update, from a conflict or a head that moved, is written as a warning
      and a step-summary line. The loop goes on with the next pull request.
   5. The step ends by printing how many pull requests it skipped. A refused update
      never fails the run.

## Direct effects

- Each rebased pull-request branch gets new commits, replayed onto the tip of `main`.
  Authors are unchanged, and the committer becomes the App identity (ADR-CHK-0008
  admits this committer).
- Each rebased head arrives as a `synchronize` event and starts the
  [pull-request gate](./pull-request-checks.md). The gate's concurrency group cancels
  the superseded run, which ends cancelled, not failed.

## Side effects

- Notices, warnings, and step-summary lines on the run.
- No artifact, cache entry, tag, release, package, deployment, or write to `main`.

## Recovery paths

- **"Not configured" notice.** OE-02 is not done: the secrets are absent or empty.
  Nothing is wrong with the pull requests. Provision the App and its secrets as the
  remote preflight contract states.
- **A pull request was not rebased.** The warning names it and the API's reason. A
  conflict is resolved by the pull request's author, with a local rebase and a new
  push. A head that moved is picked up by the next push to `main`.
- **Token minting fails.** The App id or key is wrong, or the App is not installed on
  the repository. Fix the App or its secrets; re-running the job only repeats the
  failure.
- **A rebased head shows a red gate.** It is a real result on the new base, and it is
  handled like any gate failure. Re-running this workflow does not change it.
- **Cancelled by a newer event.** Nothing to do. A newer push evaluates every pull
  request again, and a later event on the same pull request evaluates it again.
- **A pull request opened behind `main` was not rebased.** Check that it comes from this
  repository and is not a draft; a fork is never updated. Marking a draft ready for review
  triggers the update.

## Steps an adopter may reuse

- The presence-only probe that turns absent credentials into a passing, explicit
  "not configured" run instead of a failure.
- Minting a scoped App installation token for any write whose result must start other
  workflows, which `GITHUB_TOKEN` cannot do.
- The rebase update with `expected_head_sha`, under superseding concurrency keyed by
  workflow and by the run's subject: the ref on push, the pull request number on
  `pull_request_target`.
- The `pull_request_target` shape that writes with a credential without running
  untrusted code: workflow from the base branch, no checkout, API reads only, forks
  skipped by the job's `if`.
- Not reusable as-is: the App and its secrets belong to this repository. An adopter
  provisions its own App and declares the secrets in its credential binding.
