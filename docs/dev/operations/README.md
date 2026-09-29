# Operations

- [Testing](testing.md)
- [Worktrees](worktree-runbook.md)
- [Locks](lock-runbook.md)
- [Incidents](incident-playbook.md)
- [Release discipline](release-discipline.md)
- [DEVAI 1.2.8 adopter-package contract](adopter-package-contract.md)
- [Remote preflight contract](remote-preflight-contract.md)
- [Workflows](workflows/README.md)
- [Release verification profiles](../../adopters/release-profiles.md)
- [Migrate from 1.3.3 to 1.4.3](migrate-1.3.3-to-1.4.3.md)
- [Migrate from 1.4.3 to 1.4.4](migrate-1.4.3-to-1.4.4.md)
- [Migrate from 1.4.4 to 1.4.5](migrate-1.4.4-to-1.4.5.md)
- [STYNX 1.1.1 evidence campaign retrospective](stynx-1.1.1-evidence-retrospective.md)

Expensive local evidence is run explicitly. Ordinary remote automation validates evidence.
Four workflows are admitted under `.github/workflows/`, each with a
[reference page](workflows/README.md): `pull-request-checks.yml` (the non-attesting merge
preflight), `release.yml`, `site-publish.yml`, and `devai-ledger-verify.yml`. A signed
`v*` tag push only validates the tag against the protected ledger; release artifacts are
built by an explicit rehearsal dispatch of `release.yml` and published by a separate
publication dispatch after the approval stops on
[release discipline](release-discipline.md#approval-stops-and-credential-matrix). No
other remote path builds or publishes them.
