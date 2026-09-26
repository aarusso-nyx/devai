---
id: ADR-CHK-0002
title: Declare toolchain identity in one manifest that workflows and probes consume
type: adr
status: accepted
date: 2026-09-26
authority: Architect
supersedes: []
provenance:
  - law/adr/ADR-CHK-0001-preflight-probes-as-dag-nodes.md
  - scripts/release-host/provision-toolchain.mjs
  - scripts/check-workflows.mjs
  - law/policy/trusted-local-rc-verifier-package.json
affected_rules:
  - law/schemas/toolchain-manifest.schema.json
  - law/policy/adopter-defaults/toolchain.json
  - .devai/config/toolchain.json
  - scripts/check-workflows.mjs
  - scripts/release-host/provision-toolchain.mjs
  - .github/workflows/pull-request-checks.yml
  - .github/workflows/release.yml
  - .github/workflows/devai-ledger-verify.yml
  - packages/cli/src/services/check-runner/runner.ts
inspector_acceptance:
  - IA-001 -- A workflow that pins a node version, action digest, or verifier commit differing from the manifest fails the workflow check by name and value.
  - IA-002 -- A toolchain mismatch on the executing host is reported as a BLOCKED probe naming observed and required values, not as a silent cache miss.
  - IA-003 -- The task-key toolchain digest derives from the manifest so that editing the manifest invalidates every cached result.
---

# Toolchain manifest

## Status

Accepted on 2026-09-26 by maintainer decision. Depends on ADR-CHK-0001 for the probe that consumes it.

## Context

Expected toolchain identity is declared in at least four places: the node
major in each workflow, the full package and version table inside the
provisioning script, the verifier source commit and version echoed inline in
the pull-request workflow, and the expected action count in the release
workflow. The trusted verifier package policy already exists but the
workflows restate its values. The check runner binds a toolchain digest into
every task key, so a mismatch invalidates the cache silently instead of
reporting what differed.

## Decision

One adopter-owned manifest at `.devai/config/toolchain.json`, materialized
from a law default, declares node, pnpm, git, pinned action digests with
their versions, the verifier package identity by reference to the trusted
verifier policy, and any repository constants a workflow must agree with.
The workflow checker verifies every pinned value in every workflow against
the manifest. The provisioning script reads the manifest instead of an
inline table. The runner derives the toolchain digest from the manifest and
the `toolchain` probe compares each declared version with the executing
host, reporting observed and required values on mismatch.

## Consequences

One edit rolls a pin everywhere, and a forgotten place fails the workflow
check instead of failing a release run. The expected action count leaves the
release workflow environment block. Adopters get the manifest through the
scaffold and their generated workflows are checked against it.

## Alternatives Considered

Placing the manifest in law is rejected because adopters run different
toolchains and the manifest is host truth, not contract. Reading the
versions from the workflows as the source is rejected because YAML is not
executable locally and the provisioning script needs the same values.

## Affected Rules

A new schema and adopter default, the materialized manifest, the workflow
checker, the provisioning script, three workflows, and the runner's
toolchain digest derivation.

## Inspector Adversarial Acceptance

Change the node major in one workflow only and confirm the workflow check
names the file and both values. Run the probe under a node minor below the
manifest and confirm `BLOCKED` with both values. Edit the manifest and
confirm every previously cached node plans as execute. Confirm the
provisioning script refuses when the manifest is absent rather than falling
back to an inline table.
