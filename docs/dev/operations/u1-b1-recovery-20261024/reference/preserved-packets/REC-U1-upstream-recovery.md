# REC-U1 — implement accepted divergent-anchor recovery

**PROPOSED implementation envelope; not release or DETRAN execution authority.**
Architect reference: upstream38b96f923b9adb35b62a2f992a0ee1f584d04180,
ADR-EVI-0006 accepted through PR420. Latest release: 2.6.3 lacks this capability.
The exact accepted record is copied in reference-ADR-EVI-0006.md with source hash.
No sibling repository is modified by this DETRAN preparation session. Approval is
an upstream handoff; upstream execution requires that repository's actual authority.

## Public contract and scope

Implement IA-001 through IA-008 and the Decision section of ADR-EVI-0006 unchanged.
Its accepted spelling is an option on existing evidence record:

```text
evidence record --recover-divergent-anchor --proof-path <canonical-path> --proof-sequence <positive-integer> --source-chain <repository-relative-path> --source-chain-sha256 <hex> --expected-head <manifest-hash> --repo-root <root> --as-role inspector --write
```

This is **not executable against released 2.6.3**. Do not patch the installed package
or call internals. Existing action authority/initiator/role/write-consent checks stay
binding. Resolve any disagreement between accepted Inspector invocation and current
registry checks by returning a bounded authority packet, never bypassing the checks.

Validate one immutable non-newest line, repository-local nonsymlink regular source,
exact source-chain hash/manifests/links and nonempty common prefix. Require exactly
one post-fork original direct anchor and matching raw physical line digest; verify
all source-anchored lines in that epoch. Reject newest, already directly/historically
anchored, unproved, ambiguous, tampered, missing/foreign/unterminated or unsafe input.

Recheck expected canonical head, source and line immediately inside serialized
append boundary. Append exactly one new canonical entry through existing machine
writer; never splice/resequence source events or rerun the proof payload. Bind a
closed recovered_from object and both artifact hashes into the manifest. Exact
retry returns existing identity/alreadyAnchored with no append; conflicting source
is refused. Concurrent identical requests converge on one append; stale request
writes nothing. Crash leaves old/new complete chain, never partial JSON/history loss.
No new persistent output is implicitly authorized; required lock/effect changes
outside this envelope must stop for an exact amendment.

## Closed upstream ownership

Engineer, only:

- packages/evidence/src/evidence/verb-evidence.ts
- packages/evidence/src/evidence/anchors.ts
- packages/cli/src/commands/evidence/facade-collect-record.ts
- packages/cli/src/commands/evidence/facade.ts

Architect, only:

- law/schemas/evidence.schema.json — optional closed recovered_from; legacy entries unchanged.
- docs/reference/cli/evidence-verify.md — actual routed help/refusals/custody/retry guidance.

Inspector, new:

- packages/evidence/tests/unit/divergent-anchor-recovery.test.ts
- packages/cli/tests/unit/divergent-anchor-recovery.test.ts
- packages/schemas/tests/contract/divergent-anchor-recovery-schema.test.ts

Inspector, existing regression additions only:

- packages/evidence/tests/unit/verb-evidence.test.ts
- packages/evidence/tests/proof-line-anchoring.test.ts
- packages/cli/tests/unit/cmp0006-evidence-recovery.test.ts
- packages/cli/tests/unit/evidence-facade-acceptance.test.ts
- packages/cli/tests/unit/evidence-verify-anchors.test.ts

ADR-EVI-0006 and prior accepted ADRs are read-only. Registry/catalogue/help-router,
package assembly and release files are validation targets, not extra write grants.
No version/manifests/lock/tag/release workflow mutation is included. Any generated
registry/schema-copy output must come from registered upstream generators and a
reviewed exact output inventory; never hand-edit dist or pinned/generated schemas.

## Acceptance and release boundary

Inspector first reproduces authentic eight-line divergence with recovered8 and
orphan7 under2.6.3; preserve RED. Prove all eight IA cases, including actual
filesystem/Git receipts, two-process contention, atomic/crash/retry and CLI authority
negatives. Engineer implements after RED; Inspector runs focused, unchanged newest
regressions, schema/CLI/package tests and installed tarball help/schema checks.
Independent review and exact-head upstream required CI must pass.

Release remains a **separate Owner decision**, with actual immutable version/source,
manifest/lock effects, tag and registry integrity. No version such as2.6.4 is presumed.
U1 acceptance alone does not resolve DETRAN's canonical conflict or dirty inventory;
REC-B1 is an independent prerequisite. No DETRAN proof mutation or merge follows.

Stop on new owned path/effect, authority mismatch, changed accepted contract,
unsupported source proof, altered epoch/prefix, missing negative/race evidence,
failed review/check or a request to waive native findings.

Approval requested: “Approve REC-U1's exact upstream implementation envelope and
role-separated tests; release and DETRAN adoption remain separately gated.”
