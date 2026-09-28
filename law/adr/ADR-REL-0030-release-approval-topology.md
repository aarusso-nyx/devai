---
id: ADR-REL-0030
title: One approval stop per environment per run from a complete job and credential matrix
type: adr
status: proposed
date: 2026-09-28
authority: Architect
supersedes:
  - ADR-REL-0029
provenance:
  - ADR-REL-0029
  - ADR-GOV-0012
  - ADR-GOV-0013
  - ADR-SEC-0001
  - docs/dev/operations/harness-convergence-proposals.md
  - .github/workflows/release.yml
affected_rules:
  - .github/workflows/release.yml
  - .github/workflows/site-publish.yml
  - scripts/process/publish-site.mjs
  - scripts/process/pages-publication.mjs
  - scripts/process/github-pages-journal.mjs
  - scripts/check-workflows.mjs
  - law/policy/credential-requirements.json
  - docs/dev/operations/release-discipline.md
inspector_acceptance:
  - IA-001 -- Dispatch a rehearsal and confirm exactly two jobs wait on environments, devai-ledger-verification and devai-rc-release, and no other job declares an environment.
  - IA-002 -- Dispatch a publication and confirm exactly two jobs wait, devai-ledger-verification and devai-rc-publication, with deploy-pages running under the publication stop and never waiting on github-pages.
  - IA-003 -- Add a secret read to a job outside the environment that protects it and confirm the workflow checker fails against the manifest matrix before the workflow can run.
  - IA-004 -- Dispatch a site-only publication from main and confirm it deploys on the Owner dispatch alone while the journal, the concurrency group, and the main guard of the site-publish workflow still refuse a feature branch and an unresolved other-mode publication.
  - IA-005 -- Repoint DEVAI_PROCESS_CONTROL_COMMIT to a stale sha and confirm the run summary prints it before the first stop so the reviewer sees the stale value.
---

# Release approval topology

## Status

Proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Binds nothing until the Architect sets it to accepted
before the round that implements it opens. Supersedes ADR-REL-0029 as a
whole record while restating every clause of it except the approval clause,
which it replaces: the `github-pages` environment keeps its deployment
binding and its audit variables and loses its reviewer.

## Context

A rehearsal of `release.yml` stops three times for a human, at
`verify-ledger` (`devai-ledger-verification`), `build-release`
(`devai-rc-release`), and `rehearsal-summary` (`devai-rc-release` again), and
a publication stops four times, at `verify-ledger`, `promote-assets`
(`devai-ledger-verification` again), `finalize-release`
(`devai-rc-publication`), and `deploy-pages` (`github-pages`). Two of those
stops guard an environment that an earlier job in the same run already
opened with the same credential set, so the reviewer approves the same
authority twice. ADR-REL-0029 added `site-publish.yml`, whose single job also
waits on `github-pages`, so a documentation publication costs an Owner
dispatch and an approval of an environment that holds no secret. No page
lists every stop with the credential set it protects, and the run summary
does not show `DEVAI_PROCESS_CONTROL_COMMIT` until a protected job has
already been approved, so a stale control commit is discovered late. The
Owner effects of #162 items 2 and 3, repointing the control commit and
reissuing the Pages migration audit, are inputs this record depends on.

## Decision

The record starts from a complete matrix, kept in
`docs/dev/operations/release-discipline.md` and pinned by
`scripts/check-workflows.mjs` against `law/policy/credential-requirements.json`,
that lists every job of `release.yml` and `site-publish.yml`, the environment
it runs in, every secret and variable it reads, and who stops there. A job
may read a credential only inside the environment the matrix binds it to, and
the checker fails a workflow whose job reads outside its row.

