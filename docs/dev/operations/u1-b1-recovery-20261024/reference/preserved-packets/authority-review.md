# REC-B1 binding authority refresh — independent Architect review

2026-10-23. Upstream GitHub main/tag source ff8accd83c912d02d17df80eccbe147aafd082e3; all line references below refer to immutable copies in sources/ and that GitHub commit, not the dirty sibling checkout. source-manifest.json binds each source's SHA256 and Git blob. No repository/index/proof/config/sibling writes or installs occurred. Parent owns actual DETRAN main/candidate binding;335/169 are frozen plan identities, not an assertion that9b2a is current main.

## Current release correction

Latest release is now v2.7.0, published2026-10-23T19:33:16Z. Annotated tag object1aa4cc761d3ba92c07af61b0655e4a769daebc21 peels to ff8accd83c912d02d17df80eccbe147aafd082e3. Source constitution is1.1.0. The released-tag evidence facade blob d8bdb5c9719ec49caaf1c37b558d6d319d48a5f3 is still newest-only: facade-collect-record.ts:333,368,408; verb-evidence.ts:44,225–231. No divergent/canonical/staged-bootstrap capability is delivered by those sources. Do not request duplicate scorecard2.7 adoption or describe release2.7 itself as U1/B1 qualification. Actual installed capability/tarball qualification remains D1-L work, not performed here.

## Definite findings

1. Article6 at law/constitution.md:92 still says proof storage “is appended only by executing verbs”; Article9:133 requires a constitutional amendment when weakening a fail-closed property in Articles6–10. Articles7/10/24 retain role separation and Architect→Inspector→Engineer ordering. Existing core-harness-proofs machine FS rules (policy-core-rules.ts:323–340) admit the machine principal, but are not a normative exception to append-only semantics. They cannot alone authorize replacing a169-record canonical file with a different335-record parent prefix.
2. No released registered B1 action exists in law/policy/action-registry.json. New command names and an Owner's disposition preference do not mint capabilities.
3. There is no Git-index target in ResourceTarget: authority/types.ts:112–148 supports fs/git-ref/db/remote only. GitRefResourceTarget names refs/, not an index. resource-classification.ts:192–220 rejects non-ref git targets; fs containment:155–189 rejects an external linked-worktree git-dir. boundary-runtime-targets.ts:78–83 dispatches only existing target kinds. boundary-runtime.ts:341–349 dispatches filesystem rename/git ref operations, not semantic-index compare-and-swap. `fs:worktree-admin` is scratch/worktrees only, path-domains.ts:34; .git/index otherwise classifies fs:workspace. Existing B1-I27 lacks the model/schema/adapter/policy/source consumers needed for its proposed stage-proof action. Broad proc:git or fs:workspace is not a compliant substitute.
4. Existing withInventoryReadSnapshot is an invocation-local filesystem cache/admission predicate, not a Git-index byte source: walker.ts:52–64,86–94 reads live filesystem bytes. regenerateInventory takes string integrationHead and writes it directly (regen.ts:23–27,125); no staged-merge provenance is defined. inventory-body-inputs.ts:5–17 permits state/default body fallback unless explicit inputs/null are supplied. A new bootstrap must prevent mixed-generation fallback, not merely wrap current code in a cache.
5. DETRAN's preparation wrapper requires candidate.clean (prepare-security-inventories.mjs:288–290), unchanged identity, and inventory.integration_head equal actual candidate.head(:325–335). Its existing checks do not accept a staged bootstrap as native generation. Existing deterministic exporters can consume a separately validated native-shaped API/model/PII body, but that does not establish bootstrap admission or final native readiness. Export/input-wrapper compatibility is a separate exact adopter contract if needed; do not mutate clean admission or forge a HEAD/hash to fit it.

## Normative conclusion versus interpretation

Definite: neither current registered actions nor existing index adapters authorize B1 as written. The current read-only plan and custody collection can proceed; unsupported machine writes cannot.

Interpretation requiring explicit resolution: whether replacing the active manifest at an unresolved ordinary merge is called “canonical selection” rather than rewriting a source history. Immutable custody preserves both inputs, but does not by itself turn the active-file replacement into an append. Under a literal fail-closed reading of Article6, treat that replacement as forbidden until a narrow constitutional exception is accepted/released/bound. Do not assert that an ordinary policy ADR can silently settle it. Recommendation: choose the explicit amendment below, preserving all existing rows and role safeguards. This eliminates ambiguity before implementation instead of asking for generic authority review.

## Exact proposed Article6 amendment text — REC-B1-A

Insert immediately after the existing record/ row, without changing any existing core row:

