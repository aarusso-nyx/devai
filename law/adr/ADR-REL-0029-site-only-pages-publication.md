---
id: ADR-REL-0029
title: Publish the documentation site from main without a release through the Pages journal
type: adr
status: accepted
date: 2026-09-27
authority: Architect
supersedes: []
provenance:
  - ADR-CHK-0002
  - ADR-SEC-0001
  - scripts/process/github-pages-journal.mjs
  - docs/dev/operations/release-discipline.md
affected_rules:
  - .github/workflows/site-publish.yml
  - scripts/process/publish-site.mjs
  - scripts/process/pages-publication.mjs
  - scripts/process/github-pages-journal.mjs
  - scripts/check-workflows.mjs
  - law/policy/credential-requirements.json
inspector_acceptance:
  - IA-001 -- A site publication dispatched from any ref other than main is refused by the job guard and the source-identity step, and a workflow whose guard names another ref fails the workflow checker.
  - IA-002 -- A site-only publication against a journal holding no verified release-mode deployment fails with PAGES_JOURNAL_SITE_BASELINE_MISSING before any Pages deployment request.
  - IA-003 -- A submitted but unverified publication of either mode blocks a publication of the other mode with OTHER_PUBLICATION_UNRESOLVED.
  - IA-004 -- A site-only identity with a non-string tag or with any rehearsal key is rejected as an invalid publication identity.
---

# Site-only Pages publication

## Status

Accepted on 2026-09-27 by maintainer decision. Adds a second, narrower path
to the existing Pages publication journal; the release deploy path, its
inputs, jobs, and guards are unchanged.

## Context

GitHub Pages publication exists only as the `deploy-pages` job of the
release workflow. That job deploys the site archive from promoted release
assets and requires a signed tag, a rehearsal run, the release manifest,
process scripts from the approved control commit, and an owner-installed
migration audit. A documentation change with no semantic or product effect,
such as publishing a newly recorded self-scorecard, therefore waits for the
next release. The workflow checker pins every release input, job, and
condition to exact strings, so a site-only branch cannot be added to the
release workflow without loosening those pins.

## Decision

A fourth admitted workflow, `site-publish.yml`, publishes the documentation
site on manual dispatch only, from `main` only. Its single job
`publish-site` checks out the dispatched commit without persisted
credentials, binds the source identity (ref, commit, and tree), builds the
site from `docs/site` with its own lockfile, runs the site security and
type checks, verifies the local bytes, and uploads the exact Pages artifact.
Deployment goes through `scripts/process/publish-site.mjs`, which records a
site-only identity in the same single-writer Pages journal the release path
uses and shares its concurrency group, so the two paths never interleave.
The workflow reads no repository secret or variable; its only credential is
the job-scoped `GITHUB_TOKEN`, declared as a consumer in the credential
manifest. A site-only publication requires a verified release-mode
deployment already in the journal, so the first publication of any site
remains a release. The workflow checker pins the trigger, permissions,
concurrency group, job set, main guard, environment, build sequence, and
publication steps of the new file.

## Consequences

Site-only changes reach the live site after one owner dispatch and one
approval of the `github-pages` environment, without a version, tag,
rehearsal, control-commit repoint, or audit reissue. The journal's history
now carries two identity modes; the highest verified identifier of either
mode is the published source for site-drift sensing. Scripts run from the
dispatched main commit rather than from the approved control commit, which
is acceptable because the path publishes only documentation bytes and can
never publish packages, releases, or tags.

## Alternatives Considered

A site-only input or job on the release workflow is rejected because it
would loosen the exact release pins, the rebuild prohibition in the deploy
job, and the ledger prerequisite every release job carries. Using the
upstream deploy action directly is rejected because it bypasses the journal
and the no-CI-publish governance rule. Publishing on every push to main is
rejected because each run would wait on the protected environment and
because publication must stay an explicit owner effect.

## Affected Rules

The new workflow file, the site publication script, the Pages identity
validation in `pages-publication.mjs`, the journal baseline rule in
`github-pages-journal.mjs`, the workflow checker's admitted set and site
workflow rules, and the credential manifest's `GITHUB_TOKEN` consumers.

## Inspector Adversarial Acceptance

Dispatch from a feature branch and confirm the job is skipped and the
identity step refuses a non-main ref; mutate the job guard to another ref
and confirm `SITE_WORKFLOW_MAIN_GUARD_MISSING`. Run a site-only publication
against an empty journal and confirm `PAGES_JOURNAL_SITE_BASELINE_MISSING`
with no Pages request sent. Leave a submitted release identity unverified
and confirm a site-only publication stops with
`OTHER_PUBLICATION_UNRESOLVED`, and the converse. Submit a site-only identity
with a numeric tag or a `rehearsalRun` key and confirm it is rejected as an
invalid identity.
