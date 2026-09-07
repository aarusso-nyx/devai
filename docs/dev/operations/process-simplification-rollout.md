# Process simplification rollout

This is DEVAI's own repository process. It preserves the public CLI, constitution,
adopter workflows and role boundaries. Source implementation does not create a private
repository, install credentials, change GitHub settings, push, merge, tag or publish.

## Entry and order

Use a dedicated worktree. Do not resolve the root checkout's unrelated cherry-pick or
import existing 1.5 worktrees. Run focused tests and affected static checks first.
Demonstrate the required PR result before changing branch protection. A final clean
candidate needs one explicit RC gate and a successful non-publishing rehearsal before
any product publication decision. No version bump is inferred from this work.

For DEVAI 1.5, the ordinary RC gate is necessary but insufficient. All ten packages
must also satisfy their existing mutation score and survivor limits for the exact
candidate. The current version-1 evidence transport and ledger binding cover ordinary
RC evidence; they do not yet carry and independently verify the complete mutation
export. Do not activate 1.5 promotion until that verification is required in both
rehearsal and promotion and its candidate, policy, toolchain and approved verifier
identities are bound to the completion record. Missing mutation evidence blocks release.

A successful installed diagnostic fixture with mutation marked `not-applicable` proves
only its applicable checks. It cannot discharge DEVAI's required mutation semantics.

1. Review hook, PR and checker changes; verify `devai-release-gate` before settings change.
2. Prepare a live protection snapshot with `node scripts/process/prepare-settings.mjs <new-output-directory>`.
   The output includes current/proposed JSON and an application checklist. Re-read the
   current settings immediately before the separately authorized update; preserve unrelated settings.
3. Approve one exact `DEVAI_PROCESS_CONTROL_COMMIT` as a repository variable. All protected
   jobs check out and verify that revision before running process helpers. It is a control
   rollout, not a per-product-candidate setting. Missing or malformed pins fail closed.
4. Set `DEVAI_LEDGER_TRANSPORT=legacy` explicitly in the ledger environment initially.
   Keep existing ledger secrets, expected policy digest, verifier provenance and tag signer trust.
5. Separately authorize creation of private `aarusso-nyx/devai-evidence`, with release
   immutability enabled. Evidence releases have tag/name `evidence-<sha256>` and exactly
   one asset `evidence.tgz`; retain them indefinitely. Do not enable automatic cleanup.
6. Use an operator credential with write access only for explicit evidence upload. Install
   a separate fine-grained token with Contents: read for that private repository as
   `DEVAI_EVIDENCE_READ_TOKEN` in DEVAI's protected ledger environment. No token is stored in source.
7. Upload and verify a candidate bundle, approve `DEVAI_LEDGER_BUNDLE_SHA256`, then select
   `DEVAI_LEDGER_TRANSPORT=bundle`. Demonstrate protected verification before separately
   authorizing retirement of obsolete envelope/results/artifacts/policy/toolchain/environment secrets.
   Keep `DEVAI_LEDGER_TRUST_STORE_B64`, revocations and the other trust anchors.
8. Rehearse, create the separately authorized signed tag, then explicitly promote retained artifacts.

Absent resources or credentials are deployment prerequisites, never reasons to switch
transport automatically or execute candidate helpers with protected inputs.

## Private mutation transport

DEVAI 1.5 requires bundle schema `2.0.0`, selected explicitly with
`--schema-version 2.0.0` for pack, verify and operator upload, and
`BUNDLE_SCHEMA_VERSION=2.0.0` for protected materialization. A selected v2 bundle
cannot fall back to the six-member v1 payload or legacy payload secrets.

In addition to ordinary RC evidence, v2 contains `mutation-input-plan.json` and
`mutation-export.tgz`. The latter carries the existing installed export bytes in
this closed layout: `exported-state.json`, `policy-closure.json`, `task-policies.json`,
and `objects/<sha256>` for the exported artifact objects. Build the transport input
by copying those exact retained files; do not regenerate or resign them. Each object
must match its filename digest. Pass this directory as `--mutation-export` and the
pre-RC input plan as `--mutation-input-plan` when packing.

