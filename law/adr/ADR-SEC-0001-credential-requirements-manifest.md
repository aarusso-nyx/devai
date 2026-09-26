---
id: ADR-SEC-0001
title: Declare credential requirements per effect and probe presence without reading values
type: adr
status: proposed
date: 2026-09-26
authority: Architect
supersedes: []
provenance:
  - law/adr/ADR-CHK-0001-preflight-probes-as-dag-nodes.md
  - law/policy/github-issues-tracking.json#/defaults/authentication
  - packages/cli/src/services/github-issues-tracking/config.ts
  - scripts/process/release-prerequisites.mjs
  - docs/adopters/install.md
affected_rules:
  - law/schemas/credential-requirements.schema.json
  - law/policy/credential-requirements.json
  - law/policy/adopter-defaults/credential-requirements-binding.json
  - scripts/check-workflows.mjs
  - packages/cli/src/commands/doctor.ts
  - scripts/process/release-prerequisites.mjs
  - .github/workflows/release.yml
  - .github/workflows/devai-ledger-verify.yml
  - docs/adopters/install.md
inspector_acceptance:
  - IA-001 -- A workflow secret reference absent from the manifest, or a manifest entry no workflow references, fails the workflow check.
  - IA-002 -- A credential probe reports present, absent, scope-insufficient, or expired and its output contains no substring of the credential value.
  - IA-003 -- A literal token shape in any committed configuration file fails the repository-wide credential scan, not only the tracking binding.
  - IA-004 -- The release workflow fails at the prerequisites job when one declared secret is absent, before any build or verification step runs.
---

# Credential requirements manifest

## Status

Proposed. Depends on ADR-CHK-0001 for the `credential` probe kind.

## Context

The tracking policy forbids storing tokens and PAT fallback, and doctor
scans the tracking binding for token shapes. The release profile has a
secret-scan capability. The install guide uses a variable reference in the
npm configuration. The release workflow consumes ten secrets and the ledger
verification workflow eight, named only inside YAML. The release
prerequisites script inspects them with pass, blocked, and fail statuses, but
runs late and only for release. Nothing declares which effect needs which
credential with which scope, so a missing or under-scoped secret is
discovered by the step that consumes it.

## Decision

Law declares a credential requirements schema and DEVAI's own manifest. Each
entry names the credential, its kind (`environment`, `repository-secret`,
`environment-secret`, `gh-auth`, `file`), the scope it needs, the consuming
workflow job or action effect, and whether absence blocks or degrades.
Adopters receive a binding with their names through the scaffold.

Three consumers follow. The workflow checker requires a bijection between
secret references in workflows and manifest entries. The `credential` probe,
shared by doctor and the preflight, verifies presence, shape, scope, and
expiry through the consuming tool's own status command and reports one of
present, absent, scope-insufficient, or expired without emitting the value.
The release workflow's first job is the prerequisites probe. The tracking
binding's token-shape scan becomes a repository-wide scan over committed
configuration and folds into the existing secret-scan capability.

The boundary is stated as law: DEVAI verifies presence, shape, and scope. It
never generates keys, never stores credentials, and never reads a value
except at the subprocess boundary that consumes it. Signing keys remain in
the trust store allowlist with revocation, unchanged.

## Consequences

A missing secret fails in seconds with its name and required scope.
Adopters learn which secrets a scaffolded workflow needs from the manifest
instead of from a failed run. Doctor gains one check backed by the same probe
implementation the preflight uses.

## Alternatives Considered

Probing by reading the value and testing it is rejected because the value
would enter DEVAI's process and logs. Declaring requirements only in
documentation is rejected because documentation is not checked against
workflows. A DEVAI-managed key store is rejected because custody must stay
with the operator.

## Affected Rules

A new schema, DEVAI's manifest, the adopter default binding, the workflow
checker, doctor, the prerequisites script, two workflows, and the install
guide.

## Inspector Adversarial Acceptance

Add a secret reference to a workflow without a manifest entry and confirm
failure; remove a reference and confirm the reverse. Run the probe with a
token whose value contains a distinctive marker and confirm the marker never
appears in any output stream or diagnostics file. Commit a literal token
shape in an unrelated configuration file and confirm the scan fails. Remove
one release secret and confirm the release workflow stops at the first job.
