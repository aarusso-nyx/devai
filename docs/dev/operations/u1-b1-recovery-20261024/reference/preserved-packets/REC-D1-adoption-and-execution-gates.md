# REC-D1 — DETRAN adoption preparation and execution gates

**PROPOSED. Preparation-only approval is possible now; installation/recovery is
NOT executable until the exact release-binding annex is filled and approved.**
Current installed/pinned DEVAI 2.6.3; latest published release 2.6.3. No later version,
registry integrity or dependency diff is invented. U1 implementation, B1 contract/
implementation and a separately authorized upstream release are prerequisites.

## Canonical disposition proposed for approval

Bind main 7dfab8bdf61ffe935bca45578e0e65c09883f633 canonical prefix335/head
27ae053cbf3eca92fd9d855da6fc4e64e2a8a2f439a08fe69c364f5137d2b8cc, whole-file SHA256
04234742be13562cdd26b98a535b36947b60212fb42eb02a9512c94d506b3252.
Bind S29b2a190aa1276f4b15469b7079ed0d7c4c8c4c99 chain169/head
5ad7ef9ab8220f58a320747cf0ce92d973aa304f3a7f7dd73d7ec3fee779f4f8, SHA256
fdc8a9fd4b77500aa6388ad20ccd9f3329e057229bc1369869428a1ef2ddc5b9.
They share168 exact records. Preserve complete original chains and original 166
receipt chain46b1459576b3e51fbaf6ea1e8f3492d91c3171239fadf38bd8af78917cb36f73.

This proposed disposition changes active-chain selection, not historical bytes:
old S2 active8 anchor EV-3cec9e5f9871a1c3 is retained in archival custody. It is NOT
silently treated as active after adopting main's prefix. Supported machine actions
must account for7 and8, preserve all epochs, keep main's335-record prefix and add
valid new anchors without replaying proof payloads. Only released B1 can perform
canonical disposition; Git side selection/manual chain construction is excluded.

## Closed preparation inventory

Architect may prepare only new files under this approval directory:

- D1-release-binding.json
- D1-package-lock.diff
- D1-materialization-plan.json
- D1-acceptance-plan.md
- D1-owner-approval.md, only after an actual Owner response, with exact quoted text and reviewed hashes.

Initial binding fields are null in D1-release-binding.proposed.json. The actual
D1-release-binding.json must identify version, immutable release/source/tag, registry
tarball URL, SRI+SHA256, actual installed public help/schema fingerprints, Node 24/
pnpm 9 compatibility, complete package/lock diff including every transitive/peer
change, U1/B1 test/review/CI and exact registered upgrade/bind dry-plan outputs.
No mutable latest/dist-tag or sibling checkout build qualifies. A changed annex,
parent or epoch requires renewed review; preparation approval is not that review.

Future Engineer dependency writes after exact D1-L approval, ONLY:

- package.json
- pnpm-lock.yaml

Registered upgrade/bind MACHINE output candidates, NOT hand-edit grants:

- .devai/config/project.json
- .devai/config/authority-policy.json
- .devai/config/adopter-policy-binding.json
- .devai/config/upgrade-receipt.json

The release-specific dry-plan must close the exact generated set and digests before
D1-L approval. Any other pin/config/policy/host-adapter, constitution change or native
schema/producer contract change stops for its own packet. Do not edit pins/config
manually or assume these four outputs suffice for an unknown future release.

Released native output candidates are enumerated in source-custody.json as
known2.6.3 filenames, not authorization for an unknown release. Exact routes suffix,
sensor-reading identity, runtime state/receipt/evidence outputs and B1 index effects
must be expanded to actual reviewed filenames/effect rules in D1-L. No wildcard
source ownership, implicit new genericR25 proof line or unexpected output is allowed.

## Execution after exact D1-L approval only

1. Preserve index/staged resolution bundle plus original worktrees and all proof/
   legacy/custody bytes. Verify source-custody.json, the eight-line epoch and parents.
   Never reset/stash/clean the staged reconciliation or hidden local/scorecard work.
2. Inspector on disposable fixtures proves installed 2.6.3 RED, released U1/B1 positive
   and all refusal/retry/stale/concurrency/crash cases, package/help/schema and clean
   mode compatibility. Such fixtures retain full original history, never hide older
   lines to exploit newest-only behavior. No live proof mutation during qualification.
3. Engineer applies only the reviewed exact package/lock diff; run frozen install.
   Qualified roles invoke only approved registered upgrade/bind actions and actual
   released public APIs, with the exact materialization plan. Revalidate wrapper
   producer schema compatibility; any required wrapper/test change needs a bounded
   separately reviewed amendment, not a version-comment-only fix.
4. Supported B1 applies approved canonical disposition and source bootstrap. Exact
   expected orphan set is R-0025 generic7/8. Line7 uses original 166 source at existing
   work/rounds/R-0025/reports/S2-execution/CI-2026-10-21/preserved-premerge-S2-chain.json;
   source SHA46b1459576b3e51fbaf6ea1e8f3492d91c3171239fadf38bd8af78917cb36f73.
   Line8 remains the newest physical line and uses released newest-only recovery.
   Bind each action's immediate pre-append head, serially; retries append nothing.
   Expected counts are335→336→337 for these two anchor appends if no other declared
   machine evidence is emitted. Additional action records must be explicitly inventoried
   by B1-I/D1-L; otherwise STOP, never suppress or invent them. Additional orphans stop.
5. Complete role-separated native inventory and deterministic exports through B1's
   reviewed source-bound protocol, then a genuine clean candidate. Authorization
   catalogue includes exactly1141 operations only if native population is unchanged;
   compare tuple semantics, not duplicated native IDs. Refresh PII only if source
   changes require it; never edit snapshots by choosing sides.
6. At the real final HEAD/tree run the unchanged full native inventory producer,
   explicit-input security export checks, history compatibility, native proof anchors/
   chain verification, law/DEVAI/doctor and affected/root required checks. No final-head
   PASS transfers from the current9b2a tests or any bootstrap diagnostic snapshot.
7. Preserve every raw command/role/argv/status/signal/stream, package/source hashes,
   expected/actual outputs, before/after chain/index/candidate identities, reading IDs,
   retries and independent verdicts under a new owned execution custody directory.
   Readiness only follows complete final-head evidence, not the compatibility map.

Known smoke UND_ERR_SOCKET and provisioning15s failures remain separate repair
work.90s/120s functional budgets and30s performance reference stay unchanged. No
runtime S3, production, scorecard, closure, admin merge or required-check waiver.
A successful recovery/adoption still requires a new explicit merge decision.

Approval requested now: “Approve REC-D1 release-binding preparation and proposed
main-prefix disposition; present exact D1-L version/diff/effects before execution.”