The transport validates the approved outer digest, complete member manifest, safe
archives and nested object hashes before writing files. It does not authenticate
export signatures or establish mutation acceptance. The installed offline verifier
must check the exported state and policy closure with external trust and approved
controls, followed by complete mutation semantics and rehearsal bindings. Workflow
activation of this v2 path remains pending that integration and protected approval.
Never include control packages, signing keys or trust/revocation files in this layout.

`verify-installed-export.mjs` provides the repository-local installed verification adapter.
Its caller first provisions and independently approves the host package, then supplies that
host, the approved DAG control, external signer trust, exact metadata hashes and policy
expectations. Use a fresh process and empty private output directory for each invocation;
the installed host permits its command adapters to be installed only once. Supply the
separately provisioned offline authority root as `expected.verificationRoot`. An empty
output directory cannot substitute for that root, and the adapter never initializes or
weakens authority policy automatically.

The adapter snapshots digest-addressed objects, invokes the existing installed
`release offline-verify` action, retains the command result privately, and refuses
unconsumed extra objects. It installs no signing or publication adapter and does not
run candidate commands. A passing product-fixture receipt with mutation marked
not applicable remains product acceptance only; release readiness still requires
independent verification of all ten required mutation packages.

## Local prerequisites and certification

Keep the configuration, package, maps, signing material, prerequisite receipt and export
parent outside the candidate repository. The package must be the authenticated installed
public package, including its runtime dependencies. Its file tree is pinned by the reviewed
`packageTreeSha256`: SHA-256 of JSON.stringify of sorted `[relativePath, sha256(fileBytes)]`
pairs for `package.json` and every regular file under `dist`. Paths use `/` separators;
symlinks and special files are rejected. This digest is established from authenticated
package bytes, not accepted from the candidate.

The mutation control identity is required before certification. Its external approval manifest
pins the archive, complete unpacked member population, source commit/tree, and dependencies.
Identity inspection executes no verifier modules and does not constitute control approval or
mutation acceptance. Certification rechecks these bindings against the prerequisite result;
a missing control fails, and unavailable dependent checks are reported as blocked.
The mutation input plan is bound before execution, without requiring generated receipts or
result hashes. It must select the exact candidate and all ten packages with score minimum
60 and survivor maximum 50. Post-run contracts must preserve these input bindings; the
approved verifier must still check the complete artifact population and semantics.

The repository-local `verify-mutation-semantics.mjs` adapter checks a complete 22-member
mutation artifact directory through the explicitly selected approved v2.1 or v2.2 kernel.
It compares the output contract with the protected input plan and checks canonical bytes,
content safety, receipt provenance, exact population, score and survivor limits. v2.2 also
requires its independent final-unit, output-contract and execution-binding controls; it
never falls back to v2.1. This semantic result does not authenticate custody or authorize
publication. Signed export/transport and rehearsal integration remain required separately.

Configuration fields:

| Field                                                    | Meaning                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `repo`                                                   | Exact clean candidate checkout                                                              |
| `packageRoot`, `packageVersion`, `packageTreeSha256`     | Approved installed package identity                                                         |
| `verifierProvenanceSha256`                               | Approved verifier provenance-file digest                                                    |
| `mutationVerifierRoot`, `mutationVerifierApprovalSha256` | External immutable mutation control installation and separately approved manifest digest    |
| `mutationInputPlan`, `mutationInputPlanSha256`           | External installed-host mutation input plan and independently established exact byte digest |
| `policyDigest`                                           | Expected reconstructed RC task-policy digest                                                |
| `toolchain`, `environment`                               | Protected map filenames; absent declared environment values are null                        |
| `privateKey`, `publicKey`, `signerId`, `trustStore`      | External Ed25519 signer and current trust/revocation configuration                          |
| `outputDir`                                              | New export directory whose existing parent is accessible and external                       |
| `receipt`                                                | Exact unsigned receipt filename, only for the separate evidence phase                       |

