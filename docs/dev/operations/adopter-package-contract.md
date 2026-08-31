# DEVAI 1.2.8 adopter-package contract

DEVAI 1.2.8 closes the adopter boundary at the installed public package. The package is the
only DEVAI runtime dependency an adopter needs; a sibling source checkout, workspace link,
local tarball override, private workspace package, or source-repository import is not part of
the supported contract.

This document defines the release-candidate behavior. It does not authorize publication and
does not make partial implementation evidence release evidence.

## Canonical package boundary

The assembled `@aarusso-nyx/devai` package must include every schema, policy, generated catalog,
runtime module, and verification artifact reachable from a public command. Package assembly must
prove that the included bytes come from the canonical source roster. Installed-package tests run
in a disposable consumer outside the DEVAI source repository and must fail if resolution escapes
that package boundary.

The module-blueprint schema is a governed member of the runtime validator roster. It is copied,
exported, and callable as `validators.moduleBlueprint`. Blueprint validation returns structured
schema findings for invalid input and must not depend on `law/schemas` from a source checkout.

Every compatibility validator reachable through a packaged runtime sensor is likewise a governed
member of that roster. Package assembly and installed-package tests verify both the schema filename
and its exported validator function. In particular, `sense run inventory_api` must execute from the
assembled public package without resolving validator bytes from the DEVAI source repository.

## Bootstrap and binding

`init plan` is read-only and includes `law/policy/mutation-strength.json` in the reviewed
Architect projection. `init apply architect` materializes those canonical package bytes through
the existing bounded filesystem authority path and explicit `--write` consent. Existing adopter
bytes are preserved unless the reviewed operation explicitly permits their replacement. Repeating
plan and apply against an already matching target produces no write and no lockfile change.

Adopter policy is merged field-by-field into `.devai/config/project.json`; unrelated adopter
configuration is retained. The `project.docs` source and resolved `docs` target use one closed
schema. In particular, `builder: docusaurus`, `publish_target: gh-pages`, and
`gh_pages_branch: gh-pages` bind and replay idempotently. Binding documentation configuration
does not authorize a branch write or site publication.

Authority binds to the schema-valid project `name` declared in `.devai/config/project.json`.
Developer worktrees, CI checkout directories, container mount points, and disposable clones
therefore reconstruct identical `repository_id` values. Repositories that have not yet declared a
project name retain the canonical Git-root directory fallback until initialization materializes
that declaration.

The generated GitHub Actions main-observation adapter binds package installation to the protected
`PACKAGES_READ_TOKEN` secret. It explicitly fails before installation when that credential is
absent and never substitutes `GITHUB_TOKEN` for GitHub Packages access. The repository-scoped
token remains separately bounded to the consent-gated audit-ref publication operation.

The adapter selects provenance by a closed repository-capability rule. GitHub attestation remains
mandatory wherever the workflow selects it, and any missing attestation fails the job. For the
documented GitHub limitation on user-owned private repositories, the adapter instead binds the
exact observation files to an immutable Actions artifact, validates the service-provided SHA-256
digest, and uploads a separate receipt that records both the artifact identity and the explicit
`unavailable` attestation status. That exception is not a successful GitHub attestation and cannot
be selected for public or organization-owned repositories.

## Source canon versus adopter validation

The schema checker has two distinct populations:

- DEVAI source-canon validation compares `law/schemas`, the explicit runtime roster, generated
  markers, and built publish bytes. It remains fail-closed and is mandatory for DEVAI release
  candidates.
- Adopter schema/binding validation checks only installed canonical schemas and the adopter's
  bound configuration and policy files. It must not require DEVAI source paths, generated source
  views, workspace packages, or a pre-existing `packages/schemas/dist` tree in the adopter.

`check --only schemas` selects the population from the repository identity established by the
installed package and project binding. It must never report a source-canon PASS after silently
omitting a source-only rule.

## Mutation policy

Mutation checking resolves `law/policy/mutation-strength.json` from the adopter's reviewed
materialization. Explicit adopter scenario and threshold overrides remain authoritative within
the schema and constitutional limits. Missing policy, missing required inputs, survivors beyond
the declared threshold, malformed results, or source-boundary escape are failures, never an
implicit default or PASS.

## Public scorecard facade

`audit scorecard` is a stable public read action. It requires `--repo-root` and a full `--at`
commit that equals the repository's current HEAD. It reads the current standing sensor records,
bound scorecard N/A configuration, and freshness policy; uses the exact commit timestamp and
identity; and emits one action envelope whose payload conforms to `scorecard.schema.json`.

The action is deterministic for identical repository bytes and arguments. Its effect is `read`,
its only declared process capability is read-only Git inspection, it requires no role or write
consent, and it writes neither `.devai/state`, `record/proofs`, inventory, assessment, nor backlog.
`audit observe` remains the separate Auditor-initiated `harness-write` operation. No alias may
route scorecard requests through that mutating action.

Adding `audit scorecard` changes the canonical action population to 44 actions: 23 stable,
10 preview, and 11 internal. Every generated view and public count must be regenerated from the
action registry rather than edited by hand.

## Fresh evidence epoch

A new adopter may start `record/proofs/chain.json` through the existing supported evidence-record
boundary. Genesis is sequence one with the canonical empty predecessor, and subsequent records
append and hash-link without rewriting prior bytes. Verification and `doctor` accept a valid fresh
chain and reject malformed, truncated, reordered, or digest-mismatched records.

There is no discovery, migration, or fallback for `.devai/state/evidence-chain.json`. That legacy
path is outside the 1.2.8 contract.

For test evidence, the stable facade executes only the exact command declared by `--cmd`. The
authority broker classifies that invocation as a non-publishing local test-runner operation; a
different command, process API, or undeclared shell invocation is refused before execution.