> At an explicitly Owner-approved unresolved Git merge, a registered machine evidence-reconciliation verb may materialize the complete canonical chain of one exact published parent as the active merge result only after it has durably preserved and hash-verified the complete chains, proof epochs and ancestry of every displaced parent and the common base. This is a narrowly declared canonical-selection exception to append-only storage, not permission to edit, truncate, reorder, resequence, splice or re-record any source history or proof epoch. The Inspector-initiated verb must bind the exact parents, semantic index, source manifests, selected canonical prefix and immutable custody receipts, refuse every unapproved delta, and append a distinct canonical-selection evidence entry to the selected prefix through the normal machine writer before publishing the result. Every displaced active event remains explicitly archival; missing proof anchors require their separately authorized supported recovery. No human or client extension may exercise or widen this exception.

Add this separate metadata paragraph in Article6, preserving other authority rows:

> Git index mutation is permitted only through a registered machine index boundary for an exact approved reconciliation. The boundary addresses a host-bound repository/worktree identity and one declared proof-chain entry, verifies all other semantic index entries are unchanged, and performs compare-and-swap publication under the real Git index lock. It grants no general filesystem access to Git administration directories, no ref update, commit, push, force operation or business-source staging. Inspector initiation and explicit write consent are required. Linked-worktree administration paths must be resolved and bound by the trusted host; caller-supplied physical paths cannot authorize them.

All other Articles6–10/24 text stays unchanged. Bind the actual successor constitutional version and source digest through the upstream release process; do not invent a version or allow a client override. DETRAN's existing1.0.2 pin cannot acquire this exception by inference from upstream1.1.0 or package2.7; the eventual exact adoption/binding needs separate approval.

This proposal adds a required selection evidence entry, not a new genericR25 proof row. Therefore revised action inventory must account for that extra canonical entry plus the two anchor appends; the old335→336→337 expectation is not sufficient for this amended mechanism. Conditional example with exactly one selection event and no other declared events is335→336(selection)→337(line7)→338(line8). D1-L must bind actual event/output population, not a hardcoded invented execution result.

## Closed normative packet, before B1 implementation

Architect source paths proposed ONLY:
- law/constitution.md — exact two-paragraph delta above and actual approved version metadata; retain prior source custody.
- NEW law/adr/ADR-GOV-0027-source-bound-canonical-selection-and-proof-index.md — records this exact Article6 amendment and exclusions.0027 verified free at ff8; recheck before work.
- law/adr/README.md — existing decision-index regeneration only.
- law/policy/adr-validation.json — exact new record/digest registration only.

Inspector paths proposed ONLY:
- packages/cli/tests/unit/constitution-article-6-amendment.test.ts — preserve1.0.2→1.1.0 history as immutable source fixture while adding the new reviewed delta checks; do not amend old ADR-GOV-0026.
- NEW packages/cli/tests/unit/canonical-selection-constitution-amendment.test.ts — exact prose, unchanged rows, role/no-waiver and custody/refusal requirements.
- packages/schemas/tests/contract/governance-v15-adr.test.ts — exact census/subject additions only.

Machine self-binding outputs are NOT human edits or implicit grants: .devai/pin/constitution.md, .devai/constitution.md and corresponding project/policy bindings must come from actual supported registered binding actions with a reviewed exact output plan. packages/skills/scripts/copy-constitution.mjs already copies law source to its packaged dist/law/constitution.md (:16–29); run it unchanged, never hand-edit dist. Extra binding/generated/index outputs stop for their own exact inventory before mutation. Constitution source/index/tests work does not authorize Engineer implementation, release, adoption or live reconciliation.

Approval wording recommended:
“Approve REC-B1-A's exact Article6 canonical-selection and proof-index amendment and its seven named Architect/Inspector source paths. Preserve every existing authority row and historical constitution/ADR body. Return the actual registered self-binding output plan and final constitution version/digest before binding. B1 implementation, upstream release, DETRAN adoption and reconciliation remain separately gated.”

## Concrete B1-I amendment required after normative acceptance

Keep original27 as a proposal, not an exhaustive capability closure. Add a focused index-boundary implementation packet with the exact source consumers listed in missing-paths.proposed.json. Prefer a logical git-index target with semantic before/after tree entry hashes and one proof path, not raw fs operations on .git. Require an unforgeable prepared/verified mutation capability and host-bound repository identity as in adapters.ts:35–99; a planner JSON object alone is not authorization.

New proposed boundary must validate missing/foreign worktree/index/symlink, outside trusted git-dir, changed source/index/HEAD, extra staged path, stale lock, lock owner, source swap, unknown action/effect, crash/retry, and concurrent CAS. It may stage only verified chain output, never whole index replacement or cached source refs. The actual host wiring, schema and policy views must be included; generated catalogue regeneration is not enough.

Architect bootstrap action needs its own source-bound staged schema/body admission and explicit no-fallback projection contract. Existing clean producer stays byte-compatible; final clean native checks remain mandatory. If DETRAN wrapper must consume a new bootstrap provenance envelope, propose its exact wrapper+tests amendment before adoption. Keep those adopter writes outside upstream implementation approval.

