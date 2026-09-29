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
| `publish-site` (`site-publish.yml`) | Owner dispatch from `main`             | none                                | `github-pages`, no reviewer | `GITHUB_TOKEN` (`github.token`)                                                   | none                                                                                                     | `contents: read`, `pages: write`, `deployments: write`, `id-token: write` | none                                 |

The job set of `release.yml` is exactly `build-release`, `control-commit-summary`,
`deploy-pages`, `finalize-release`, and `verify-ledger`; `promote-assets`,
`rehearsal-summary`, and `verify-linux-adopter` no longer exist as jobs. The job set of
`site-publish.yml` is exactly `publish-site`. Job by job:

- `control-commit-summary` declares no `environment` and no `if`, has
  `permissions: contents: read`, checks nothing out, and references no secret. Its one
  step reads `vars.DEVAI_PROCESS_CONTROL_COMMIT` into `CONTROL_COMMIT`, fails unless the
  value matches `^[a-f0-9]{40}$`, and appends the line
  `DEVAI_PROCESS_CONTROL_COMMIT=<sha>` to `$GITHUB_STEP_SUMMARY`. Because `verify-ledger`
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
- `publish-site` is unchanged in every pin: the `workflow_dispatch` trigger without
  inputs, `permissions: contents: read` at the workflow level, the
  `devai-pages-publication` concurrency group, the single job, the `main` guard, the
  `github-pages` environment name and URL, the build sequence, and the publication
  steps. The only change is outside the file: the environment carries no reviewer.

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
- Its single `publish-site` job checks out the dispatched commit without persisted
  credentials, binds the source ref, commit, and tree, builds the site from `docs/site`
  with its own lockfile (`npm --prefix docs/site ci`), runs the site `security:check`
  and `typecheck`, runs `build`, verifies the local bytes, and uploads the exact Pages
  artifact.
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
