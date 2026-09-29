# devai-ledger-verify.yml

Verifies the externally attested local RC ledger against one commit of this
repository, on explicit dispatch. It reads the same protected inputs as the
`verify-ledger` job of `release.yml`, without the release signer file, and produces no
artifact: a green run is an observation that the protected ledger binds that commit,
never a release claim. This page describes the file as it stands.

<!-- devai:workflow-metadata -->

```yaml
workflow: .github/workflows/devai-ledger-verify.yml
triggers:
  - workflow_dispatch
jobs:
  - verify-ledger
```

## Triggers and path scope

| Event               | Inputs | Candidate                                                   |
| ------------------- | ------ | ----------------------------------------------------------- |
| `workflow_dispatch` | none   | `github.sha` of the chosen ref, exported as `CANDIDATE_SHA` |

There is no path filter and no push trigger; the job's `if` (`github.event_name !=
'pull_request'`) and the `push` branch of its binding step are guards that no current
trigger reaches. The concurrency group is `devai-ledger-verify-<sha>` with
`cancel-in-progress: true`: a second dispatch on the same commit cancels the first, and
dispatches on different commits run side by side.

## Jobs and their order

One job, `verify-ledger` ("Verify externally attested local ledger"), on
`ubuntu-latest` with a 5 minute timeout.

## Environments and who stops there

| Job             | Environment                 | Stop                                                                      |
| --------------- | --------------------------- | ------------------------------------------------------------------------- |
| `verify-ledger` | `devai-ledger-verification` | the reviewer of that environment, once per run, before any secret is read |

The workflow-level `permissions` block is `contents: read` and the job declares no
override.

## Secrets and variables each job reads

| Job             | Secrets                                                                                                                                                                                                                                                  | Variables                                                                                                                                                                          | Permissions      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `verify-ledger` | `DEVAI_LEDGER_ENVELOPE_B64`, `DEVAI_LEDGER_RESULTS_TGZ_B64`, `DEVAI_LEDGER_ARTIFACTS_TGZ_B64`, `DEVAI_LEDGER_TASK_POLICY_B64`, `DEVAI_LEDGER_TRUST_STORE_B64`, `DEVAI_LEDGER_TOOLCHAIN_B64`, `DEVAI_LEDGER_ENVIRONMENT_B64`, `DEVAI_EVIDENCE_READ_TOKEN` | `DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256`, `DEVAI_PROCESS_CONTROL_COMMIT`, `DEVAI_LEDGER_TRANSPORT` (default `legacy`), `DEVAI_LEDGER_BUNDLE_SHA256`, `DEVAI_LEDGER_POLICY_DIGEST` | `contents: read` |

`DEVAI_RELEASE_SIGNERS_B64` is not read here: this lane verifies no tag. The secrets are
read first as presence flags (`!= ''`, ADR-SEC-0001) and then as values; the job-scoped
`GITHUB_TOKEN` is not read by any step, and the two checkouts use
`persist-credentials: false`.

## What each job runs

`verify-ledger` runs these steps in order:

1. **Check out exact candidate**: `actions/checkout` at `CANDIDATE_SHA` into
   `candidate/` with `fetch-depth: 0`.
2. **Set up verifier runtime**: `actions/setup-node` directly (not the composite
   action) with `node-version: 24`, pinned against `.devai/config/toolchain.json`.
3. **Probe declared credential prerequisites**:
   `candidate/scripts/process/release-prerequisites.mjs credentials .github/workflows/devai-ledger-verify.yml verify-ledger`
   over the eight presence flags.
4. **Materialize protected DEVAI verifier package** (`id: verifier-package`): archives
   `packages/cli/package.json` and `packages/cli/vendor/evidence-verification` from the
   trusted commit `8b600ed1…` (tree `d2f60e06…`) inside the candidate clone, checks the
   provenance digest against `DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256`, the package
   identity, the `bin` entries, the provenance `sourceCommit`, the file population, and
   every file digest; exports the three `DEVAI_EVIDENCE_*` entry points.
5. **Check out approved process controls** into `release-control/` at
   `DEVAI_PROCESS_CONTROL_COMMIT`, then **Bind approved process controls** (40-hex sha,
   `HEAD` equals it).
6. **Materialize externally controlled verification inputs**:
   `release-control/scripts/process/evidence_transport.py materialize` under
   `umask 077` into `$RUNNER_TEMP/devai-ledger-control`, from the secret values and the
   transport variables.
7. **Bind exact candidate identity** (`id: candidate`): `HEAD` of the candidate equals
   `CANDIDATE_SHA`; outputs its tree and the binding, `exact-commit` under dispatch.
8. **Reconstruct policy and verify ledger**: rebuilds the `rc` task policy for the
   candidate commit and tree with the verifier's policy builder, compares it
   byte-for-byte with the transported policy, then verifies the envelope, results,
   artifacts, trust store, and policy digest against `DEVAI_LEDGER_POLICY_DIGEST` with
   the bound commit, tree, and binding.

## Direct effects

- The run status. Nothing else: no artifact, no summary line, no output consumed by
  another workflow.

## Side effects

- None outside the runner. The materialized inputs live in `$RUNNER_TEMP` for the
  job's lifetime.

## Recovery paths

- **Missing credential**: step 3 fails naming the flag before any value is read. Set
  the secret or variable in `devai-ledger-verification` and dispatch again.
- **Verifier provenance mismatch**: `DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256` does not
  match the vendored `provenance.json` at the trusted commit. The variable is repointed
  only with the verifier (a governed change); do not edit the workflow constants to
  match.
- **Policy or envelope mismatch**: the transported ledger does not bind this commit.
  That is the finding; produce and transport a ledger for the commit under test rather
  than re-running.
- **Cancelled**: a newer dispatch on the same sha superseded this one; read the newer
  run.
- **Timeout** (5 minutes): the transport is larger than expected or the verifier hung;
  re-dispatch once, then report.

## Steps an adopter may reuse

- The presence-flag credential probe with a declared consumer list.
- The pattern of checking out the process controls at an approved commit and binding
  `HEAD` to it before running any script from that checkout.
- Verifying a ledger against an exact commit and tree rather than a branch name.
- Not reusable as-is: the trusted verifier commit and tree, the Python transport
  script, and DEVAI's `rc` profile and descriptor.
