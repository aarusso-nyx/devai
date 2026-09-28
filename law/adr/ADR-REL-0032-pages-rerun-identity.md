---
id: ADR-REL-0032
title: A site-only Pages re-run resumes its own journal record and refuses an unknown submission
type: adr
status: proposed
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-REL-0029
  - ADR-GOV-0013
  - docs/dev/operations/harness-convergence-proposals.md
  - scripts/process/publish-site.mjs
  - tests/contract/site-publication-cli.test.ts
affected_rules:
  - scripts/process/publish-site.mjs
  - scripts/process/pages-publication.mjs
  - scripts/process/github-pages-journal.mjs
  - tests/contract/site-publication-cli.test.ts
  - tests/contract/pages-publication.test.ts
  - tests/contract/github-pages-journal.test.ts
  - docs/dev/operations/release-discipline.md
inspector_acceptance:
  - IA-001 -- Re-run a site-only dispatch whose first attempt left a submitted record and confirm the second attempt observes the deployment, records verified, and sends no second Pages submission.
  - IA-002 -- Re-run a site-only dispatch whose first attempt reached verified and confirm the second attempt compares bytes, changes nothing, and exits as a no-op when they match.
  - IA-003 -- Re-run a site-only dispatch whose first attempt lost the submission response and confirm the second attempt stops with SUBMISSION_UNKNOWN and submits nothing.
  - IA-004 -- Submit a site-only identity that still carries a sourceAttempt key and confirm it is rejected as an invalid identity.
  - IA-005 -- Re-run a release deploy with a new attempt and confirm the release identity still carries its attempt and follows its own documented recovery path unchanged.
---

# Pages re-run identity

## Status

Proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Binds nothing until the Architect sets it to accepted
before the round that implements it opens. Changes the site-only publication
identity and the re-run behavior of `publish-site.mjs`; the release identity
and the journal's fail-closed rule for an unknown submission are unchanged.

## Context

`scripts/process/publish-site.mjs` binds the site-only identity to
`sourceRun` from `GITHUB_RUN_ID` and `sourceAttempt` from
`GITHUB_RUN_ATTEMPT`, and `pages-publication.mjs` requires both keys. A re-run
of the same dispatch therefore carries a new identity, finds an unresolved
record under the old one, and the journal in `github-pages-journal.mjs`
refuses it with `OTHER_PUBLICATION_UNRESOLVED`, so the only way to recover a
site-only publication whose first attempt was interrupted is manual journal
surgery (#165). The pinned contract test in
`tests/contract/site-publication-cli.test.ts` states this as "a re-run
attempt is a new identity". An `intent` record whose submission is unknown,
because the POST response was lost or the returned id was not persisted,
fails closed with `SUBMISSION_UNKNOWN` by design, and the review confirmed
that this rule must stay. The release identity keys its artifacts and its
rehearsal by attempt and has its own recovery path.

## Decision

The site-only publication identity drops `sourceAttempt` and keeps
`sourceRun`, so every attempt of one dispatch computes the same identity
bytes and a re-run finds its own journal record. `pages-publication.mjs`
rejects a site-only identity that carries `sourceAttempt` or any rehearsal
key, and the run attempt is retained only in the provenance the job already
records beside the identity.

A re-run resumes a `submitted` record by observing the Pages deployment the
record names and recording `verified` once the live bytes match the
artifact, and it treats a `verified` record as a no-op when the bytes match,
exiting without a submission or a journal write. An `intent` record whose
submission is unknown stays fail-closed: the re-run stops with
`SUBMISSION_UNKNOWN`, which the CLI records as
`PAGES_PUBLICATION_SUBMISSION_UNKNOWN`, and submits nothing.
`docs/dev/operations/release-discipline.md` documents the manual
reconciliation for that case: read the repository deployments through the
governed `gh api` GET, either record the observed deployment against the
intent or close the intent as abandoned, and only then dispatch again.

The release identity keeps its attempt, because its assets and its rehearsal
are bound per attempt, and its recovery path is documented beside the
site-only one on the same page so the two are never confused. The pinned
contract test changes from "a new attempt fails on its own intent" to "a new
attempt resumes a submitted record and refuses an unknown submission", and
the journal and publication suites gain the verified no-op case.

## Consequences

An interrupted site-only publication is recovered by re-running the dispatch
from the Actions page, with no journal edit. The identity bytes of every
site-only record change, so the journal's site-only records written before
this record are read with their `sourceAttempt` key as historical and are
never rewritten. A lost submission still requires a human, which is the
price of never submitting twice. The release path is untouched and its
recovery stays a documented manual procedure.

## Alternatives Considered

Dropping the attempt from the release identity as well is rejected because
its assets and rehearsal are attempt-scoped and the change would widen the
record beyond the defect. Resubmitting on an unknown submission is rejected
because it could publish twice against one intent, which the journal exists
to prevent. Editing the journal from the workflow to reconcile an unknown
submission is rejected because the journal is single-writer and the
reconciliation needs an observation the workflow cannot make on its own.

## Affected Rules

- `scripts/process/publish-site.mjs` for the identity without the attempt
  and the resume behavior.
- `scripts/process/pages-publication.mjs` for the identity key set.
- `scripts/process/github-pages-journal.mjs` for the resume and no-op paths.
- `tests/contract/site-publication-cli.test.ts`,
  `tests/contract/pages-publication.test.ts`, and
  `tests/contract/github-pages-journal.test.ts` for the changed pin and the
  new cases.
- `docs/dev/operations/release-discipline.md` for the two recovery paths.

## Inspector Adversarial Acceptance

Interrupt a site-only publication after submission, re-run the dispatch, and
confirm the second attempt records `verified` with no second submission.
Re-run a dispatch that already reached `verified` and confirm a byte
comparison and a no-op exit. Lose the submission response, re-run, and
confirm `SUBMISSION_UNKNOWN` with nothing submitted. Submit an identity that
still carries `sourceAttempt` and confirm rejection. Re-run a release deploy
with a new attempt and confirm the release identity and its recovery path
are unchanged.
