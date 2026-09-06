# Remote preflight contract

Status: accepted for DEVAI's own repository. Adopter workflow authority is unchanged.

## Invariant

Remote CI does not execute the attested RC closure, and remote execution never
produces, substitutes for, or supplements a candidate receipt in the protected
ledger. A transient preflight receipt coordinates the current run; it is not uploaded.
An unsigned local cache record from an untrusted run is not signing authority.

One required `devai-release-gate` runs on pull requests. It validates verifier-package
materialization and executes the unconditional cheap floor plus affected selection on
Linux. It proves only execution outcomes and consistency on that runner. It does not
prove the local RC closure executed, and a signed local claim does not prove Linux
execution. These observations answer different questions.

## Own-repository workflow set

| File                      | Required purpose                                                   |
| ------------------------- | ------------------------------------------------------------------ |
| `pull-request-checks.yml` | Unprivileged merge preflight                                       |
| `devai-ledger-verify.yml` | Protected post-merge observation and explicit dispatch             |
| `release.yml`             | Candidate rehearsal, tag validation, authorized artifact promotion |

The PR lane has `contents: read`, no environment, secrets or protected variables,
pinned actions, exact head checkout without persisted credentials, Linux runners and
a bounded timeout. It never uploads evidence or executes the local-only RC closure.
Verifier materialization validates bytes; it never invokes signing or receipt verification.

Cancellation uses workflow identity and PR number, so a new head cancels the previous
head's work. Main and release runs are never cancelled by this mechanism.

Installation, verifier validation and runner bootstrap report their outcomes. The
final required step rejects failed, cancelled, skipped or missing prerequisites.
The task DAG aggregates independent failures and explicitly blocks dependents.
It owns formatting, lint, type integrity, schema/generated checks, static integrity,
package closure and selected tests. Both ordinary and version-changing PRs require
the floor. Compile-only bootstrap makes the typed runner executable; it does not
assemble a release package or claim a candidate build result.

## Authority and settings

Merge-ready is not release-ready. Main may contain work that passes cheap checks but
has not completed RC certification. Protected verification on main is observation;
it cannot retroactively prevent a merge. Complete RC evidence and rehearsal remain
mandatory before publication.

The policy's `required_check` is effective only when GitHub requires that actual check.
Changing branch protection is a separate Owner-authorized effect. Remove the sole-owner
approving-review quota while retaining agent role separation and strict up-to-date checks.

The generic adopter contract remains controlled by its constitution and materialized
policy. No own-repository exception weakens adopter roles, gates or trust anchors.
