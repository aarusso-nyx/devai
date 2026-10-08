# update-pull-request-branches.yml

Keeps open pull requests current with `main` without merge commits. On every push to
`main`, it rebases each open, non-draft pull request against `main` that is behind it,
through the update-branch API with the rebase method and a GitHub App installation
token (ADR-CHK-0008). The rebased head starts its own gate run, which supersedes the
stale one. This page describes the file as it stands; the
[remote preflight contract](../remote-preflight-contract.md#update-path) states the
update path and the Owner effect that provisions it.

<!-- devai:workflow-metadata -->

```yaml
workflow: .github/workflows/update-pull-request-branches.yml
triggers:
  - push
jobs:
  - update-branches
```

## Triggers and path scope

| Event  | Filter             | Main tip     |
| ------ | ------------------ | ------------ |
| `push` | `branches: [main]` | `github.sha` |

There is no path filter. Every push to `main` triggers the workflow, because any new
tip can leave open pull requests behind.

The concurrency group is `<workflow name>-<ref>`, with `cancel-in-progress: true`. A
newer push to `main` cancels an update still in flight, and the newer run re-evaluates
every pull request. This is the superseding concurrency of the `repository-write`
effect class (ADR-CHK-0008). Each update passes the pull request's head sha as the
expected head, so a cancelled run never races the next one.

## Jobs and their order

One job, `update-branches`, named "Rebase pull requests behind main". It runs on
`ubuntu-latest` with a 10 minute timeout.

## Environments and who stops there

None. The job declares no `environment`, so nobody stops here, and the run starts on
the push alone.

The workflow-level `permissions` block is `contents: read`, and the job declares no
override. The job's only write credential is the App installation token it mints.

## Secrets and variables each job reads

| Job               | Secrets                                                                                                          | Variables | Token                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `update-branches` | `DEVAI_UPDATE_BRANCH_APP_ID`, `DEVAI_UPDATE_BRANCH_APP_PRIVATE_KEY` (presence probe, then the token action only) | none      | the App installation token, with Contents and Pull requests write; `GITHUB_TOKEN` is never read |

Both secrets are declared in `law/policy/credential-requirements.json` with absence
`degrade`. The Owner provisions them as OE-02 of CMP-0007.

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
3. **Rebase each open pull request behind main** (`id: rebase`, only when `present`),
   with `GH_TOKEN` set to the App token:
   1. It lists the open pull requests against `main`. Drafts and pull requests from
      forks are excluded.
   2. For each one, it compares the head with `github.sha`. A pull request that is not
      behind is reported up to date.
   3. Otherwise it calls `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` with
      `update_method=rebase` and the head sha as `expected_head_sha`.
   4. A refused update, from a conflict or a head that moved, is written as a warning
      and a step-summary line. The loop goes on with the next pull request.
   5. The step ends by printing how many pull requests it skipped.

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
- **Cancelled by a newer push.** Nothing to do. The newer run evaluates every pull
  request again.

## Steps an adopter may reuse

- The presence-only probe that turns absent credentials into a passing, explicit
  "not configured" run instead of a failure.
- Minting a scoped App installation token for any write whose result must start other
  workflows, which `GITHUB_TOKEN` cannot do.
- The rebase update with `expected_head_sha`, under superseding concurrency keyed by
  workflow and ref.
- Not reusable as-is: the App and its secrets belong to this repository. An adopter
  provisions its own App and declares the secrets in its credential binding.
