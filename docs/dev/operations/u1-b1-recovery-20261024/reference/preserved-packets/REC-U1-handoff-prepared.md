# REC-U1 upstream handoff — prepared, not dispatched

Architect,2026-10-23. Owner approved REC-U1 handoff. This document conveys that approval boundary; it does not perform upstream writes, release, adoption or machine recovery. Execute only in an explicitly authorized DEVAI session after its governance reads and path locks. No cross-chat message was sent.

Reference upstream38b96f923b9adb35b62a2f992a0ee1f584d04180, accepted ADR-EVI-0006 (local exact copy reference-ADR-EVI-0006.md). Latest genuine release2.6.3 lacks the feature. Recheck upstream head, free test paths, authority bindings and release before work. Changes to the accepted decision or necessary paths stop for a bounded amendment.

## Task and exact ownership

Implement the existing ADR Decision and IA001–008 verbatim through REC-U1-upstream-recovery.md's closed ownership: Engineer verb-evidence.ts, anchors.ts, evidence/facade-collect-record.ts and evidence/facade.ts; Architect evidence.schema.json and evidence-verify.md; Inspector its three named new test files and five existing regression files. The approved original packet remains the complete path inventory. No dependencies, catalogue grant, generated schema hand edit, sibling change or release permission is added by this handoff.

Public proposed spelling:

```
evidence record --recover-divergent-anchor --proof-path <canonical-path> --proof-sequence <positive-integer> --source-chain <repository-relative-path> --source-chain-sha256 <hex> --expected-head <manifest-hash> --repo-root <root> --as-role inspector --write
```

Require serialized expected-head/source/line revalidation, one append through the existing machine writer, original-chain common-prefix and direct-anchor proof, safe repository-local nonsymlink paths, unchanged epoch/history and source custody, exact retry/no duplicate, conflicting-provenance refusal, atomic crash behavior, and role/consent negatives. No payload replay, copied source entries or historical-gap exception. Freeze original2.6.3 RED; Inspector→Engineer→Inspector under separate role sessions, then independent review and exact-head required CI.

The installed routed help must expose the mode and all options, packaged schema must admit recovered_from without invalidating legacy entries, tarball smoke must exercise the public route, and unchanged newest-line tests must pass. If routed catalogue/help/generated outputs require additional ownership, enumerate before writing. Report authentic pass/fail/resource-blocked/not-run separately.

## Return deliverables

Exact upstream source/test commits and owned diff; IA001–008 results and raw public CLI results; schema/help/tarball fingerprints; independent verdict; required CI; immutable custody receipts. Return a release recommendation only. No assumed future version/tag, publication, DETRAN install, proof mutation or PR211 merge.

U1 alone cannot solve staged canonical disposition/inventory bootstrap. REC-B1's design and future approved B1-I are independent; D1-L must later bind the actual released version, complete dependency diff and machine effects. Current main335/S2169 fork requires accounting for both missing7 and displaced8 after choosing main's prefix. Never describe old S2's recovered8 as active in that prefix.