```text
node scripts/process/release-prerequisites.mjs prerequisites <config.json> <new-prerequisites.json>
node scripts/process/release-prerequisites.mjs certify <config.json> <prerequisites.json>
```

The first command aggregates independent setup failures without running RC or signing.
The second rechecks exact bindings, invokes the installed RC command with only declared
execution environment keys, requires its exact receipt, checks bindings again, and then
runs installed exporter preflight and export. Signing paths and ambient credentials are
not inherited by candidate task processes. The candidate's authority policy must already
be materialized through the supported approved operation.

For previously completed RC, use `evidence` instead of `certify`, with `receipt` configured
before generating the prerequisites file. The installed exporter independently rejects
foreign, stale, incomplete or unsafe evidence. A failed check never manufactures a PASS.

```text
python3 scripts/process/evidence_transport.py pack --export <export-directory> --toolchain <toolchain.json> --environment <environment.json> --output <new-directory>/evidence.tgz
python3 scripts/process/evidence_transport.py verify --archive <directory>/evidence.tgz --sha256 <digest>
```

The upload command is a separately authorized external effect:

```text
python3 scripts/process/evidence_transport.py upload --archive <directory>/evidence.tgz --sha256 <digest>
```

It verifies private repository and immutability settings, creates a draft, uploads and
byte-compares its complete asset, then publishes the immutable evidence release. Existing
identical published evidence is a no-op. An interrupted draft or unknown result requires
inspection; it is not overwritten, deleted or mistaken for absence.

## Rehearsal and promotion interfaces

Rehearsal dispatch: `publish=false`, exact `candidate_commit` on main, and intended
`release_tag=v<packageVersion>`. The tag need not exist. The workflow verifies RC evidence,
builds once, double-packs for determinism, creates SBOM/site/manifest and exercises installed
adoption on Linux. Only a successful complete graph emits `devai-rehearsal-<attempt>`.

Installed smoke acceptance consumes the canonical staged tarball and its SHA-256; it does
not pack a second smoke candidate. To verify an existing artifact locally, run
`node packages/cli/scripts/installed-tarball-smoke.mjs --tarball <absolute-path> --sha256 <digest>`.
The digest is checked before installation and again before reporting success.

The completion binds source commit/tree, intended tag, run/attempt, workflow and process
control commits, source artifact ID/digest, manifest/files and ledger verification identities.
Assets are named `devai-release-assets-<attempt>` and both artifacts last 30 days.

Create the signed annotated tag after rehearsal under separate Owner authorization. It must
point to the rehearsed commit. Tag pushes verify identity and evidence only; they do not build
or publish. Existing tags remain immutable.

Publication dispatch: `publish=true`, `release_tag`, `rehearsal_run_id`, `rehearsal_attempt`.
No latest-run lookup exists. Current protected verification, successful source run/attempt,
workflow/control revisions, exact tag/candidate and archive/file digests must all agree.
Any changed bound trust/evidence input requires another rehearsal. The exact retained assets
are promoted; no build, pack, SBOM generation, site generation or rehearsal smoke is repeated.
Registry download/hash comparison and live Pages checks remain external-effect verification.

Release and registry recovery first read the full relevant remote collection successfully.
Failed authorization, network reads and ambiguous outcomes block writes. Matching effects
are no-ops; confirmed missing effects may proceed under authorization. Mismatches are never
overwritten. A partial draft Release is inspected completely before uploading only missing
assets, and every asset is checked again before publication.

Pages currently validates the site population before upload and verifies every public
member's bytes after deployment. Apart from the empty root `.nojekyll` control file,
dot-prefixed members are refused because the pinned Pages uploader excludes them.
Interrupted Pages deployment reconciliation is not yet implemented: a failed workflow
does not prove that no deployment occurred, and automatic redeployment is not an accepted
recovery procedure. Before enabling promotion, add retained deployment identifiers,
authenticated status observation and exact-byte reconciliation so matching effects are
no-ops, only confirmed missing effects resume, and unknown outcomes block.

## Adopter migration bundles and limited self-adoption

