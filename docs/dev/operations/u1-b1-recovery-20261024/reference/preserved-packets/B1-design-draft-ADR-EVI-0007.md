# Draft ADR-EVI-0007 — source-bound canonical reconciliation and inventory bootstrap

Architect design under approved REC-B1. **PROPOSED, not accepted upstream; no implementation authority.** Intended upstream location law/adr/ADR-EVI-0007-canonical-proof-inventory-bootstrap.md; recheck number before introduction. Upstream policy/index/census work remains separately role-owned. Existing constitution and ADR-EVI-0006 prevail.

## Context and decision proposed

A merge index can contain two machine-generated unresolved outputs while all source resolutions are staged: canonical proof chain and derived authorization catalogue. Selecting JSON by hand violates machine custody; committing a knowingly stale catalogue or lying about a dirty tree violates source provenance. Existing clean-HEAD producer must remain strict.

Introduce separate registered read-only planning, Inspector-initiated machine materialization/proof-index publication and Architect-initiated staged-source inventory actions. This is a new, explicit source identity protocol, not an option suppressing existing clean checks. User approval of this design does not approve its API/implementation packet. Both complete published histories remain immutable source objects; the approved target canonical prefix is main's existing chain. Materializing that existing prefix is explicitly reported as canonical selection at a merge boundary, not an append to or rewrite of the original S2 history. Upstream constitutional/path review must confirm this interpretation before coding; if it requires constitutional change, stop for that separate authority rather than weaken Article6.

## Invariants

B1-01: Plan binds repository identity and Git object format, actual HEAD, MERGE_HEAD, approved main/S2 commits, semantic NUL-delimited `git ls-files --stage -z` digest, exact unmerged1/2/3 blobs and modes, resolved stage0 source manifest, working-byte equality to index, config/pin/toolchain fingerprints and immutable custody hashes. Raw index checksum is diagnostic only: stat/cache-tree changes are not semantic identity. Reject additional conflicts, unstaged tracked inputs, unsafe symlinks, missing objects or untracked executable inputs; do not delete or stage protected local work.

B1-02: Only chain and authorization catalogue are unresolved dependencies. Neither is substituted with fabricated source. Establish a producer input/output graph: if any requested producer reads the unresolved catalogue as an input/reference, refuse the cycle and return exact dependency; no exclusion-based successful inventory. Bind every actual input and declared environment/toolchain dependency. Plan commands print JSON only; no hidden state/lock/proof/config writes.

B1-03: Before canonical mutation, machine archives exact main/S2/common-base/original-source chain and complete epochs into its closed custody set and verifies their committed identities. Retain main335 prefix byte-identically as records; record displaced old S2 event honestly as archival. No event splice/resequence/re-record. Derive exact orphan population from all merged epochs and receipts; only approved R0025generic7/8 proceed. U1 recovers7 from original166 chain, newest-only recovers8, serially with immediate heads. Existing prior epoch lines and protected legacy chain remain identical.

B1-04: Role separation is explicit: Inspector approves proof-side operation; Architect approves inventory-side input manifest/export operation. Each mutation requires current plan hash, source identity, prior phase receipt and write consent. No blanket shared session, default Owner bypass, general index writer, or self-authored reference.

B1-05: Materialization writes only approved chain/custody/phase outputs through registered machine boundaries. It does not stage or publish unrelated source resolutions. Proof-index publication updates only the chain's index entry after native verification, using a compare-and-swap semantic-index check. A hash-bound verified phase receipt is custody, not product readiness. Any other index/output action stops.

B1-06: Staged inventory reads a virtual immutable snapshot of resolved Git objects and bound declared inputs, retaining actual parent/index provenance. It does not create a fake clean commit, checkout older proof history, synthesize HEAD or claim `integration_head` is a staged-tree hash. Output schema uses explicit `source_kind=staged-merge-bootstrap`, actual parents and source-manifest hash; existing clean output contracts remain unchanged.

B1-07: Bootstrap emits seven complete body projections under an isolated diagnostic output namespace, no native sensor-readings/scorecard/head-pointer updates. Outputs are source-backed but not final native readiness. Existing DETRAN exporters may consume exact API/model/PII bodies only if their schema permits this provenance without changing reference semantics; otherwise stop for a separately owned adopter wrapper amendment. Expected population1141 remains conditional on exact native source; no enforced fabricated count.

B1-08: Serialize with source/index and phase compare-and-swap; detect filesystem/index/source races immediately before each write. Atomic file rename cannot make a multi-file transaction magically atomic. Use a durable phase journal with explicit incomplete state and closed gates. Never undo an appended anchor. Retry returns verified completed output or resumes the next approved phase; stale tokens refuse before additional effects. Concurrent requests cannot replace each other's locks or outputs. Unexpected files/receipts/schemas stop.

B1-09: A final real merge commit must preserve both parent ancestry and published custody, with source snapshots/exports exact and no unresolved index. After clean candidate creation, run unchanged complete native inventory, deterministic exporter verification, compatibility and native chain verification; rerun when source/HEAD changes. Bootstrap reports cannot substitute for any final gate. No merge, S3, production or scorecard promotion follows.

## Design result and limitation

REC-B1 closes the desired behavioral design. Proposed API/effects/path inventory is in B1-I-proposed-implementation-packet.md and requires explicit approval. It remains unimplemented and unreleased. The upstream authority/capability review and final release-specific D1-L are still exact execution blockers. No new action is callable from this draft.