Approval wording recommended:
“Approve the revised B1-I logical proof-index boundary and staged-source inventory packet only after REC-B1-A is accepted and its exact capabilities/adapters/source paths/tests are closed. No proc:git/fs:workspace fallback, direct proof selection, fake clean HEAD or native-readiness substitution is permitted. Return an actual released-version D1-L before installing or running it.”

## Alternatives

Existing compliant option: continue read-only custody/source reconciliation, HC finite compatibility and source-backed validation while recovery is blocked. No released action solves the canonical/index/bootstrap transaction.

Keeping S2 active and archiving current main reverses the approved main-prefix disposition and does not preserve main's335-record active prefix. Recovering7 alone on old S2 still does not integrate both histories. Reconstructing an older epoch/check-out to exploit newest-only recovery remains forbidden. A future multi-chain/DAG manifest could preserve both active histories without selecting a single chain, but needs a different schema/verifier/action design and is not a smaller already-supported alternative.

Graft calls:0. Immutable upstream sources were already named by the reviewed packet and were read through GH API; no sibling graph/index process was run or modified.

## Immediate contract-only refinement requested by parent

The seven-path REC-B1-A normative packet above may additionally own exactly NEW `law/schemas/proof-index-reconciliation-contract.schema.json` under Architect, and NEW `packages/schemas/tests/contract/proof-index-reconciliation-contract.test.ts` under Inspector. This is a closed F1 typed contract for host-bound logical repository/worktree ID, fixed proof path, semantic before/after index witnesses, exact role/consent/phase/custody and CAS effect. It does not add a live action, capability or adapter. Total immediate normative proposal: nine human-authored paths (five Architect, four Inspector). Existing Article9 remains unchanged and binding; do not phrase its hierarchy as an override. Source/config materialization remains supported-action-only with a separate exact dry-plan. The subsequent B1-I-r2 must incorporate the actual missing authority consumers in missing-paths.proposed.json and return before implementation.

Recommended immediate approval: “Approve REC-B1-A's exact Article6 text, unchanged Article9/role safeguards, and the closed nine-path constitutional/typed-index-contract and Inspector census inventory. Do not implement an action/adapter, release, bind the adopter or reconcile proofs. Return the actual constitutional version/digest and registered self-binding effects before binding, then the exact B1-I-r2 implementation packet.”

## Exporter compatibility: definite admission gap versus later qualification

Definite: the current clean-HEAD generation wrapper cannot admit B1 diagnostic output: it requires action_id sense run/execution_status pass (:112–121), clean source (:288–290), unchanged identity and actual integration_head (:325–335). B1's source_kind staged-merge-bootstrap is a new admission contract, not an existing native PASS. Do not feed a fabricated clean envelope into it.

More limited finding: the deterministic authorization exporter itself accepts schemaVersion1.0.0 plus endpoints (export-authorization.ts:22–25,211 onward), reads the actual controller/policy sources and computes their hashes. The explicit-input export checker validates native-shaped API/model/PII schemas and deterministic output (:266–305), but does not prove the clean producer ran. Therefore native-shaped complete projections accompanied by separate verified staged provenance can be mechanically compatible with unchanged exporters. That is a future D1-L qualification question, not a demonstrated need to edit every exporter.

Required new contract, before any bootstrap catalogue is accepted: exact diagnostic-body schema, separate staged source/parent/index admission envelope, complete seven-kind/no-fallback projection and a verifier that binds body bytes to the resolved working bytes equal to the staged manifest. Preserve current wrapper as clean-only. If the frozen B1 design supplies an independently verified admission receipt and unchanged body schemas, source-backed supplemental catalogue export may need no exporter code change, while still carrying diagnostic standing. If it changes native body shape, expects existing wrapper to accept the new action, or introduces undocumented exporter input, a named DETRAN wrapper/test amendment is mandatory before consumption. Do not label structural exporter PASS as native generation or final readiness. This distinction is not permission to bypass admission.

## Exact package/constitution adoption implication

Released2.7.0 source carries Constitution1.1.0; DETRAN remains bound to its actual pinned1.0.2. Existing Owner approvals preserve its stricter role split. The old D1 list of four candidate config outputs does not authorize `.devai/pin/constitution.md`, `.devai/constitution.md`, any successor constitution, source-policy change, schema/producer contract migration or extra action evidence. An independent scorecard2.7 adoption must be observed and reused without duplicating its upgrade; it does not automatically adopt this not-yet-existing Article6 exception or deliver U1/B1. Final D1-L needs a bounded amendment naming the actual released constitution version/source hash and every registered bind output/effect, with historical pins/policy custody and clean/native compatibility qualification. Installation alone never grants the new authority.
