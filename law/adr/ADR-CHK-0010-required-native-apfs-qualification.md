---
id: ADR-CHK-0010
title: Required native APFS qualification supplements the two Linux check partitions
type: adr
status: accepted
date: 2026-10-25
authority: Architect
supersedes: []
provenance:
  - ADR-CHK-0007
  - ADR-EVI-0007
affected_rules:
  - .github/workflows/pull-request-checks.yml
  - scripts/check-workflows.mjs
  - scripts/run-native-apfs-tests.mjs
  - packages/sensors/src/harness/workflow-parser.ts
  - packages/cli/src/commands/check/ci-economy.ts
  - docs/adopters/ci-economy.md
inspector_acceptance:
  - IA-001 -- Both original Linux partitions retain their ownership and historical checks; only protected namespace positives require their actual qualified Darwin APFS host.
  - IA-002 -- The exact native-apfs job checks out the exact candidate, fails on an unsupported host, runs every native positive assertion with zero skipped cases, and exposes no protected environment or publication permission.
  - IA-003 -- The required aggregator runs under always(), requires both original partition reports and native-apfs success, and refuses missing, skipped, failed or softened native qualification.
  - IA-004 -- Unsupported actual hosts refuse provisioning with the exact existing code, no typed operation and unchanged fixture inventory; portable Linux context and stale-boot checks remain effective.
  - IA-005 -- CI economy retains its general hard macOS-on-PR refusal; only exact reviewed workflow bytes and all five executed-file pins at canonical physical paths qualify. Other paths, copies, edits, aliases, defaults, optional jobs and changed or missing executable bytes refuse.
---

# Required native APFS qualification supplements the two Linux check partitions

## Status

Accepted for the bounded DEVAI maintainer qualification change on 2026-10-25.
This record supplements ADR-CHK-0007 and preserves all earlier record bytes.
Qualification does not establish publication or authorize DETRAN adoption.

## Context

The protected reconciliation namespace is qualified only on Darwin/APFS. Running its
positive fixtures on the two Ubuntu partitions produces the intended unsupported-host
refusal rather than a native qualification. The existing workflow shape, analyzer and
economy rules must agree on the exact supplemental native job while preserving their
ordinary refusals and both original Linux partitions.

## Decision

ADR-CHK-0007 retains the two disjoint Linux plan partitions and their report ownership.
Add exactly one supplemental `native-apfs` job on `macos-15` for the protected namespace
that ADR-EVI-0007 qualified only on Darwin/APFS. The existing required
`devai-release-gate` additionally requires that job to succeed. This bounded exception
to the original three-job shape grants no adopter, runtime, publication or credential
authority and does not change any product platform guard.

Native positive tests keep every assertion and run only on their real qualified
filesystem. A preflight in the required native job rejects unsupported Node/libuv,
platform or filesystem; a zero-skip report prevents silent non-execution. Linux keeps
the historical and portable tests and exercises the genuine unsupported-host refusal.
Its boot-staleness fixture must fault the actual Linux boot-id read as well as the
existing Darwin sysctl observation, without changing either host clock.

## Consequences

The workflow checker admits only this named macOS exception, preserves both partition
report checks, and refuses an absent, skipped, failed or optional native job. Exact
reviewed step identities include the supplemental local test effects. Qualification
and CI evidence remain distinct from integration, protected RC and publication.

The workflow effect analyzer admits `macos-15` only for the actual repository's
`native-apfs` job with exactly its five built-in, read-only reviewed occurrences.
Other jobs, runners, transplanted steps, defaults and adopter-supplied reviews keep
their existing admission rules. Qualification steps use the default shell or exact
`bash`; custom shells, workflow/job defaults and conditional setup cannot turn the
required native command into a successful no-op.

CI economy recognizes only this exact reviewed workflow profile. The approved whole
workflow SHA-256 and five executed-file SHA-256 values bind the actual canonical,
regular, non-symlink files and the analyzed text. This is not a general macOS rule
change, an adopter configuration option, or proof of repository identity. A workflow
or executed-file edit needs a fresh exact review and pin update. Every other macOS
reference on a pull request retains the existing hard refusal. The analyzer also
binds the actual workflow path; an identical copy elsewhere gains no native admission.

## Alternatives Considered

Expanding the production filesystem guard to Linux would change the qualified runtime
contract and is outside this correction. Skipping native positives without a required
qualified job would remove evidence. A configurable macOS exemption would permit
unreviewed jobs; the exact reviewed workflow and executed-file pins are narrower.

## Affected Rules

- `.github/workflows/pull-request-checks.yml`
- `scripts/check-workflows.mjs`
- `scripts/run-native-apfs-tests.mjs`
- `packages/sensors/src/harness/workflow-parser.ts`
- `packages/cli/src/commands/check/ci-economy.ts`
- `docs/adopters/ci-economy.md`

## Inspector Adversarial Acceptance

- IA-001: retain both Linux partitions, every historical native assertion and their
  original report ownership.
- IA-002: require the exact candidate on the real Darwin/APFS host, supported Node/libuv,
  successful native execution and a report with zero skipped cases.
- IA-003: reject absent, optional, conditional or softened qualification, bypass shells,
  missing native success guards and incomplete original partition reports.
- IA-004: unsupported hosts refuse without typed effects or changed fixture inventory;
  the Linux stale-boot fixture faults the actual read.
- IA-005: economy rejects copied paths, altered workflow bytes and missing, changed or
  symlinked executed files. The analyzer keeps its historical same-byte, contained-file
  realpath closure; its workflow source is physically bound and may refuse without a
  sensor reading. Preserve the general lexical economy rule and historical ADR records.
