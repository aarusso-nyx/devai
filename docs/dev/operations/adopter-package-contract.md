# DEVAI 1.2.1 adopter-package contract

DEVAI 1.2.1 closes the adopter boundary at the installed public package. The package is the
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
path is outside the 1.2.1 contract.

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

## Release acceptance

The exact candidate is accepted only after source gates and a package-only disposable consumer
both pass without interrupted or composite evidence. Package contents and integrity, action and
schema populations, test census, mutation thresholds, audit findings, proof-chain behavior,
idempotence, lockfile stability, and the absence of obsolete verifier reliance must all be
reconciled. Packaging, checking, and rehearsal do not authorize push, PR creation, merge, tag,
GitHub Release, publication, dist-tag promotion, or deployment.
