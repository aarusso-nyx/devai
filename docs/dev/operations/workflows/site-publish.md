# site-publish.yml

The site-only Pages publication lane (ADR-REL-0029, approval clause superseded by
ADR-REL-0030). It publishes the documentation site from a `main` commit without a
version, a tag, or a rehearsal, through the same single-writer Pages journal the release
path uses. The clauses that bind it are on
[release discipline](../release-discipline.md#publish-the-documentation-site-without-a-release);
this page describes the file as it stands.

<!-- devai:workflow-metadata -->

```yaml
workflow: .github/workflows/site-publish.yml
triggers:
  - workflow_dispatch
jobs:
  - publish-site
```

## Triggers and path scope

| Event               | Inputs | Guard                                                                            |
| ------------------- | ------ | -------------------------------------------------------------------------------- |
| `workflow_dispatch` | none   | the job runs only when `github.ref` is `refs/heads/main`; any other ref skips it |

There is no path filter and no other trigger. The Owner dispatches with
`gh workflow run site-publish.yml --ref main`. The concurrency group is
`devai-pages-publication` with `cancel-in-progress: false`, shared with `deploy-pages`
of `release.yml`, so a site-only publication and a release deployment never interleave.

## Jobs and their order

One job, `publish-site` ("Publish the documentation site from main"), on
`ubuntu-latest` with a 20 minute timeout.

## Environments and who stops there

| Job            | Environment                                                     | Stop                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publish-site` | `github-pages`, `url: ${{ steps.deployment.outputs.page_url }}` | none by design: the environment keeps its deployment branch policy and carries no reviewer (ADR-REL-0030). Until Owner effect OE-02 removes the live reviewer, the run still waits there. |

The workflow-level `permissions` block is `contents: read`; the job overrides it with
`contents: read`, `pages: write`, `deployments: write`, `id-token: write`.

## Secrets and variables each job reads

| Job            | Secrets                        | Variables | Permissions                                                               |
| -------------- | ------------------------------ | --------- | ------------------------------------------------------------------------- |
| `publish-site` | `github.token` (as `GH_TOKEN`) | none      | `contents: read`, `pages: write`, `deployments: write`, `id-token: write` |

The job reads no repository secret or variable; `GITHUB_TOKEN` is declared as its
consumer in `law/policy/credential-requirements.json`. The checkout uses
`persist-credentials: false`. Scripts run from the dispatched `main` commit, not from
`DEVAI_PROCESS_CONTROL_COMMIT`, which is acceptable because this lane can publish only
documentation bytes.

## What each job runs

`publish-site` runs these steps in order:

1. **Check out the dispatched main commit**: `actions/checkout` at `github.sha`.
2. **Set up Node**: the composite action with its defaults (no pnpm, no cache).
3. **Bind source identity** (`id: source`): asserts `GITHUB_REF` is `refs/heads/main`
   and `HEAD` is `GITHUB_SHA`; outputs the tree sha.
4. **Build and verify the documentation site**: `npm --prefix docs/site ci`,
   `security:check`, `typecheck`, `build`, then
   `scripts/process/verify-pages-bytes.mjs local docs/site/build`.
5. **Upload exact Pages artifact** (`id: pages-artifact`): `actions/upload-pages-artifact`
   from `docs/site/build` as `github-pages-<attempt>`, retained 30 days.
6. **Reconcile and deploy exact Pages artifact** (`id: deployment`):
   `scripts/process/publish-site.mjs docs/site/build site-publication-record` with
   `GH_TOKEN`, `PAGES_ARTIFACT_ID`, and `SOURCE_TREE`. The script builds a site-only
   identity (repository, `mode: site-only`, the package version as tag, commit, tree,
   the site member digest, the run and attempt, and the commit as control commit),
   reads the journal, and creates the intent, submits the deployment, observes it, and
   verifies the live bytes, in that order.
7. **Retain site publication identifiers**: uploads `site-publication-record/*` as
   `devai-site-publication-<attempt>` for 30 days, `if: always()`, warning when empty.
8. **Verify live documentation**: polls `index.html` on the live site up to twelve
   times until its digest equals the built file, then
   `verify-pages-bytes.mjs live docs/site/build`.

## Direct effects

- One GitHub Pages deployment of the built site.
- One GitHub Deployment record (task `devai:pages-publication`, environment
  `devai-pages-publication`) with a `submitted` and then a `verified` status; this is the
  journal entry other publications read.
- The retained artifacts `github-pages-<attempt>` and `devai-site-publication-<attempt>`.

## Side effects

- Reads the complete deployment journal and the live site before writing anything.
- Never publishes a package, a Release, or a tag; never touches `release.yml`
  artifacts; never repoints `DEVAI_PROCESS_CONTROL_COMMIT`.

## Recovery paths

- **`SITE_BASELINE_MISSING`**: the journal holds no verified release-mode deployment.
  The first publication of any site is a release; run a publication with
  `publish_pages: true` through `release.yml` first.
- **`OTHER_PUBLICATION_UNRESOLVED`**: a deployment with a different identity is still
  `submitted` (a release deploy or an earlier site dispatch that did not finish).
  Resolve that publication first by re-running its own workflow with its own inputs;
  the re-run observes the exact Pages deployment and closes the record when the live
  bytes match. A site-only re-run cannot close a release record and a release re-run
  cannot close a site-only one, because the identity differs.
- **This publication left `submitted`** (the job failed after step 6 created the Pages
  deployment): re-dispatch from the same `main` commit. The identity is rebuilt from the
  same commit and tree, the script finds the single matching record, observes the
  deployment, and verifies the live bytes without a second deploy when they already
  match. A different `main` commit is a different identity and is blocked until the
  earlier one is resolved.
- **`DEPLOYMENT_UNRESOLVED`**: the Pages deployment did not succeed. Check the Pages
  deployments API for its state; when it is terminal and failed, the record stays
  `submitted` until an operator with the deployment-write permission resolves it in
  the same journal, after which a fresh dispatch creates a new intent. Report it; the
  script never overwrites a record.
- **Live verification failed after a successful deploy**: re-dispatch; the deploy is a
  no-op on matching bytes and only the verification runs again.

## Steps an adopter may reuse

- The `main` guard on a manual dispatch (`github.ref == 'refs/heads/main'` plus the
  in-step assertion on `GITHUB_REF` and `GITHUB_SHA`).
- Build-then-verify-bytes before upload, and verify-live-bytes after deploy.
- The journal pattern: a GitHub Deployment as the durable intent record, a `submitted`
  status before the irreversible call, a `verified` status after observing the effect.
- Not reusable as-is: the DEVAI site build commands, the `aarusso-nyx/devai` repository
  constant inside the journal script, and the live URL.