`node scripts/process/generate-adopter-migration.mjs <config.json>` prepares local files only.
Its configuration names `adopterRoot`, `packageRoot`, `packageTarball`, `providerTarball`
and a new `outputDir`. Registry authentication is used only for metadata requests. The tool
checks tarball SHA-1/SRI, compares installed package members, reads the authenticated provider
policy/provenance and invokes the installed generator against a disposable target.

Review `migration.json`, `workflow-before.yml`, `workflow-after.yml` and `REVIEW.md`.
The Inspector verifies full provider identity and file/binary populations against the signed
release; the Owner separately approves protected changes. Apply only if the current workflow
still matches the recorded before digest. No adopter or protected setting is written by generation.
Provider upgrades remain explicit; no automatic N-1 or every-release rotation is introduced.

Self-adoption includes early diagnosis, retained artifacts and interrupted-effect reconciliation.
The existing 1.5 custom packer, protected certification provider and injected artifact sink remain
deferred. This does not alter their product contracts or declare those implementations ready.

## Mutation activation compatibility

Before an expensive mutation campaign, run the real runner regression:

```sh
pnpm exec vitest run --config tests/config/local.config.ts tests/integration/mutation-static-activation.integration.test.ts
```

With pinned Stryker 9.6.1, an explicit `testFiles` population produces an absolute
file filter even for static mutants. The upstream planner labels that filter for
runtime activation, which occurs after module initialization in the Vitest runner.
A module-level mutation can consequently be reported as surviving without ever
being active when the module loads.

The installed DEVAI wrapper activates full-file filters before module evaluation.
It retains the exact filter; relative per-test IDs keep their runtime activation.
The regression executes actual static and runtime mutants with an explicit test
population and verifies both the results and the complete test-file census.
It is a runner compatibility check, not candidate certification.

The wrapper also checks Vitest's recorded suite failures. A baseline with a failed
suite is refused even if another file passes. During mutation, a recorded suite
failure counts as a killed mutant when the upstream runner would otherwise report
survival; this includes import failures before any individual test is collected.
An empty test count alone is not treated as proof that a mutant was killed.

A wrapper change changes the protected mutation program identity. Rebuild and
rebind the installed control before a new campaign; do not reuse a previous
package result or aggregate verdict across that identity change. Retain earlier
reports as diagnostics, including failures. Do not remove static mutants or the
explicit test population to work around an activation failure.

## Pages interrupted-publication controller

`scripts/process/pages-publication.mjs` provides repository-local orchestration for
an authenticated, durable publication journal. Its identity binds the repository,
tag, candidate commit/tree, rehearsal run/attempt, manifest and site archive hashes,
and approved control commit. Each intent additionally records the uploaded artifact
ID; a successful submission records its exact Pages deployment ID.

The controller persists and reads back intent before submitting. A lost submission
response leaves an unresolved intent and refuses automatic resubmission. A retry
with a recorded deployment ID only observes that deployment, then verifies live
bytes before recording completion. Matching live bytes are a no-op. Previously
verified effects that disappear are not silently replaced. Authentication failures,
incomplete histories, conflicting identities and unaudited migration histories fail
closed. No build, repack, site-generation or automatic cancellation capability is
part of this interface.

This module is not yet activated in the release workflow. Activation requires an
approved GitHub journal adapter, a recorded audit covering earlier Pages writers,
and concurrency serialization across all Pages publication paths. The adapter must
read the complete authenticated history and durably persist each transition. Its
`confirmed-missing` result must come from external-state reconciliation; HTTP 404,
a failed workflow or an unavailable live site is insufficient. The focused controller
tests exercise interrupted writes and retries; they do not establish live GitHub
publication acceptance. Exact-artifact promotion still requires Owner authorization.

## Acceptance record

Record candidate/control SHA, focused/full gate outcomes, operator intervention count,
protected-field updates, task executed/reused counts and durations, rehearsal run/attempt,
artifact/manifest digests and publication `buildInvocations: 0`. Do not equate fixture tests with
live protected verification. External rollout and publication remain pending until separately
authorized and actually demonstrated.
