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

Protected preflight runs `format:check:all` against the complete tracked candidate.
Its shallow Git view needs no historical base or `DEVAI_FORMAT_BASE` value; a clean
checkout cannot turn formatting into an empty check. Commit hooks still fix only
staged files. Vendored dependencies and checksum-controlled fixtures retain their
existing byte-verification contracts instead of being reformatted.

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

The same pinned verifier rebuilds the task policy from the candidate's `test-tasks.json` and
byte-compares it with the ledger, so the committed descriptor uses only the selector kinds the
pinned verifier's descriptor schema admits, declared as `descriptor.selector_kinds` in
`law/policy/trusted-local-rc-verifier-package.json` (ADR-CHK-0006). A new selector kind trails
the verifier by one release: the release that first ships a verifier admitting the kind is built
from a descriptor that does not use it, and the descriptor may adopt the kind only after that
release is pinned as the trusted verifier and the policy re-declares the set. The descriptor
check run by `devai:prepare` refuses a kind outside the declared set with
`TEST_TASK_SELECTOR_KIND_UNADMITTED`; a candidate that uses one cannot pass the exact-evidence
binding step of a rehearsal.

The protected Linux toolchain includes checksum-verified Python 3.13.5 and its explicitly
pinned Debian snapshot dependencies. Repository evidence-transport and adopter-migration
checks require Python; its executable identity and the complete image digest must be
revalidated before certification after any toolchain change.

For network-isolated package-staging checks, the repository-local dependency provisioner
accepts an explicit `npm_install_cache` control with external canonical `directory` and
`manifest` paths plus `manifest_sha256`. The manifest lists every cache file's `path`,
`size`, and `sha256`. The provisioner rejects links, population differences, changed bytes,
and candidate-owned inputs, then includes the verified cache in both dependency rebuilds.
The complete dependency archive identity binds these bytes. Missing package cache entries
must be diagnosed before certification; installed pnpm dependencies alone do not supply
npm's cache for the separate normalized package installation.

Staging copies the transported `node_modules/.devai-npm-cache` seed to a temporary writable
cache and installs offline. The seed remains unchanged. A cache miss fails without network
fallback. Ordinary staging without a seed uses its existing npm installation path, with
network retries disabled and a two-minute process limit. This does not remove the mandatory
package-staging test or grant candidate commands network access in protected execution.

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
Every required rehearsal step, including Linux adoption, must pass before a completion
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
`DEVAI_PROCESS_CONTROL_COMMIT`, a repository variable. Candidate files cannot select that
revision. The first job of every run prints the variable to the run summary before any
reviewer stop opens, so a stale control commit is visible to the reviewer who approves the
first environment; every protected job still checks out and binds that exact revision itself.
See [process simplification rollout](process-simplification-rollout.md) for staged setup.

The release build also runs `npm --prefix docs/site run security:check`. DEVAI temporarily vendors
the reviewed `image-size` JXL/HEIF and ICNS loop fixes because upstream has no patched npm release;
the provenance is recorded beside the vendored package. Replace the vendor with the first upstream
release containing both fixes, after the docs audit and build remain green.