## Native local evidence

The native local-evidence policy can require the exact named jobs `unit`, `api`, `db-postgis`,
`browser-e2e`, `mutation`, and `coverage`; a maximum age of 24 hours; exact commit and tree
identity; and the sole platform `darwin/arm64`. Verification receives an explicit, non-empty list
of named trusted actors from protected host configuration. Candidate-controlled policy cannot
select that trust root. Wildcards are invalid and never match.

Collection and verification bind the policy, job population, artifacts, toolchain, source hash,
commit, and tree. Changes under `.github/workflows/`, `.devai/config/`, or `law/policy/` are
always forbidden for evidence-mode substitution; adopter additions may extend this set but never
reduce it. Absent, stale, incomplete, failed, malformed, platform-mismatched, commit-mismatched,
tree-mismatched, policy-mutated, or untrusted evidence fails closed.

## Package-owned ledger verification

Generated CI and DEVAI release workflows invoke an installed `@aarusso-nyx/devai` entry point or
an immutable artifact shipped in the exact package; they do not clone or execute
`devai-nyx/devai-verifier`. The package-owned verifier reconstructs the committed task policy,
checks the complete required-node closure, and verifies repository, commit, tree, result,
artifact, signer, revocation, and digest bindings before accepting the ledger.

This replacement does not move trust into candidate configuration. Signing keys, trust stores,
actor allowlists, revocation state, toolchain maps, environment maps, expected policy digests,
and the expected package/artifact identity remain protected external inputs. Candidate bytes
cannot select or relax them. A local signature remains an attestation claim, not proof that the
signer executed the tasks, and organizationally separate signer and verifier custody remains a
prerequisite for an independence claim.

### Trusted-local-RC verifier materialization

The generated trusted-local-RC workflow resolves its verifier from the single Architect-owned
identity in `law/policy/trusted-local-rc-verifier-package.json`. The current supported identity is
exactly `@aarusso-nyx/devai@1.4.4`; neither `latest`, a version range, a source checkout, nor an
allowlist of interchangeable package or provenance identities is valid. The policy binds the
authenticated registry response and downloaded tarball to the exact package name, version,
tarball URL, SHA-1 shasum, SRI integrity, DEVAI release source commit, and release source tree.
Those values form one indivisible identity: any mismatch stops before extraction.
The CI-scaffold generator reads this policy when it renders an adopter workflow;
the DEVAI repository does not carry a second generated adopter workflow copy.
The workflow contract tests render fresh independent targets and require every
field of this identity tuple in the generated bytes.

The workflow grants only `contents: read`, `packages: read`, and `checks: write`. Package access
uses `PACKAGES_READ_TOKEN` only in the materialization step and fails before a registry request
when the secret is missing or empty. `github.token` may still authorize the workflow's separate,
repository-scoped tag lookup and check-run publication, but it must never be sent to the package
registry or substituted for `PACKAGES_READ_TOKEN`.

The tarball is downloaded into runner-temporary storage without package installation or lifecycle
scripts. The materializer treats the candidate checkout as inert data and does not execute an
adopter command, package lifecycle hook, or candidate product code. Before extraction it rejects
absolute or traversing archive paths, symlinks, hardlinks, and special files. Extraction is limited
to a fresh runner-temporary root and does not preserve archive ownership or permissions.

After extraction, the only verifier root is
`dist/runtime/evidence-verification` inside the authenticated DEVAI package. Its committed binding
is the exact provenance-file SHA-256, embedded verifier source commit, 21-file declared payload,
per-file SHA-256 population, and exact five evidence binary mappings in the Architect policy.
Missing, extra, symlinked, special, digest-drifted, or binary-drifted content fails closed before
any verifier binary executes. `DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256` is a mandatory protected
external duplicate of the committed provenance digest; equality is required, but that variable is
never the sole trust root. No path under an adopter checkout, including `packages/cli`, is a
fallback verifier source.

Advancing the verifier provider is an Architect-owned trust-anchor rollover, not
an automatic `N-1` rule. The Architect records registry metadata observed from
the authenticated registry and the signed release tag's commit/tree. An
independent Inspector verifies the downloaded tarball SHA-1 and SRI, extracts it
without lifecycle execution, and confirms the provenance digest, source commit,
21-file population, per-file digests, and five binary mappings. The Owner must
separately authorize updating the protected provenance duplicate. The previous
immutable release and policy history remain available as audit anchors; no tag,
tarball, or historical policy entry is moved or replaced.

The canonical regeneration route is
`pnpm exec devai init apply harness --target . --include ci --force`, which invokes the
CI-scaffold service through the reviewed harness projection. `doctor` byte-compares the
materialized workflow with the generator, so a hand edit is stale rather than a repair. Generation
must be byte-stable across independent clean targets. A release candidate is blocked if the policy
is absent from the assembled package, if the generated workflow differs, if package metadata or
archive validation cannot be completed, if the protected duplicate is absent or different, or if
any mutable identity or adopter fallback enters the generated bytes.

## Release acceptance

The exact candidate is accepted only after source gates and a package-only disposable consumer
both pass without interrupted or composite evidence. Package contents and integrity, action and
schema populations, test census, mutation thresholds, audit findings, proof-chain behavior,
idempotence, lockfile stability, and the absence of obsolete verifier reliance must all be
reconciled. For 1.2.8, this includes rerunning TEAT's governed package-only evidence recording
against the exact packed candidate before publication; source-repository tests do not replace that
adopter proof.
Packaging, checking, and rehearsal do not authorize push, PR creation, merge, tag, GitHub Release,
publication, dist-tag promotion, or deployment.