Jobs that share an environment and a credential set are merged into one gated
job, so a rehearsal stops twice, at `devai-ledger-verification` and
`devai-rc-release`, and a publication stops twice, at
`devai-ledger-verification` and `devai-rc-publication`. The `github-pages`
environment keeps its deployment binding, its deployment branch policy, and
its audit variables (`DEVAI_PAGES_MIGRATION_AUDIT_JSON` and its SHA-256), but
no reviewer: `deploy-pages` runs under the publication stop, and a site-only
dispatch of `site-publish.yml` runs on the Owner's dispatch alone. The Owner
effects that reconfigure the environments, repoint
`DEVAI_PROCESS_CONTROL_COMMIT` to an explicit reviewed sha before the next
rehearsal, and reissue the Pages migration audit for the next tag (#162 items
2 and 3) are performed before the implementing round closes, and the run
summary prints `DEVAI_PROCESS_CONTROL_COMMIT` before the first stop so a stale
control commit is visible to the reviewer who opens it.

The exact, single-use Owner authorization of ADR-GOV-0012 and ADR-GOV-0013
is untouched: `publish: true` is still a separate dispatch and the tag is
still signed by hand. Every clause of ADR-REL-0029 other than its approval
clause stays in force under this record. `site-publish.yml` remains the
fourth admitted workflow, dispatched manually from `main` only, with its
single `publish-site` job checking out the dispatched commit without
persisted credentials, binding the source identity, building the site from
`docs/site` with its own lockfile, running the site security and type
checks, verifying the local bytes, and uploading the exact Pages artifact.
Deployment still goes through `scripts/process/publish-site.mjs`, which
records a site-only identity in the single-writer Pages journal of
`github-pages-journal.mjs` and shares the `devai-pages-publication`
concurrency group with the release path, so the two paths never interleave;
a site-only publication still requires a verified release-mode deployment in
the journal, and a submitted but unverified publication of either mode still
blocks the other. The workflow reads no repository secret or variable and its
only credential is the job-scoped `GITHUB_TOKEN`, declared as a consumer in
the credential manifest. The workflow checker keeps its pins on the trigger,
permissions, concurrency group, job set, main guard, environment name, build
sequence, and publication steps, and drops only the expectation that the
environment carries a reviewer.

## Consequences

A rehearsal costs two approvals and a publication two, each protecting one
credential set that no other job in the run reaches. A documentation change
reaches the live site after one Owner dispatch with no approval, which is
acceptable because the path publishes only documentation bytes from `main`
through the journal and can never publish packages, releases, or tags. The
release-discipline page becomes the reference for stops and credentials,
and the checker enforces that reference, so adding a credential read to a
job is a governed change. The environment reconfiguration is a separate
Owner effect and its performance is recorded in the campaign ledger.

## Alternatives Considered

Merging the rehearsal and publication runs, or publishing on a tag push, is
rejected because ADR-GOV-0012 and ADR-GOV-0013 constrain the present design
to a separate, exact, single-use dispatch. Keeping a reviewer on
`github-pages` for the site-only path is rejected by maintainer decision:
the environment holds no secret, the path is journal-guarded, and the
approval protected nothing the dispatch did not already authorize. Removing
the approval clause of ADR-REL-0029 in passing is rejected in favor of an
explicit supersession that restates the clauses that stay.

## Affected Rules

- `.github/workflows/release.yml` for the merged gated jobs and the summary
  line that prints the control commit before the first stop.
- `.github/workflows/site-publish.yml` for the environment declaration
  without a reviewer.
- `scripts/check-workflows.mjs` for the matrix pins and the environment rule.
- `law/policy/credential-requirements.json` for the per-job consumer rows.
- `scripts/process/publish-site.mjs`, `scripts/process/pages-publication.mjs`,
  and `scripts/process/github-pages-journal.mjs`, restated unchanged from
  ADR-REL-0029.
- `docs/dev/operations/release-discipline.md` for the stop and credential
  matrix.

## Inspector Adversarial Acceptance

Dispatch a rehearsal and count the waiting jobs: exactly
`devai-ledger-verification` and `devai-rc-release`. Dispatch a publication and
count exactly `devai-ledger-verification` and `devai-rc-publication`, with
`deploy-pages` under the publication stop. Add a secret read to a job outside
its matrix row and confirm the checker fails. Dispatch `site-publish.yml`
from `main` and confirm deployment without approval, then from a feature
branch and against an unresolved release identity and confirm the main guard
and `OTHER_PUBLICATION_UNRESOLVED` still refuse. Repoint the control commit
to a stale sha and confirm the summary shows it before the first stop.
