# site-publish.yml

The site-only Pages publication lane retains ADR-REL-0029 and the approval topology
of ADR-REL-0030. ADR-REL-0034 changes only build placement and job concurrency:
read-only preparation may be superseded; publication remains serialized through
the original single-writer journal. This page declares the selected target contract;
implementation must pair the workflow and its checked documentation before final
admission. It reports no dispatched publication or environment change.

<!-- devai:workflow-metadata -->

```yaml
workflow: .github/workflows/site-publish.yml
triggers:
  - workflow_dispatch
jobs:
  - prepare-site
  - publish-site
```

## Triggers and path scope

| Event               | Inputs | Guard                                                                   |
| ------------------- | ------ | ----------------------------------------------------------------------- |
| `workflow_dispatch` | none   | exact `refs/heads/main` guard; no feature branch may prepare or publish |

There is no path filter or other trigger. The Owner dispatches
`gh workflow run site-publish.yml --ref main`. Preparation has a distinct exact
ref-scoped job concurrency group with `cancel-in-progress: true`. Publication has
job group `devai-pages-publication`, `cancel-in-progress: false`, shared with
`deploy-pages` of `release.yml`. Groups must differ case-insensitively. There is no
parent cancellation that can interrupt a publisher. Pending publisher replacement
is possible before an intent exists; every queued dispatch is not guaranteed to deploy.

## Jobs and their order

`prepare-site` precedes `publish-site` on `ubuntu-latest`, each bounded by the existing
20 minute timeout. Publication requires successful preparation and the exact same
dispatched commit/tree/run/artifact/population identities; failure, skip or cancellation
cannot enter publication through an `always()` or permissive condition.

## Environments and who stops there

| Job            | Environment                                                     | Stop                                                                                  |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `prepare-site` | none                                                            | none                                                                                  |
| `publish-site` | `github-pages`, `url: ${{ steps.deployment.outputs.page_url }}` | none by design under ADR-REL-0030; actual configured protection remains authoritative |

The workflow permission is `contents: read`. Preparation explicitly uses only that
read permission and no protected environment. Publication retains `contents: read`,
`pages: write`, `deployments: write`, `id-token: write`; no permission is widened.

## Secrets and variables each job reads

| Job            | Secrets                                            | Variables | Permissions                                                               |
| -------------- | -------------------------------------------------- | --------- | ------------------------------------------------------------------------- |
| `prepare-site` | none; normal checkout uses its read-only job token | none      | `contents: read`                                                          |
| `publish-site` | `github.token` (as `GH_TOKEN`)                     | none      | `contents: read`, `pages: write`, `deployments: write`, `id-token: write` |

Neither job reads a repository secret or variable. The exact consumers are declared
in `law/policy/credential-requirements.json`. Every checkout uses
`persist-credentials: false`. The scripts remain bound to the dispatched main commit;
this path publishes documentation bytes only.

## What each job runs

`prepare-site` runs:

1. Check out the exact dispatched main SHA without persisted credentials.
2. Set up Node through the existing composite action.
3. Bind exact ref/commit/tree/run identities.
4. Run `npm --prefix docs/site ci`, `security:check`, `typecheck`, `build`, and
   `scripts/process/verify-pages-bytes.mjs local docs/site/build` once.
5. Compute the existing population SHA-256 over UTF-8
   `JSON.stringify(siteMembers(directory))` over members only, with the existing
   empty `.nojekyll` exclusion. Emit and bind exact source/tree/run identities
   separately; do not incorporate them into `siteSha256`.
6. Upload the current Pages archive using the pinned upload action; emit immutable
   numeric artifact ID and source/population outputs. No journal/provider is invoked.

`publish-site` runs:

1. Check out the same dispatched SHA and verify successful preparation identities.
2. Obtain only that run's exact immutable artifact ID; reject name/latest/cross-run lookup.
3. Run `scripts/process/verify-site-preparation-artifact.mjs` to validate every bounded
   archive entry before extracting any byte. Refuse unsafe/absolute/traversing/duplicate/
   link/special/unknown members or excessive/incomplete archives. Only approved ordinary
   directories/files and explicitly recognized metadata are admitted. Verify the exact
   site member population after safe extraction; empty `.nojekyll` is excluded as in the
   current publisher, and every other dot member refuses.
4. Invoke the existing `scripts/process/publish-site.mjs` with exact `GH_TOKEN`,
   `PAGES_ARTIFACT_ID`, `SOURCE_TREE` and validated site directory. It never rebuilds.
   Its site-only identity is repository/mode/tag/commit/tree/siteSha256/sourceRun/
   controlCommit. The current attempt is observation metadata, not a new identity field.
5. Retain original intent/submitted/verified identifiers for 30 days and verify full
   live bytes using the original publisher operation. Unknown intents and missing
   verified release baseline or unresolved other-mode publications still refuse.

## Direct effects

Preparation creates only its exact run's build artifact and metadata. Publication
creates the existing GitHub Pages deployment and GitHub Deployment journal record,
retains its original identifiers and verifies actual live bytes. It never publishes a
package, release or tag, or repoints a protected process-control commit.

## Side effects

The complete publication journal and live bytes are read before an intent is created.
Preparation cancellation has no journal effect. Generic harness coherence checks
actual job effects, permissions, environments and resolved local/reusable calls;
unknown effects or lock aliases remain findings, with no filename/N/A exception.

## Recovery paths

- Missing verified release-mode baseline still requires the original release path first.
- A known submitted publication in this run resumes only its original Pages and
  artifact IDs. A publisher-only retry consumes retained preparation outputs. If all
  jobs rerun, a fresh artifact ID does not establish that its replacement was deployed;
  identical site population may verify the original identity, changed population refuses.
- Unknown intent refuses even if current live bytes match. A different run/commit or
  unresolved other-mode predecessor cannot be reconciled by this dispatch. Retain the
  original workflow/input identity and complete journal evidence for its resolution.
- Failed deployment, manual cancellation, timeout or runner loss cannot establish
  new verification; independently persisted verified evidence from before interruption
  remains valid. No fabricated verified record is created. The original durable-intent/read-after-write and journal
  refusals remain; no new cross-dispatch reconciliation protocol is introduced.

## Steps an adopter may reuse

- The `main` guard on a manual dispatch (`github.ref == 'refs/heads/main'` plus the
  in-step assertion on `GITHUB_REF` and `GITHUB_SHA`).
- Build-then-verify-bytes before upload, and verify-live-bytes after deploy.
- The journal pattern: a GitHub Deployment as the durable intent record, a `submitted`
  status before the irreversible call, a `verified` status after observing the effect.
- Not reusable as-is: the DEVAI site build commands, the `aarusso-nyx/devai` repository
  constant inside the journal script, and the live URL.
