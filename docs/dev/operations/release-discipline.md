# Release discipline

The release surface evaluates and records evidence; it does not grant publication authority.
Human maintainers authorize package, tag, release, deployment, and rollback effects separately.

DEVAI 1.2.8 changes the fixed RC task-policy digest by promoting lint and typecheck
to required sibling gates alongside coverage. The protected-ledger attestation must
therefore be re-issued for the exact 1.2.8 candidate policy digest; an attestation
for an earlier digest cannot authorize the changed closure.

The [remote preflight lane](remote-preflight-contract.md) keeps the protected RC
ledger and publication boundary unchanged. DEVAI 1.4 adds release-profile task
nodes, so a 1.3.x task-policy attestation cannot certify a 1.4.0 candidate.

## Inspect

```bash
devai release status --repo-root . --format json
```

## Check a candidate

```bash
devai release check \
  --repo-root . \
  --scorecard ./record/proofs/scorecard.json \
  --artifact <immutable-artifact-ref> \
  --environment staging \
  --audit-chain-head <sha256> \
  --strict --as-role auditor --write --format json
```

The check consumes supplied evidence and records its verdict. It does not build, publish, or
deploy the artifact.

## Verify and inspect drift

After a separately authorized deployment, compare the artifact and observed runtime:

```bash
devai release verify --artifact <immutable-artifact-ref> \
  --artifact-chain-head <sha256> --audit-chain-head <sha256> \
  --environment staging --strict --as-role auditor --write --format json

devai release drift --artifact <immutable-artifact-ref> \
  --observation route-set=changed --environment staging \
  --strict --as-role auditor --write --format json
```

`release verify` may instead consume an API runtime charter; `release drift` may consume an API
or auth charter. The operator owns credentials, target selection, deployment, and rollback.
Treat missing, malformed, partial, or unknown evidence as a stop condition.

## Publish a public release

The parameterized `.github/workflows/release.yml` accepts a version tag only when it equals
`v` plus the public package manifest version. The tag must be annotated and its signature
must verify. The workflow uses the authentic immutable `pnpm/action-setup` v4.1.0 annotated
tag object (`7088…`, peeled commit `a748…`) and lets the root `packageManager` field select
the pnpm version.

The protected ledger is checked by the immutable verifier shipped in the exact public DEVAI
package, using protected trust inputs that candidate configuration cannot select. Do not call
that verification independent until signing and verifier custody are organizationally separate. The build job
installs frozen dependencies, builds the package and Docusaurus site, checks publishable
closure, and creates a normalized public manifest with development workspace dependencies
removed. Two clean packs must have identical bytes. The CycloneDX SBOM is generated from
that normalized manifest and is rejected if a private `@devai-nyx/*` package appears.

The pull-request gate uses exact-commit binding. GitHub-created main merge commits and the signed
release tag use explicit `exact-tree` binding, which accepts the PR receipt only when the checked
tree is byte-identical. Commit mismatch without tree equality remains a hard failure.

Release tags use SSH signatures. The public identity is supplied through the protected
`DEVAI_RELEASE_SIGNERS_B64` environment secret and materialized as an OpenSSH allowed-signers
file; candidate source does not choose its own tag signer. The verified signer-file digest is
bound into the Release manifest.

A failed rehearsal tag is never moved or deleted. Remediation advances the prerelease version and
creates a new signed annotated tag so every attempted candidate remains auditable.

The GitHub Release manifest and `SHA256SUMS` are the canonical release identity. Existing
Release assets must match byte-for-byte; recovery is a no-op on a match and a hard refusal on
any mismatch. Assets are never uploaded with `--clobber`. GitHub Packages is a convenience
mirror: the workflow publishes the exact canonical tarball and downloads the registry copy to
verify the same digest. Pages is deployed in GitHub Actions mode from the exact site archive
named by the canonical manifest.

Prerelease versions create a GitHub prerelease and use the `next` package dist-tag. A version
without a SemVer prerelease component creates a normal GitHub Release and uses `latest`. The
manifest records the derived release type, prerelease boolean, and dist-tag; recovery verifies
that the existing Release and registry tag match that identity.