The docs dependency audit has a single Owner-authorized non-regression baseline in
`docs/site/dependency-audit-waivers.json`. It is bound to the unchanged `v1.4.5` site lockfile,
lists every currently observed moderate or high advisory by exact advisory and package, expires on
2026-10-15, rejects critical advisories, and rejects any changed or additional advisory. A dependency
or lockfile change must remove the applicable waiver or obtain a new explicitly recorded decision.
On 2026-10-03 the Owner added two such decisions for v1.9.0: `braces` (GHSA-vfj7-8cjw-p6xm) and
`http-cache-semantics` (GHSA-ch52-4w7c-c8xp) have no patched release and reach only the Docusaurus
build tooling, so they carry the same expiry; the npm package itself carries no audit waiver (#233).

Repository settings are separate Owner-authorized effects: enable immutable Releases,
prohibit update/deletion of `v*` tags, require signed annotated release tags, configure the
release and Pages environments as the matrix below states, and select GitHub Actions as the
Pages source. None of those settings is changed by the source workflow itself.

## Approval stops and credential matrix

[ADR-REL-0030](../../../law/adr/ADR-REL-0030-release-approval-topology.md) makes this
page the reference for every job of `release.yml` and `site-publish.yml`: the environment
each job runs in, every secret and variable it reads, its permissions, and who stops
there. A job may read a credential only inside the environment the matrix binds it to;
`scripts/check-workflows.mjs` pins the rows below against
`law/policy/credential-requirements.json`, so adding a credential read to a job is a
governed change. In both matrices `GITHUB_TOKEN` is the job-scoped Actions token, spelled
`secrets.GITHUB_TOKEN` or `github.token`, bound to the job's declared `permissions` rather
than to an environment. The nine ledger secrets (`DEVAI_LEDGER_ENVELOPE_B64`,
`DEVAI_LEDGER_RESULTS_TGZ_B64`, `DEVAI_LEDGER_ARTIFACTS_TGZ_B64`,
`DEVAI_LEDGER_TASK_POLICY_B64`, `DEVAI_LEDGER_TRUST_STORE_B64`,
`DEVAI_LEDGER_TOOLCHAIN_B64`, `DEVAI_LEDGER_ENVIRONMENT_B64`, `DEVAI_RELEASE_SIGNERS_B64`,
`DEVAI_EVIDENCE_READ_TOKEN`) and the four ledger variables
(`DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256`, `DEVAI_LEDGER_POLICY_DIGEST`,
`DEVAI_LEDGER_TRANSPORT`, `DEVAI_LEDGER_BUNDLE_SHA256`) are read only inside
`devai-ledger-verification`. The two Pages audit variables
(`DEVAI_PAGES_MIGRATION_AUDIT_JSON`, `DEVAI_PAGES_MIGRATION_AUDIT_SHA256`) are read only
inside `github-pages`. `DEVAI_PROCESS_CONTROL_COMMIT` is a repository variable that any
job may read. "Every run" means a `v*` tag push, a rehearsal dispatch, and a publication
dispatch alike.

### Before: the topology ADR-REL-0030 replaces

This is `.github/workflows/release.yml` and `.github/workflows/site-publish.yml` as they
stand until the implementing round lands. A rehearsal stops three times, a publication
stops four times with `publish_pages: true` and three without it, and a site-only
publication stops once.

| Job                                 | Runs in                                | Environment                 | Secrets                                 | Variables                                                                                                | Permissions                                                               | Stop                                 |
| ----------------------------------- | -------------------------------------- | --------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `verify-ledger`                     | every run                              | `devai-ledger-verification` | the nine ledger secrets                 | the four ledger variables, `DEVAI_PROCESS_CONTROL_COMMIT`                                                | `contents: read`                                                          | rehearsal 1 of 3, publication 1 of 4 |
| `build-release`                     | rehearsal                              | `devai-rc-release`          | none                                    | none                                                                                                     | `contents: read`                                                          | rehearsal 2 of 3                     |
| `verify-linux-adopter`              | rehearsal                              | none                        | none                                    | none                                                                                                     | `contents: read`                                                          | none                                 |
| `rehearsal-summary`                 | rehearsal                              | `devai-rc-release`          | none                                    | `DEVAI_PROCESS_CONTROL_COMMIT`                                                                           | `contents: read`                                                          | rehearsal 3 of 3                     |
| `promote-assets`                    | publication                            | `devai-ledger-verification` | `GITHUB_TOKEN` (`github.token`)         | `DEVAI_PROCESS_CONTROL_COMMIT`                                                                           | `contents: read`, `actions: read`                                         | publication 2 of 4                   |
| `finalize-release`                  | publication                            | `devai-rc-publication`      | `GITHUB_TOKEN` (`secrets.GITHUB_TOKEN`) | `DEVAI_PROCESS_CONTROL_COMMIT`                                                                           | `contents: write`, `packages: write`                                      | publication 3 of 4                   |
| `deploy-pages`                      | publication with `publish_pages: true` | `github-pages`              | `GITHUB_TOKEN` (`github.token`)         | `DEVAI_PROCESS_CONTROL_COMMIT`, `DEVAI_PAGES_MIGRATION_AUDIT_JSON`, `DEVAI_PAGES_MIGRATION_AUDIT_SHA256` | `contents: read`, `pages: write`, `deployments: write`, `id-token: write` | publication 4 of 4                   |
| `publish-site` (`site-publish.yml`) | Owner dispatch from `main`             | `github-pages`              | `GITHUB_TOKEN` (`github.token`)         | none                                                                                                     | `contents: read`, `pages: write`, `deployments: write`, `id-token: write` | site-only 1 of 1                     |

Two of those stops reopen an environment that an earlier job of the same run already
opened: `rehearsal-summary` reopens `devai-rc-release` after `build-release`, and
`promote-assets` reopens `devai-ledger-verification` after `verify-ledger`. The two
`github-pages` stops protect no secret: the only credential either job holds is the
job-scoped token, and the site-only path is already guarded by the Owner dispatch, the
`main` guard, and the journal. The run summary shows `DEVAI_PROCESS_CONTROL_COMMIT` only
after a protected job has been approved.

### After: the topology the implementing round builds to

Jobs that share an environment are merged into one gated job, and the work that sat
between them moves into the merged job, so a rehearsal stops exactly twice and a
publication stops exactly twice whether or not `publish_pages` is set. `deploy-pages`
keeps its `github-pages` declaration for the deployment binding, the deployment branch
policy, and the audit variables, but the environment carries no reviewer, so the job runs
under the publication stop and never waits. No job other than the three gated ones
declares an environment.

| Job                                 | Runs in                                | Needs                               | Environment                 | Secrets                                                                           | Variables                                                                                                | Permissions                                                               | Stop                                 |
| ----------------------------------- | -------------------------------------- | ----------------------------------- | --------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `control-commit-summary`            | every run                              | none                                | none                        | none                                                                              | `DEVAI_PROCESS_CONTROL_COMMIT`                                                                           | `contents: read`                                                          | none                                 |
| `verify-ledger`                     | every run                              | `control-commit-summary`            | `devai-ledger-verification` | the nine ledger secrets; `GITHUB_TOKEN` (`github.token`) in the publication steps | the four ledger variables, `DEVAI_PROCESS_CONTROL_COMMIT`                                                | `contents: read`, `actions: read`                                         | rehearsal 1 of 2, publication 1 of 2 |
| `build-release`                     | rehearsal                              | `verify-ledger`                     | `devai-rc-release`          | none                                                                              | `DEVAI_PROCESS_CONTROL_COMMIT`                                                                           | `contents: read`                                                          | rehearsal 2 of 2                     |
| `finalize-release`                  | publication                            | `verify-ledger`                     | `devai-rc-publication`      | `GITHUB_TOKEN` (`secrets.GITHUB_TOKEN`)                                           | `DEVAI_PROCESS_CONTROL_COMMIT`                                                                           | `contents: write`, `packages: write`                                      | publication 2 of 2                   |
| `deploy-pages`                      | publication with `publish_pages: true` | `finalize-release`, `verify-ledger` | `github-pages`, no reviewer | `GITHUB_TOKEN` (`github.token`)                                                   | `DEVAI_PROCESS_CONTROL_COMMIT`, `DEVAI_PAGES_MIGRATION_AUDIT_JSON`, `DEVAI_PAGES_MIGRATION_AUDIT_SHA256` | `contents: read`, `pages: write`, `deployments: write`, `id-token: write` | none                                 |
| `prepare-site` (`site-publish.yml`) | Owner dispatch from `main`             | none                                | none                        | none (normal read-only checkout token)                                            | none                                                                                                     | `contents: read`                                                          | none                                 |
| `publish-site` (`site-publish.yml`) | Owner dispatch from `main`             | `prepare-site`                      | `github-pages`, no reviewer | `GITHUB_TOKEN` (`github.token`)                                                   | none                                                                                                     | `contents: read`, `pages: write`, `deployments: write`, `id-token: write` | none                                 |

The job set of `release.yml` is exactly `build-release`, `control-commit-summary`,
`deploy-pages`, `finalize-release`, and `verify-ledger`; `promote-assets`,
`rehearsal-summary`, and `verify-linux-adopter` no longer exist as jobs. The job set of
`site-publish.yml` is exactly `prepare-site` then `publish-site` under ADR-REL-0034. Job by job:

- `control-commit-summary` declares no `environment` and no `if`, has
  `permissions: contents: read`, and references no secret. Its only checkout is a
  sparse, credential-free one (`persist-credentials: false`) of
  `scripts/process/release-prerequisites.mjs` at the workflow commit. Its one run step
  reads `vars.DEVAI_PROCESS_CONTROL_COMMIT` into `CONTROL_COMMIT` and runs
  `release-prerequisites.mjs control-commit`, which fails unless the value matches
  `^[a-f0-9]{40}$` and appends the line `DEVAI_PROCESS_CONTROL_COMMIT=<sha>` to
  `$GITHUB_STEP_SUMMARY`. Because `verify-ledger`
  needs it, the summary shows the control commit before the first reviewer stop opens
  (ADR-REL-0030 IA-005). It does not replace the checkout and binding of the same
  variable that every gated job still performs.
- `verify-ledger` keeps its `environment: devai-ledger-verification`, its outputs, and
  its steps in their current order (check out the exact release commit, set up the
  verifier runtime, probe declared credential prerequisites, materialize the protected
  verifier package, check out and bind the approved process controls, materialize the
  protected ledger inputs, bind and verify exact release evidence), and gains
  `needs: control-commit-summary`, `permissions: contents: read` plus `actions: read`, and
  the two former `promote-assets` steps, each guarded by
  `if: ${{ github.event_name == 'workflow_dispatch' && inputs.publish }}`. The first,
  `Verify selected rehearsal`, reads `GH_TOKEN: ${{ github.token }}`, the
  `rehearsal_run_id` and `rehearsal_attempt` inputs, the commit, tree, and ledger JSON
  from `steps.bindings.outputs`, `github.workflow_sha`, and
  `vars.DEVAI_PROCESS_CONTROL_COMMIT`, and runs
  `release-control/scripts/process/rehearsal.mjs promote`. The second,
  `Retain verified promotion assets` with `id: retain`, uploads `release-assets/*` as
  `devai-release-assets-${{ github.run_attempt }}` with `if-no-files-found: error` and
  `retention-days: 30`. The job exposes
  `release_asset_id: ${{ steps.retain.outputs.artifact-id }}`, empty in a rehearsal. The
  probe step is unchanged: `GITHUB_TOKEN` is a `gh-auth` credential, so
  `release-prerequisites.mjs credentials` does not expect a presence flag for it. No
  build command may appear in this job.
- `build-release` keeps `environment: devai-rc-release`,
  `if: ${{ github.event_name == 'workflow_dispatch' && !inputs.publish }}`,
  `needs: verify-ledger`, `permissions: contents: read`, and its current steps through
  `Upload release candidate assets` (`id: upload`). After the upload it runs, in order,
  the former `verify-linux-adopter` steps, `Download exact release assets` from
  `devai-release-assets-${{ github.run_attempt }}` into `release-assets` and then the
  unchanged `Exercise fresh npm adoption, execution, and reuse` in `$RUNNER_TEMP`, and
  then the former `rehearsal-summary` steps: `Check out approved process controls` to
  `release-control` at `${{ vars.DEVAI_PROCESS_CONTROL_COMMIT }}` without persisted
  credentials, `Bind approved process controls`, `Record completed rehearsal` with the
  artifact id and digest from `steps.upload.outputs`, and `Retain rehearsal completion`
  as `devai-rehearsal-${{ github.run_attempt }}`. The completion record therefore still binds
  only after Linux adoption has passed, and its timeout covers all three former jobs.
- `finalize-release` keeps `environment: devai-rc-publication`, its publication guard,
  `permissions: contents: write` and `packages: write`, its `secrets.GITHUB_TOKEN` reads,
  and its steps; `needs` becomes `verify-ledger` and `Download exact release assets` reads
  `artifact-ids: ${{ needs.verify-ledger.outputs.release_asset_id }}` with
  `merge-multiple: true`.
- `deploy-pages` keeps `environment: { name: github-pages, url: ${{ steps.deployment.outputs.page_url }} }`,
  its `publish_pages` guard, its `devai-pages-publication` concurrency group, its
  permissions, its `github.token` and audit-variable reads, and its steps; `needs` becomes
  `finalize-release` then `verify-ledger`, and `Download canonical release assets` reads
  `artifact-ids: ${{ needs.verify-ledger.outputs.release_asset_id }}`.
- ADR-REL-0034 moves the existing checkout/build/security/type/local-byte/upload
  sequence to read-only `prepare-site`, with no environment and only `contents: read`.
  Its ref-scoped job lock may supersede preparation. `publish-site` requires success,
  checks the same source/run/artifact/population, validates the complete bounded archive
  before extraction, never rebuilds, and keeps the original `github-pages` environment,
  permissions and journal operation under the noncancellable shared publication job lock.
  The manual main/no-input guard and actual configured environment protection remain.

Unchanged across the restructure: the `v*` tag push trigger; the `workflow_dispatch`
inputs `release_tag`, `publish`, `publish_pages`, `candidate_commit`, `rehearsal_run_id`,
and `rehearsal_attempt`; the workflow-level `permissions: contents: read`; the
`devai-release-<tag>` concurrency group; the `env` block; and the tag verification in
`verify-ledger`, which on a tag push or a publication requires an annotated tag, verifies
its SSH signature against the allowed-signers file materialized from
`DEVAI_RELEASE_SIGNERS_B64`, and requires the tag to point at the exact candidate commit.
`publish: true` remains a separate, single-use Owner dispatch and the tag is still signed
by hand (ADR-GOV-0012, ADR-GOV-0013).

Stop counts after the restructure: a rehearsal waits at `devai-ledger-verification`
(`verify-ledger`) and `devai-rc-release` (`build-release`); a publication waits at
`devai-ledger-verification` (`verify-ledger`) and `devai-rc-publication`
(`finalize-release`), and `deploy-pages` runs under that second stop; a site-only
publication waits nowhere.

### Owner effects the target topology depends on

The workflows change none of these, and none of them has been performed at the time of
this writing. The campaign ledger records each one when the Owner performs it, before
the implementing round closes:

- OE-02: reconfigure the environments to the after matrix. `devai-ledger-verification`,
  `devai-rc-release`, and `devai-rc-publication` keep one required reviewer each;
  `github-pages` keeps its deployment branch policy, which must admit `main`, and its
  two audit variables, and loses its reviewer.
- OE-03: repoint `DEVAI_PROCESS_CONTROL_COMMIT` to an explicit reviewed sha before the
  next rehearsal, and again once the restructured process scripts land.
- OE-04: reissue the Pages migration audit, `DEVAI_PAGES_MIGRATION_AUDIT_JSON` and its
  SHA-256 in `DEVAI_PAGES_MIGRATION_AUDIT_SHA256`, for the next tag and control commit.

Until OE-02 is performed the live environments still stop as the before matrix shows.
The after matrix is the specification the workflows and the workflow checker are built
to, not a claim about the live repository.

## Export a release-intent certify receipt

[ADR-REL-0031](../../../law/adr/ADR-REL-0031-export-reconstructs-intent-policy.md) gives
`devai-evidence-export` a second reconstruction path beside the unchanged profile path.
Today the exporter derives the expected task policy only through `buildExpectedTaskPolicy`
with a descriptor profile id, so the certify receipt of a release-intent run cannot be
exported: that run selects its nodes by capability from the intent and the release
verification profile, builds the release form of the task policy (schema `1.2.0` with an
`inputProjection`), and still writes a candidate receipt whose `profile` field is the
literal `rc`. Rebuilding under descriptor profile `rc` yields a different digest, or
`PROFILE_UNKNOWN` when the descriptor declares no such profile, and the only workaround was a
second `--rc` execution that reproduced the closure under a profile (#69). This section is
the specification the inspector tests and the engineer's verifier change are built to.

### The two paths

A receipt is exported through exactly one of two paths, selected by the arguments the
caller supplies. `--profile <id>` selects the profile path, which keeps its current
behavior byte-for-byte: the id is resolved against the committed descriptor and the
expected policy is built as today, so no existing export changes its result. The intent
set, `--release-intent <path>`, `--release-profile <path>`, `--release-stage certify`, and
`--preflight-receipt <path>`, selects the intent path. Supplying `--profile` together with
any member of the intent set, or an incomplete intent set, is `USAGE`, before any input is
read. Both paths keep every existing trust-boundary check: the candidate repository must
be clean at the exact `--commit` and `--tree`, every external input must lie outside the
candidate, and the private key is read only for a signing export.

### What the intent path reconstructs

The intent path never reads the task set the receipt claims. It reconstructs the expected
release task policy from eight pinned inputs and compares the receipt to the reconstruction.
The release preflight receipt of the same run is the pin carrier: certification already
requires it, it is validated against `release-preflight-receipt.schema.json`, and it binds
`releaseIntentDigest`, `releaseProfileDigest`, `toolchainDigest`, `base`, and `repository`.

| Pin         | Source the exporter reads                                                         | Bound to                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| intent      | `--release-intent`, validated against `release-intent.schema.json`                | SHA-256 of its canonical JSON equals the preflight receipt's `releaseIntentDigest`                                                  |
| policy      | `--release-profile`, validated against `release-verification-profile.schema.json` | SHA-256 of its canonical JSON equals the preflight receipt's `releaseProfileDigest`; `release_unit` equals the intent's             |
| descriptor  | `test-tasks.json` read from the candidate commit's tree, never the working tree   | its digest enters every task key, as on the profile path                                                                            |
| toolchain   | `--toolchain`, a string map outside the candidate                                 | its digest equals the preflight receipt's `toolchainDigest`; every key a selected task names must be present                        |
| environment | `--environment`, an allowlisted map outside the candidate                         | every key a selected task allowlists must be present and, under policy `1.1.0` or later, be a SHA-256 identity or `null`            |
| base        | `--base` and `intent.base`                                                        | the same commit, resolving exactly to `intent.base.tree`, an ancestor of the candidate, and equal to the preflight receipt's `base` |
| candidate   | `--commit`, `--tree`, and `intent.candidate`                                      | the same commit and tree, equal to the preflight receipt's `repository`, with the repository id of the descriptor                   |
| stage       | `--release-stage`                                                                 | `certify`; the policy is reconstructed for the certify stage and the preflight reconstruction is used only to name a stage mismatch |

From those pins the exporter recomputes what the release run computed, in this order:
the release verification decision from the intent and the policy (version transition,
support, change kind, channel, risks, owner escalations, mutation requirement); the task
roots from `capability_tasks` for every capability the decision selects; the mutation
roster selection from `mutation_roster`, the intent's `changed_packages`, `changed_paths`,
and `risks`; the affected-selection closure over the base-to-candidate change set when
the decision includes `affected-checks`; the dependency closure of the selected roots in
descriptor order; each task key from the descriptor digest, the task's argv, cwd, runner,
selected toolchain, selected environment, resolved output contract, and the content
digests of its selected inputs at the candidate tree; and the `inputProjection` digest over
the candidate snapshot. The result is the release task policy, schema `1.2.0`, and its
digest. A decision whose verdict is not `ready` is refused before any reconstruction,
because the run could not have produced a receipt from it.

The reconstruction is complete when it holds every field the run's own policy holds, so
the certify receipt's `taskPolicyDigest` must equal the reconstructed digest exactly and
the receipt's `tasks` must name exactly the reconstructed required nodes, each with its
reconstructed task key. Equality of digests is the proof; the exporter never patches a
reconstruction toward the receipt. A certify receipt exported this way needs no second
`--rc` execution: the signed portable closure is built from the run that produced it.

### The rejection set

Rejection is exact and coded. Every refusal is emitted as the exporter's existing
`{ ok: false, code, message }` line on stderr with a non-zero exit, and no bundle, staging
directory, or output directory is created on refusal. The codes below are new to the
verifier; the existing codes keep their meaning.

| Code                           | Refused when                                                                                                                                                                     | Record item |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `INTENT_DIGEST_MISMATCH`       | the canonical digest of the supplied intent differs from the preflight receipt's `releaseIntentDigest`, so one altered intent field after the run is refused rather than trusted | IA-002      |
| `INTENT_STAGE_MISMATCH`        | `--release-stage` is not `certify`, the receipt is a preflight receipt rather than a candidate receipt, or the receipt's policy digest equals the preflight-stage reconstruction | IA-003      |
| `INTENT_POLICY_STALE`          | the canonical digest of the supplied release profile differs from the preflight receipt's `releaseProfileDigest`, or its `release_unit` differs from the intent's                | IA-003      |
| `INTENT_BASE_MISMATCH`         | `--base`, `intent.base`, and the preflight receipt's `base` are not one commit and tree, the base tree does not resolve, or the base is not an ancestor of the candidate         | IA-004      |
| `INTENT_CANDIDATE_MISMATCH`    | `--commit`, `--tree`, `intent.candidate`, and the preflight receipt's `repository` are not one commit and tree, or the repository id differs from the descriptor's               | IA-004      |
| `INTENT_POPULATION_INCOMPLETE` | the receipt's `tasks` are not exactly the reconstructed required nodes: a strict subset, a superset, or a node whose task key differs from its reconstruction                    | IA-004      |
| `INTENT_DECISION_BLOCKED`      | the release verification decision reconstructed from the intent and the policy is not `ready`; the message carries the decision's blocking reasons                               | IA-002      |
| `PROFILE_ID_INVALID`           | the `--profile` value is not a well-formed profile id because it contains a path separator or names a readable file; it is raised before the descriptor is consulted             | IA-005      |

`PROFILE_UNKNOWN` is reserved for a well-formed id that the committed descriptor does not
declare, so a usage error is never reported as a policy error (IA-005). `POLICY_DIGEST_MISMATCH`
keeps its meaning on both paths: a receipt whose digest equals neither stage reconstruction
is refused with it, and a receipt built against a stale policy that still passes the pin
checks above is caught here. Every rejection is reproducible by a fixture that alters one
input of a passing export, and the fixtures live in the vendored test directory beside the
source they exercise.

### The verifier-source boundary and the order of a repin

The vendored verifier under `packages/cli/vendor/evidence-verification` is a copy of the
canonical `devai-verifier` source at the commit `provenance.json` names as `sourceCommit`,
and that manifest records the SHA-256 of every vendored file. The trusted local-RC verifier
that the protected ledger and release lanes run is a different, older thing: the verifier
inside the published release `law/policy/trusted-local-rc-verifier-package.json` pins by
package identity, materialized from that release's `release_source.commit`. A change to the
exporter therefore moves through four ordered steps, and no step is skipped or reordered:

1. The change lands in the canonical verifier source with its tests, and that source commit
   is the only thing the vendored copy may be made from. The vendored copy is never edited
   by hand; a differing byte is a provenance violation that `release:closure` and the
   installed-tarball smoke report as `PUBLISHABLE_VERIFIER_DIGEST_INVALID` or a population
   fault, not a change to be accepted.
2. The copy is re-vendored: `schemas`, `src`, and `test` are copied byte-for-byte from the
   source commit, `provenance.json` is rewritten with the new `sourceCommit` and the SHA-256
   of every vendored file, and every in-repository restatement of the vendored copy's
   source commit and payload count moves in the same change (the publishable-closure check,
   the package assembly and tarball smoke scripts, the pull-request preflight lane, which
   materializes the in-repository copy, and the unit and contract tests that pin it). The
   doctor's vendored-copy check observes the result as a new pin, not as drift, because the
   manifest and the bytes move together.
3. The release that first ships the re-vendored verifier is rehearsed and published under
   the still-pinned trusted verifier. The law policy does not change in that release: its
   protected ledger is verified by the older verifier, whose `verify.js` path ADR-REL-0031
   does not touch, so the RC closure of that release is still verifiable.
4. Only after that release is published does a `law(release)` change repin
   `law/policy/trusted-local-rc-verifier-package.json` to it, under the policy's own `repin`
   rule: the `package` identity (version, tarball, SHA-1, SRI, release-source commit and
   tree), the `verifier` identity (`source_commit`, `provenance_sha256`, `payload_file_count`
   read from the published release's `provenance.json`), and `descriptor.selector_kinds`
   re-declared from the pinned schema (ADR-CHK-0006) move together in one commit, never one
   field at a time. The same change moves the restatements that the ledger and release lanes
   carry, through the ci-scaffold generator and the workflow checker, and the Owner
   re-declares the repository variable the policy names as `external_duplicate` to the new
   provenance digest as a separate recorded effect. Until step 4, the trusted verifier is
   the previous release's, which is the one-release lag ADR-CHK-0006 already imposes on
   descriptor selector kinds.

The export path is usable locally and in the preflight lane from step 2, because both run
the in-repository copy. It becomes part of the protected release verification only at
step 4.

## Publish the documentation site without a release

A change that touches only the documentation site, with no semantic or product
effect, may reach the live site without a version, tag, or rehearsal. The path was
introduced by
[ADR-REL-0029](../../../law/adr/ADR-REL-0029-site-only-pages-publication.md), which
[ADR-REL-0030](../../../law/adr/ADR-REL-0030-release-approval-topology.md) supersedes
as a whole record while restating every clause of it except the approval clause. The
clauses that stay in force are these:

- `site-publish.yml` is the fourth admitted workflow. It runs only on an explicit
  `workflow_dispatch` from `main`, has no inputs, and reads no repository secret or
  variable; its only credential is the job-scoped `GITHUB_TOKEN`, declared as a
  consumer in `law/policy/credential-requirements.json`.
- ADR-REL-0034 places exact checkout/ref/commit/tree binding, the existing
  `docs/site` lockfile/security/type/build/local-byte checks and exact Pages upload in
  read-only `prepare-site`. `publish-site` requires its success and immutable same-run
  artifact ID, validates complete archive custody before extraction and publication, and
  never rebuilds. Preparation supersedes only its own ref-scoped job; the publisher
  retains the noncancellable shared journal lock and all existing scoped permissions.
- Deployment goes through `scripts/process/publish-site.mjs`, which records a
  site-only identity in the single-writer Pages journal of
  `scripts/process/github-pages-journal.mjs` and shares the `devai-pages-publication`
  concurrency group with the release path, so a site-only publication and a release
  deploy never interleave.
- A site-only publication requires a verified release-mode deployment already in the
  journal, so the first publication of any site remains a release; any submitted but
  unverified publication of either mode blocks the other with
  `OTHER_PUBLICATION_UNRESOLVED` until it is resolved.
- The job retains its publication record for 30 days and verifies the live bytes after
  deployment. Scripts run from the dispatched `main` commit rather than from the approved
  control commit, which is acceptable because the path publishes only documentation
  bytes and can never publish packages, releases, or tags.
- The workflow checker keeps its pins on the trigger, permissions, concurrency group,
  job set, `main` guard, environment name, build sequence, and publication steps, and
  drops only the expectation that the environment carries a reviewer.

The approval clause is what changes. The `github-pages` environment keeps its
deployment binding, its deployment branch policy, which must admit `main`, and its
audit variables, but no reviewer, so the Owner dispatches with
`gh workflow run site-publish.yml --ref main` and the run deploys on that dispatch
alone; no environment approval follows. Until OE-02 is performed the live environment
still holds its reviewer and the run still waits there. Use a release instead whenever
the change alters product behavior, policy, schemas, or package contents.

## Recover an interrupted Pages publication

[ADR-REL-0032](../../../law/adr/ADR-REL-0032-pages-rerun-identity.md) fixes what a
re-run of an interrupted Pages publication does and what a human does when the re-run
cannot proceed (#165). Both publication modes, the release deploy of
`scripts/process/publish-pages.mjs` and the site-only publication of
`scripts/process/publish-site.mjs`, run the same `publishPages` control in
`scripts/process/pages-publication.mjs` against the same journal in
`scripts/process/github-pages-journal.mjs`, so the re-run table below is shared. The
two modes differ only in what their identity binds, which is why their recovery paths
are stated side by side here and must never be confused: the site-only identity is
the same across every attempt of one run, the release identity is bound to one
rehearsal attempt.

### What the journal records

The journal is the repository's deployments in the `devai-pages-publication`
environment with task `devai:pages-publication`. One deployment is one intent; its
payload carries the exact publication identity, the Pages artifact id, and the
provenance `runId` and `attempt` of the run that created it. Its statuses carry the
phase, and a record is in exactly one of three phases, which only move forward:

| Phase       | Journal state                                                                                               | Meaning                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `intent`    | the deployment exists and has no status; `pagesId` is `null`                                                | the run recorded that it would submit; whether the Pages submission happened is not recorded |
| `submitted` | one status with `state: in_progress` and description `devai-pages:submitted:<pagesId>`                      | the Pages deployment `<pagesId>` was created for this intent and is not yet verified live    |
| `verified`  | a later status with `state: success` and description `devai-pages:verified:<pagesId>`, the same `<pagesId>` | the live bytes were verified against the artifact; the record is closed                      |

A run resolves its record by identity equality: every key of the run's identity must
equal the payload's identity and the payload must carry no other key. A record whose
identity differs and whose phase is not `verified` belongs to another publication,
of either mode, and the run stops before any effect read with
`PAGES_JOURNAL_OTHER_PUBLICATION_UNRESOLVED`. The first status of an intent must be
`submitted` and only `verified` may follow it; any other status shape, including an
`inactive` status, fails every reader with `PAGES_JOURNAL_STATUS_INVALID` until it is
removed.

Every run also retains a local record beside the journal, `site-publication.jsonl`
in the artifact `devai-site-publication-<run attempt>` for a site-only run and
`pages-publication.jsonl` in `devai-pages-publication-<run attempt>` for a release
deploy, kept for 30 days. Its lines are appended in order: `start` with the identity
and artifact id, `request-intent`, `intent-created` with the `intentId`,
`pages-created` with the `intentId`, `pagesId`, and `artifactId`, the journal record
before each status write, and finally `complete` with the result or `incomplete` with
the `reason` and `reconciliationRequired: true`. When a run fails, the reason is the
exact error code and the job exits with
`SITE_PUBLICATION_INCOMPLETE_RECONCILE_RETAINED_IDENTIFIERS` (site-only) or
`PAGES_PUBLICATION_INCOMPLETE_RECONCILE_RETAINED_IDENTIFIERS` (release); the
identifiers a human needs are in the retained record, never in the log.

### What a re-run does

A re-run is "Re-run all jobs" or "Re-run failed jobs" on the same run from the Actions
page. It keeps `GITHUB_RUN_ID` and increments `GITHUB_RUN_ATTEMPT`. A run that computes
the same identity bytes as the interrupted attempt finds its own record and acts on the
record's phase and on the live bytes, in this order: read the journal, read the live
bytes, then decide. It never builds anything (`buildInvocations` is always `0`) and it
never submits a second Pages deployment against an existing record.

| Record found | Live bytes match the artifact | The re-run                                                                                                                                                                                                                                   | Outcome                                                   |
| ------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| none         | no                            | creates the intent, proves it durable with a read-after-write (`PAGES_PUBLICATION_INTENT_NOT_DURABLE` otherwise), submits the artifact, writes `submitted`, observes the Pages deployment, verifies the live bytes, writes `verified`        | `verified`                                                |
| `submitted`  | yes                           | observes the Pages deployment the record names (`GET /repos/aarusso-nyx/devai/pages/deployments/<pagesId>` until `succeed`, at most 60 reads five seconds apart) and writes `verified` once the live bytes match the artifact; no submission | `no-op`                                                   |
| `submitted`  | no                            | observes that same deployment, then verifies the live bytes and writes `verified`; no submission                                                                                                                                             | `verified`                                                |
| `verified`   | yes                           | nothing: no submission, no journal write, no API write of any kind                                                                                                                                                                           | `no-op`                                                   |
| `verified`   | no                            | stops; the bytes the record verified are no longer live and this run may not put them back                                                                                                                                                   | `PAGES_PUBLICATION_VERIFIED_EFFECT_MISSING`, nothing sent |
| `intent`     | either                        | stops and submits nothing: the intent says a submission was about to happen and nothing says whether it did, so a second submission could publish twice against one intent                                                                   | `PAGES_PUBLICATION_SUBMISSION_UNKNOWN`, nothing sent      |

Two more stops belong to the resume path. A named Pages deployment that reaches any
state other than `succeed` or a documented in-flight state, or that is still in flight
after the last read, stops the run with `PAGES_PUBLICATION_DEPLOYMENT_UNRESOLVED`; the
record stays `submitted` and the next re-run observes it again. Live bytes that never
match after a successful deployment stop the run with the verification error of
`scripts/process/verify-pages-bytes.mjs`, retained as `PAGES_PUBLICATION_UNVERIFIED`;
the record stays `submitted` as well.

A `verified` record whose bytes are no longer live is not recovered: a later
publication replaced the site, which is the normal state of an old run. Publish the
wanted bytes again through a new run instead of re-running the old one.

### The site-only identity

The site-only identity is exactly `repository`, `mode: site-only`, `tag`, `commit`,
`tree`, `siteSha256`, `sourceRun`, and `controlCommit`, where `sourceRun` is
`GITHUB_RUN_ID` and `tag` is `v` plus the package version the site documents. It
carries no attempt: `pages-publication.mjs` rejects a site-only identity that carries
`sourceAttempt`, `rehearsalRun`, `rehearsalAttempt`, or `manifestSha256` with
`PAGES_PUBLICATION_IDENTITY_INVALID`. The run attempt is kept only as provenance, in
the intent payload's `attempt` and in the `log_url` of every status, which names
`https://github.com/aarusso-nyx/devai/actions/runs/<sourceRun>/attempts/<attempt>`.

Every attempt of one dispatch therefore computes the same identity bytes, provided the
re-run builds the same site from the same commit: `siteSha256` is the digest of the
built members, so a rebuild whose bytes differ is a different identity, and the open
record of the first attempt blocks it with `PAGES_JOURNAL_OTHER_PUBLICATION_UNRESOLVED`
exactly as it blocks any other publication. An interrupted site-only publication is
recovered by re-running the same run from the Actions page, with no journal edit, and
the table above applies as written. Never recover by dispatching
`gh workflow run site-publish.yml --ref main` again while a record of the interrupted
run is open: a new dispatch is a new `sourceRun`, so a new identity, and the open
record refuses it with `PAGES_JOURNAL_OTHER_PUBLICATION_UNRESOLVED` until the
reconciliation below closes it. The one case a re-run cannot resolve on its own is an
`intent` whose submission is unknown, which needs the manual reconciliation below.

Site-only records written before ADR-REL-0032 carry a `sourceAttempt` key. They are
read as history and never rewritten: a `verified` one is skipped as another identity,
and an unverified one blocks every later publication with
`PAGES_JOURNAL_OTHER_PUBLICATION_UNRESOLVED` until the same manual reconciliation
closes it. A re-run of such a record's run computes the new identity and does not
resume it.

### The release identity

The release identity is exactly `repository`, `tag`, `commit`, `tree`,
`rehearsalRun`, `rehearsalAttempt`, `manifestSha256`, `siteSha256`, and
`controlCommit`. It keeps its attempt because the assets and the rehearsal bind per
attempt: `rehearsalRun` and `rehearsalAttempt` are the publication inputs
`rehearsal_run_id` and `rehearsal_attempt`, the retained assets are the artifact
`devai-release-assets-<rehearsal attempt>` of that rehearsal, the manifest digest and
the site digest come from those assets, and `controlCommit` is the
`DEVAI_PROCESS_CONTROL_COMMIT` the run bound. The publication run's own attempt is
not part of the identity; it is provenance, as for the site-only mode.

A re-run of the same publication run, with the same inputs and an unchanged control
commit, therefore computes the same identity, and `deploy-pages` follows the re-run
table as written: a `submitted` record is observed and verified, a `verified` record
with matching bytes is a no-op, an `intent` stops with
`PAGES_PUBLICATION_SUBMISSION_UNKNOWN`. What differs from the site-only path is what
the re-run costs and what a new identity means:

- "Re-run failed jobs" re-runs `deploy-pages` alone, reusing the outputs of the earlier
  `verify-ledger` and `finalize-release`, and waits at no reviewer, because
  `github-pages` has none. "Re-run all jobs" re-enters the `devai-ledger-verification`
  and `devai-rc-publication` stops; the Release and registry steps of
  `finalize-release` are then a no-op on byte-identical assets and a hard refusal on
  any mismatch, as stated under "Publish a public release".
- The re-run downloads the same rehearsal assets and uploads a fresh Pages artifact
  `github-pages-<run attempt>`; the record's own `artifactId` is what was submitted,
  and the fresh artifact is never submitted against an existing record.
- A publication dispatched against another rehearsal attempt, or after
  `DEVAI_PROCESS_CONTROL_COMMIT` was repointed (OE-03), is a new identity. An open
  record of the earlier identity refuses it with
  `PAGES_JOURNAL_OTHER_PUBLICATION_UNRESOLVED` until that record is verified by a
  re-run of its own run or closed by the reconciliation below. A repointed control
  commit also needs the Pages migration audit reissued for it (OE-04), or the deploy
  stops with `PAGES_JOURNAL_MIGRATION_AUDIT_INVALID` before it reads the journal.

The operator recovers a release deploy, in this order: re-run the same publication run
while a `submitted` record is open; reconcile by hand when the record is an `intent`;
dispatch a new publication only when no record of the earlier identity is open, and
then only against the rehearsal attempt whose assets that publication names.

### Reconcile an intent with unknown submission

This is the one recovery the workflow cannot perform, in either mode, because it needs
an observation the run cannot make and the journal is single-writer for the workflows.
It is a human Owner effect, performed with the Owner's own `gh` session, and the two
status writes below are the only writes a human ever makes to the journal. Reads use
the two governed `gh api` GET shapes that ADR-AUT-0002 admits for the harness sensors;
the writes are outside the broker and never become sensor shapes.

1. Read the retained record of the failed attempt: download
   `devai-site-publication-<attempt>` or `devai-pages-publication-<attempt>` from the
   run and read its `intent-created` line for the `intentId`, its `pages-created` line
   for the `pagesId` when the response arrived but the status write did not, and its
   `start` line for the identity and the `commit`.
2. Read the journal through the governed GET and confirm the intent is still an
   `intent`:

   ```bash
   gh api '/repos/aarusso-nyx/devai/deployments?environment=devai-pages-publication&per_page=100'
   gh api '/repos/aarusso-nyx/devai/deployments/<intentId>/statuses?per_page=100'
   ```

   The first listing shows the intent with the identity of step 1 in its payload; the
   second is empty. A non-empty second listing means the record is already
   `submitted` or `verified`, and a re-run of its run resolves it without this
   procedure.

3. Observe whether a Pages deployment exists for the intent. With a `pagesId` from
   step 1, read it directly; without one, read it by the Git SHA the submission was
   built from, which the scripts set to the identity's `commit`:

   ```bash
   gh api /repos/aarusso-nyx/devai/pages/deployments/<pagesId>
   gh api /repos/aarusso-nyx/devai/pages/deployments/<commit>
   ```

   A `status` of `succeed`, or one of the in-flight states the scripts wait on
   (`queued`, `waiting`, `building`, `deployment_in_progress`, `syncing_files`,
   `finished_file_sync`, `updating_pages`, `purging_cdn`), is an observed deployment.
   With no `pagesId`, a not-found reply by SHA is confirmed absence only together
   with live bytes that are not the artifact's; compare them with
   `node scripts/process/verify-pages-bytes.mjs live <extracted artifact directory>`
   after downloading the run's `github-pages-<attempt>` artifact. A failed read alone
   is unknown, not absence; stop and read again later rather than guess.

4. Either record the observed deployment against the intent, as a `submitted` status
   with the id the observation used, so that the re-run observes and verifies it:

   ```bash
   gh api --method POST /repos/aarusso-nyx/devai/deployments/<intentId>/statuses \
     -f state=in_progress \
     -f environment=devai-pages-publication \
     -f description='devai-pages:submitted:<pagesId>' \
     -f log_url='https://github.com/aarusso-nyx/devai/actions/runs/<run id>/attempts/<attempt>' \
     -F auto_inactive=false
   ```

   Never write `verified` by hand: the journal accepts only `submitted` after
   `intent`, and `verified` is earned by the run's live-byte verification. Or close the
   intent as abandoned, when step 3 confirmed absence. The journal has no abandoned
   phase, so closure is the removal of the intent deployment, in two writes that must
   both complete because an `inactive` status left behind fails every reader with
   `PAGES_JOURNAL_STATUS_INVALID`:

   ```bash
   gh api --method POST /repos/aarusso-nyx/devai/deployments/<intentId>/statuses -f state=inactive
   gh api --method DELETE /repos/aarusso-nyx/devai/deployments/<intentId>
   ```

5. Read the journal again through the governed GET of step 2 and confirm the outcome:
   the intent now carries exactly one `in_progress` status
   `devai-pages:submitted:<pagesId>`, or it is absent from the listing. Only then act
   again: re-run the interrupted run to resume a recorded submission, or dispatch a
   new publication after a closed intent. Record the effect in the campaign ledger like
   any other Owner effect.

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

## Independent candidate soft-gate evidence

ADR-MDL-0004 adds the separate fully required four-dimension scored reply and external
trust/evidence selection. PASS requires verdict=pass, complete valid observations and every integer0..4 dimension independently reaching3 with
structured resolved source citations. Missing observations are errors, and generic
review/triage schemas and original hard thresholds remain unchanged. Review/fail blocks despite high scores, while unknown or invalid evidence is an evidence error. The producer runs
once under its exact Owner-initiated invocation envelope from a separately reviewed
immutable control checkpoint, retains actual completed no-tool/MCP/config/inventory
observations and signs only through independent custody. Signature alone is insufficient.

The PR lane reads only `vars.DEVAI_SOFT_GATE_TRUST_JSON` at the declared provider-free
`soft-gate` env seam, using fixed public GitHub commit/tree/blob reads without a token or
secret fallback. It admits only selected immutable externally authenticated candidate/
base/control/input/reply/host identities with <=24h freshness and no future times. A new
PR or merge-group candidate requires new separately invoked evaluation and external
selection; CI never initiates a provider, changes trust or fabricates evidence. Exact
evidence-ref/trust effects may precede PR admission from a reviewed control checkpoint,
with single-use effect records and observed receipts, preserving the two-PR discipline.
