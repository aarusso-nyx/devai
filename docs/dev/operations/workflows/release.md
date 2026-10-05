# release.yml

Rehearses or promotes a DEVAI release. One file serves three run modes: a signed tag
push that validates identity, a rehearsal dispatch that builds and exercises the exact
candidate without publishing, and a publication dispatch that promotes the retained
rehearsal bytes. The approval stops, the credential matrix, and the job-by-job pins are
on [release discipline](../release-discipline.md#approval-stops-and-credential-matrix);
this page describes the file as it stands and does not restate that matrix.

<!-- devai:workflow-metadata -->

```yaml
workflow: .github/workflows/release.yml
triggers:
  - push
  - workflow_dispatch
jobs:
  - control-commit-summary
  - verify-ledger
  - build-release
  - finalize-release
  - deploy-pages
```

## Triggers and path scope

| Event               | Scope                              | Run mode                                                                                                                                  |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `push`              | tags matching `v*`                 | Tag validation: `control-commit-summary` and `verify-ledger` only. Nothing is built or published.                                         |
| `workflow_dispatch` | inputs, `publish: false` (default) | Rehearsal: adds `build-release`. Requires `candidate_commit`.                                                                             |
| `workflow_dispatch` | inputs, `publish: true`            | Publication: adds `finalize-release`, and `deploy-pages` when `publish_pages: true`. Requires `rehearsal_run_id` and `rehearsal_attempt`. |

`workflow_dispatch` inputs, as the file declares them: `release_tag` (required string),
`publish` (boolean, default `false`), `publish_pages` (boolean, default `false`),
`candidate_commit` (string), `rehearsal_run_id` (string), `rehearsal_attempt` (string).
There is no path filter. The concurrency group is `devai-release-<release tag>` with
`cancel-in-progress: false`, so two runs for the same tag serialize and none is
cancelled.

Workflow-level `env`: `PACKAGE_NAME` (`@aarusso-nyx/devai`), `EXPECTED_ACTION_COUNT`
(`69`, pinned against `.devai/config/toolchain.json` by `scripts/check-workflows.mjs`),
`RELEASE_TAG` (the input under dispatch, `github.ref_name` under push), and
`CANDIDATE_REF` (the tag under push or publication, `candidate_commit` under rehearsal).

## Jobs and their order

| Order | Job                      | Display name                                      | Needs                               | Runs in                          | Timeout |
| ----- | ------------------------ | ------------------------------------------------- | ----------------------------------- | -------------------------------- | ------- |
| 1     | `control-commit-summary` | Summarize approved process control commit         | none                                | every run                        | 5 min   |
| 2     | `verify-ledger`          | Verify protected RC ledger                        | `control-commit-summary`            | every run                        | 15 min  |
| 3     | `build-release`          | Build normalized release artifacts                | `verify-ledger`                     | rehearsal                        | 40 min  |
| 4     | `finalize-release`       | Create canonical Release and mirror exact package | `verify-ledger`                     | publication                      | 10 min  |
| 5     | `deploy-pages`           | Deploy and verify GitHub Pages                    | `finalize-release`, `verify-ledger` | publication with `publish_pages` | 15 min  |

`build-release` and `finalize-release` are mutually exclusive by their `if` guards
(`inputs.publish` false or true under `workflow_dispatch`); a tag push runs neither.

## Environments and who stops there

| Job                      | Environment                 | Stop                                                                                       |
| ------------------------ | --------------------------- | ------------------------------------------------------------------------------------------ |
| `control-commit-summary` | none                        | none; prints `DEVAI_PROCESS_CONTROL_COMMIT` to the run summary before the first stop opens |
| `verify-ledger`          | `devai-ledger-verification` | first stop of a rehearsal and of a publication                                             |
| `build-release`          | `devai-rc-release`          | second stop of a rehearsal                                                                 |
| `finalize-release`       | `devai-rc-publication`      | second stop of a publication                                                               |
| `deploy-pages`           | `github-pages`              | none; the environment carries no reviewer and the job runs under the publication stop      |

Who approves each environment and which repository settings the topology depends on are
Owner effects listed on
[release discipline](../release-discipline.md#owner-effects-the-target-topology-depends-on).

## Secrets and variables each job reads

The workflow-level `permissions` block is `contents: read`; the job-level blocks below
override it.

| Job                      | Secrets                                                                                                                                                                                                                                                                                                                                 | Variables                                                                                                                                                                          | Permissions                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `control-commit-summary` | none                                                                                                                                                                                                                                                                                                                                    | `DEVAI_PROCESS_CONTROL_COMMIT`                                                                                                                                                     | `contents: read`                                                          |
| `verify-ledger`          | `DEVAI_LEDGER_ENVELOPE_B64`, `DEVAI_LEDGER_RESULTS_TGZ_B64`, `DEVAI_LEDGER_ARTIFACTS_TGZ_B64`, `DEVAI_LEDGER_TASK_POLICY_B64`, `DEVAI_LEDGER_TRUST_STORE_B64`, `DEVAI_LEDGER_TOOLCHAIN_B64`, `DEVAI_LEDGER_ENVIRONMENT_B64`, `DEVAI_RELEASE_SIGNERS_B64`, `DEVAI_EVIDENCE_READ_TOKEN`; `github.token` in the two publication-only steps | `DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256`, `DEVAI_PROCESS_CONTROL_COMMIT`, `DEVAI_LEDGER_TRANSPORT` (default `legacy`), `DEVAI_LEDGER_BUNDLE_SHA256`, `DEVAI_LEDGER_POLICY_DIGEST` | `contents: read`, `actions: read`                                         |
| `build-release`          | none                                                                                                                                                                                                                                                                                                                                    | `DEVAI_PROCESS_CONTROL_COMMIT`                                                                                                                                                     | `contents: read`                                                          |
| `finalize-release`       | `secrets.GITHUB_TOKEN` (as `GH_TOKEN` and `NODE_AUTH_TOKEN`)                                                                                                                                                                                                                                                                            | `DEVAI_PROCESS_CONTROL_COMMIT`                                                                                                                                                     | `contents: write`, `packages: write`                                      |
| `deploy-pages`           | `github.token` (as `GH_TOKEN`)                                                                                                                                                                                                                                                                                                          | `DEVAI_PROCESS_CONTROL_COMMIT`, `DEVAI_PAGES_MIGRATION_AUDIT_JSON`, `DEVAI_PAGES_MIGRATION_AUDIT_SHA256`                                                                           | `contents: read`, `pages: write`, `deployments: write`, `id-token: write` |

The ledger secrets are read twice in `verify-ledger`: first as presence flags only
(`!= ''`, ADR-SEC-0001) by the credential probe, then as values by the materialization
step. Every secret a job references is declared for that workflow and job in
`law/policy/credential-requirements.json`, and `scripts/check-workflows.mjs` pins the
two against each other. Every checkout uses `persist-credentials: false`.

## What each job runs

- `control-commit-summary`: a sparse, credential-free checkout of
  `scripts/process/release-prerequisites.mjs` at the workflow commit, then
  `release-prerequisites.mjs control-commit`, which refuses a control commit that is not
  a 40-hex sha and appends it to `$GITHUB_STEP_SUMMARY`.
- `verify-ledger`: checks out `CANDIDATE_REF` into `candidate/`; sets up the verifier
  runtime through the composite action; probes the credential presence flags; archives
  the verifier package from the trusted commit `75343991…` (tree `90f0f5b6…`) inside the
  candidate clone and checks its identity, `bin` entries, provenance, population, and
  digests against `DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256`; checks out and binds the
  process controls at `DEVAI_PROCESS_CONTROL_COMMIT` into `release-control/`;
  materializes the ledger inputs with
  `release-control/scripts/process/evidence_transport.py materialize`; then binds and
  verifies the evidence (`id: bindings`): the candidate must be an ancestor of
  `origin/main`, `RELEASE_TAG` must equal `v` plus the package version, an annotated tag
  is required and SSH-verified against the materialized allowed-signers file under push
  or publication while a rehearsal requires `candidate_commit` to equal the checked-out
  commit, the task policy is rebuilt with the verifier and compared byte-for-byte, and
  the envelope is verified with `--binding exact-tree`. The job exports the commit,
  tree, every input digest, the policy digest, the verifier version, and `ledger_json`.
  Under publication only, **Verify selected rehearsal** runs
  `release-control/scripts/process/rehearsal.mjs promote` against the named rehearsal
  run and attempt, and **Retain verified promotion assets** (`id: retain`) uploads
  `release-assets/*` as `devai-release-assets-<attempt>` for 30 days; its artifact id is
  the job output `release_asset_id`, empty in a rehearsal.
- `build-release`: checks out the verified commit; sets up pnpm and Node with the
  GitHub Packages registry; re-verifies the commit, tree, package name, tag, and release
  channel; `pnpm install --frozen-lockfile`; builds and checks the package and the site
  (`build`, `format:check`, `lint`, `typecheck`, `release:static-integrity`,
  `release:closure`, then `npm --prefix docs/site ci`, `security:check`, `typecheck`,
  `build`); stages the normalized package twice, smoke-installs the tarball, verifies the
  site bytes, archives the site, writes `release-manifest.json` and `SHA256SUMS`; uploads
  the assets as `devai-release-assets-<attempt>` (`id: upload`); downloads them back and
  exercises fresh npm adoption, `init bind`, `init apply`, `doctor`, and two
  `check --local --run` passes (executed, then reused) in a non-ASCII temporary path;
  checks out and binds the process controls; and records the rehearsal completion with
  `rehearsal.mjs complete`, retained as `devai-rehearsal-<attempt>`.
- `finalize-release`: checks out the tag; checks out and binds the process controls;
  sets up Node with the GitHub Packages registry; binds the release identity (version,
  channel, dist-tag, prerelease flag); downloads the promotion assets by
  `release_asset_id`; verifies `SHA256SUMS`; creates the GitHub Release with
  `--verify-tag` and `CHANGELOG.md` as notes, or reconciles an existing one through
  `publication-state.mjs release` and `release-recovery.mjs`; publishes the exact tarball
  to GitHub Packages or verifies the existing copy, reinstalls it, checks the binary
  version and the action count, packs it back and compares digests, and sets the
  dist-tag.
- `deploy-pages`: checks out and binds the Pages verification controls; sets up Node;
  downloads the promotion assets; extracts the site archive named by the manifest and
  verifies its bytes; uploads the Pages artifact `github-pages-<attempt>`; runs
  `release-control/scripts/process/publish-pages.mjs` (`id: deployment`), which records
  the intent in the Pages journal, deploys, and verifies; retains
  `pages-publication-record/*` as `devai-pages-publication-<attempt>` even on failure;
  and polls the live site up to twelve times for the released package identity before
  verifying the live bytes.

## Direct effects

| Run mode    | Effects                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tag push    | Run status only. The tag's signature and target are verified; nothing is built or published.                                                                                                                                          |
| Rehearsal   | Two retained artifacts for 30 days: `devai-release-assets-<attempt>` and `devai-rehearsal-<attempt>`. No publication.                                                                                                                 |
| Publication | The immutable GitHub Release with its assets, the GitHub Packages mirror and dist-tag, and, with `publish_pages`, one Pages deployment and its journal record. `devai-release-assets-<attempt>` is retained again by `verify-ledger`. |

## Side effects

- `$GITHUB_STEP_SUMMARY` carries the control commit (every run) and the rehearsal
  completion line.
- Registry smoke installs in `finalize-release` read GitHub Packages with the job token.
- `deploy-pages` writes a GitHub Deployment (task `devai:pages-publication`, environment
  `devai-pages-publication`) and its statuses; that deployment is the journal, and it
  persists whether or not the run finishes.
- No job moves, deletes, or recreates a tag; a failed rehearsal tag stays as evidence.

## Recovery paths

- **Missing credential**: `verify-ledger` fails in the probe step naming the missing
  secret or variable before any value is read. Set it in `devai-ledger-verification`
  and re-run the job.
- **Stale control commit**: the run summary shows `DEVAI_PROCESS_CONTROL_COMMIT` before
  the first stop. Reject the run at the stop, repoint the variable, and dispatch again;
  a rehearsal completed under a different control commit cannot be promoted.
- **Rehearsal failed after the ledger stop**: nothing was published. Dispatch a new
  rehearsal for the fixed candidate; do not reuse the run id.
- **Publication failed in `finalize-release`**: re-run the job. The release step is a
  no-op when the Release exists with byte-identical assets, uploads only the missing
  assets when the population is short, and refuses on any mismatch; the registry step
  publishes only when `publication-state.mjs registry` reports absence and otherwise
  verifies the existing copy. Missing or expired rehearsal artifacts or a changed
  verification identity require a new rehearsal and a new publication dispatch.
- **Publication failed in `deploy-pages`, journal record unresolved**: read
  `devai-pages-publication-<attempt>` for the retained record and the deployment's
  statuses. A record whose last status is `devai-pages:submitted:<pages id>` blocks
  every later publication of either mode with `OTHER_PUBLICATION_UNRESOLVED`. Re-run
  the job with the same inputs: `publish-pages.mjs` re-reads the journal, observes that
  exact Pages deployment, and, when the live bytes already match, closes the submitted
  record as `devai-pages:verified:<pages id>` without a second deploy. If the Pages
  deployment itself failed, the re-run creates no new intent and reports
  `DEPLOYMENT_UNRESOLVED`; resolve it by hand by confirming in the Pages deployments API
  that the build is not still running, then re-run once more. Never post a `verified`
  status by hand without observing the live bytes.
- **Live verification timed out**: the deployment succeeded but the site did not serve
  the expected identity within twelve attempts. Re-run the job; the deploy step is a
  no-op on matching bytes and the verification runs again.
- **Two dispatches for the same tag**: they serialize in `devai-release-<tag>`; the
  second sees the first's effects and reconciles or refuses.

## Steps an adopter may reuse

- The control-commit summary job: a credential-free first job that prints the process
  control revision before any protected stop opens.
- The presence-flag credential probe (`secrets.X != ''`) paired with a manifest of
  declared consumers.
- The retain-then-promote pattern: artifacts uploaded by the rehearsal, promoted by id
  from a later dispatch without rebuilding.
- The reconcile-before-write publication steps (state query, byte comparison, no-op on
  match, refusal on mismatch, no `--clobber`).
- Not reusable as-is: the trusted verifier commit and tree, the `EXPECTED_ACTION_COUNT`,
  the DEVAI package name and registry scope, and the `aarusso-nyx.github.io/devai/`
  live checks.