A signed annotated version-tag push validates identity without rebuilding or publishing.
Rehearsal is an explicit dispatch with `publish: false`, an exact `candidate_commit`
on main, and an intended `release_tag` matching the package version. No tag need exist.
Every required rehearsal job, including Linux adoption, must pass before a completion
record binds the run/attempt, workflow commit, source identity and retained artifact digests.
Artifacts and completion records are retained for 30 days.

Only an explicit `workflow_dispatch` with `publish: true` may finalize
publication. Supply `release_tag`, `rehearsal_run_id` and `rehearsal_attempt` after
separate Owner authorization. Create the signed annotated tag only after rehearsal;
it must point to that exact candidate commit. Publication rechecks current protected
trust, policy, evidence and tag identity and promotes the exact retained bytes. It
never rebuilds, repacks or regenerates the site. Missing/expired artifacts or changed
verification identities require another rehearsal. Existing immutable assets are never
replaced. A failed remote read is unknown, not proof that a publication is absent.

Protected jobs load repository-local process helpers from the separately approved
`DEVAI_PROCESS_CONTROL_COMMIT`. Candidate files cannot select that revision.
See [process simplification rollout](process-simplification-rollout.md) for staged setup.

The release build also runs `npm --prefix docs/site run security:check`. DEVAI temporarily vendors
the reviewed `image-size` JXL/HEIF and ICNS loop fixes because upstream has no patched npm release;
the provenance is recorded beside the vendored package. Replace the vendor with the first upstream
release containing both fixes, after the docs audit and build remain green.

Repository settings are separate Owner-authorized effects: enable immutable Releases,
prohibit update/deletion of `v*` tags, require signed annotated release tags, protect the
release and Pages environments, and select GitHub Actions as the Pages source. None of those
settings is changed by the source workflow itself.

## Installed host publication controls

The 1.5 installed host runner exposes the existing `release evidence-publish` and
`release publish` actions only when the operator supplies their respective
`later_stages.evidence_publish` or `later_stages.publish` controls. Omission or
`'unavailable'` disables that stage. Each stage needs a provider and an authorization
callback. Evidence publication also needs an independent offline-receipt verifier;
package publication needs publication controls. These callbacks come from the installed
control process, never request JSON. Supplying a callback does not establish approval:
the lifecycle still validates its returned authorization, receipts, and current state.

A remote invocation must explicitly provide `as_role`, `write`, and `allow_publish`.
The runner forwards consent without supplying a default grant, binds the request to its
exact production candidate, and refuses diagnostic-lane publication. Evidence publication
binds its offline receipt; package publication binds its plan receipt. Missing controls,
missing consent, stale authorization, or incompatible evidence remain refusals. This host
interface does not change DEVAI's own rehearsal-and-promotion workflow described above.

## Mutation baseline and interrupted execution

The protected mutation program gives the complete unmutated baseline 15 minutes.
This is separate from the unchanged per-mutant `timeoutMS: 10000` and
`timeoutFactor: 2`. The CLI baseline includes offline package-staging checks and
per-test coverage; the five-minute Stryker default can expire while those tests
are still executing. A baseline timeout remains a failure and never permits
mutation execution to start.

An installed host may supply `observe_mutation_package` to retain each package
before the driver advances. The callback receives the candidate identity, package
name, exact program and input digests, task-policy digests, and defensive copies
of the normalized report and result. The driver awaits the callback; a refusal
prevents aggregate completion. Candidate requests cannot select this callback,
and diagnostic preflight does not invoke it.

Repository-local operators can write these observations through
`scripts/process/mutation-checkpoints.mjs` using a private directory outside the
candidate, finite byte bounds, exact bindings, and an independently approved
verification callback. The store retains rejected attempts and refuses to replace
an existing different record. Neither observing nor storing a report grants
execution custody, a reuse origin, or candidate readiness. Restarted execution
must independently establish those proofs; the installed driver still declares
its own results as executed and does not replay these checkpoints.
