# REC-B1-A — exact refreshed approval proposal

**PROPOSED — NO APPROVAL RECORDED.** Baseline `2df84159caabf869b866fb2a05e5b06be83295fb`, Constitution 1.1.0. This document proposes contract authoring only, with a separately disclosed schema-catalogue companion. It implements nothing and changes no current normative file.

## Proposed Article 6 delta

Insert the following paragraph immediately after the existing `record/` core row. Preserve that row and every other existing row byte-for-byte; do not move it into a bullet or change its machine-only restriction.

> At an explicitly Owner-approved unresolved Git merge, a registered machine evidence-reconciliation verb may materialize the complete canonical chain of one exact published parent as the active merge result only after it has durably preserved and hash-verified the complete chains, proof epochs and ancestry of every displaced parent and the common base. This is a narrowly declared canonical-selection exception to append-only storage, not permission to edit, truncate, reorder, resequence, splice or re-record any source history or proof epoch. The Inspector-initiated verb must bind the exact parents, semantic index, source manifests, selected canonical prefix and immutable custody receipts, refuse every unapproved delta, and append a distinct canonical-selection evidence entry to the selected prefix through the normal machine writer before publishing the result. Every displaced active event remains explicitly archival; missing proof anchors require their separately authorized supported recovery. No human or client extension may exercise or widen this exception.

Insert this separate metadata paragraph immediately before Article 6's closing horizontal rule, after its existing extension paragraph:

> Git index mutation is permitted only through a registered machine index boundary for an exact approved reconciliation. The boundary addresses a host-bound repository/worktree identity and one declared proof-chain entry, verifies all other semantic index entries are unchanged, and performs compare-and-swap publication under the real Git index lock. It grants no general filesystem access to Git administration directories, no ref update, commit, push, force operation or business-source staging. Inspector initiation and explicit write consent are required. Linked-worktree administration paths must be resolved and bound by the trusted host; caller-supplied physical paths cannot authorize them.

These are the preserved proposal's exact two paragraphs. Article 9 requires an amendment for this exception; it remains unchanged. Articles 7, 8, 10, 24 and every other article remain unchanged. Existing ADR-GOV-0026, ADR-EVI-0002/0005/0006 and historical constitutional bodies remain byte-exact. A real successor version, version markers and amendment date must be proposed and returned with its final SHA256; this packet assigns neither package nor constitutional version. Reusing 1.1.0 for changed text is forbidden. Unbinding or widening client extensions is outside scope.

## Closed proposed ownership

The machine-readable [inventory](REC-B1-A-path-inventory.proposed.json) binds existence and current Git blobs. All paths below are **proposed write scope**, not current grants.

| Lane | Exact path | Permitted future delta |
| --- | --- | --- |
| Architect | `law/constitution.md` | Two paragraphs above and approved successor metadata only |
| Architect | `law/adr/ADR-GOV-0027-source-bound-canonical-selection-and-proof-index.md` | New record for exact amendment and reference-only typed contract |
| Architect | `law/adr/README.md` | One new ADR entry through existing index procedure |
| Architect | `law/policy/adr-validation.json` | Only registration genuinely required by current policy; preserve legacy exception catalog and digests; no invented per-ADR digest registration |
| Architect | `law/schemas/proof-index-reconciliation-contract.schema.json` | Closed, source-only reference contract from reviewed draft |
| Inspector | `packages/cli/tests/unit/constitution-article-6-amendment.test.ts` | Preserve 1.0.2→1.1.0 historical checks and exact predecessor hash; add successor reconstruction assertions |
| Inspector | `packages/cli/tests/unit/canonical-selection-constitution-amendment.test.ts` | New exact delta/unchanged rows/article and successor binding checks |
| Inspector | `packages/schemas/tests/contract/governance-v15-adr.test.ts` | Exact derived ADR/subject census and lineage additions, retaining original historical assertions |
| Inspector | `packages/schemas/tests/contract/proof-index-reconciliation-contract.test.ts` | New strict schema and semantic-boundary positive/negative contract tests |

The original nine-path census is insufficient for a new source-only schema. Current `packages/cli/src/commands/check/schemas.ts:43–70` requires equality between the canonical directory and runtime roster plus an explicit source-only list. The proposal therefore has a **separate B1-A-C companion decision**:

| Lane | Exact additional path | Only permitted delta |
| --- | --- | --- |
| Engineer | `packages/cli/src/commands/check/schemas.ts` | Add one name to SOURCE_ONLY_SCHEMAS, no executable action/authority/adapter change |
| Inspector | `packages/cli/tests/unit/check-schemas-adopter-boundaries.test.ts` | Canonical census 133→134, absent/extra cases and output strings; runtime roster remains 121 |
| Inspector | `packages/cli/tests/unit/cli-shard06-contracts-schema-residual.test.ts` | Exact source-only fixture list and mock census 16→17, unchanged refusal meanings |

Total proposed closure: **12 paths: five Architect, six Inspector, one Engineer catalogue-only companion**. The Engineer change follows Inspector RED; independent-assurance withholds every Engineer test edit. No other Engineer implementation is included. If the companion is declined, keep the typed schema as this proposed artifact and return a revised contract packet; do not knowingly land a failing nine-path canonical-schema addition. Promotion to the runtime ROSTER is an alternative proposal requiring a different exact roster/test/packaging scope, and is not silently selected here.

## Typed contract semantics

The [draft schema](proof-index-reconciliation-contract.schema.proposed.json) closes every object and requires logical repo/worktree identity, one fixed `record/proofs/chain.json` entry, before/after semantic index hashes and entry witnesses, exact parent/base/source/epoch/custody hashes, selected published parent, approved phase token, Inspector/human initiation, explicit write consent and one-entry CAS. It allows no physical Git path, executable argv, ref target, whole-index filesystem grant, broad output selector or business staging.

A schema validates shape only. The later trusted host must establish repo/worktree identity from actual linked-worktree administration, bind the approval/custody tokens, verify parent publication and ancestry, derive rather than trust semantic hashes, prove all non-proof entries identical, and enforce the real lock/CAS. Caller JSON never issues a mutation capability. Digest strings and `durable: true` do not prove custody or persistence. Tests must distinguish structurally valid forged input from semantically verified capability. The final schema example and bytes require Inspector review before canonical authoring.

## Consumer and generated closure

[consumer-census.txt](consumer-census.txt) captures literal source occurrences at the baseline. Current canonical schema count is 133, source-only 12, runtime ROSTER 121. The proposed contract makes those 134/13/121. `packages/schemas/src/index.ts:42–54` enumerates ambient canonical schemas but uses ROSTER in packaged mode; its existing source/bundled behavior stays unchanged. New Inspector tests directly compile the source-only contract, prove strict closure, and assert exclusion from runtime ROSTER. The existing schema snapshot, roster, closure and schema canon tests remain validation targets; no blanket permission to edit them exists.

`governance-v15-adr.test.ts` presently expects 131 ADR records, 132 scanned Markdown files and 642 subject authorities. Do not merely increment every number: derive the new accepted/proposed record standing and subject lineages, including overlapping constitution subjects, from the actual final ADR affected_rules/supersedes. If supersession semantics would revoke ADR-GOV-0026's retained subjects, stop and return the exact lineage proposal. Preserve its accepted body and the exception catalog; current policy does not register every ordinary new ADR by adding a digest. The reserved policy path may remain unchanged if the actual resolver needs no policy delta.

`packages/schemas/scripts/copy-law.mjs` copies all canonical schemas to `packages/schemas/dist/schemas/`; the new source-only schema appears there through the unchanged generator. `packages/skills/scripts/copy-constitution.mjs:16–29` copies the source into `packages/skills/dist/law/constitution.md`. `packages/cli/scripts/assemble-package.mjs:22,81–115` starts runtime closure from ROSTER and scans canonical IDs: source-only does not imply inclusion in installed runtime assets. Its source-only omission is intentional for this contract stage; B1-I-r2 must explicitly promote what live code needs. No hand edit of dist, runtime literals or generated registry views is permitted. Generated changes, package assets and action outputs require an actual resolved build plan and source-byte checks.

The old constitutional test currently binds live source, live pin and policy to 1.1.0 and reconstructs 1.0.2 by removing only ADR-GOV-0026's changes. Inspector must preserve that historical assertion using byte-bound predecessor content, and separately remove exactly the successor delta to recover the 1.1.0 digest. Merely changing its expected version/hash would destroy its purpose. Do not make a green claim while source/pin differ; binding is a later return gate.

## Machine effects and RETURN gates

No `.devai/pin/constitution.md`, `.devai/constitution.md`, `.devai/config/*`, state, proof or index output is authorized by the human path census. Before binding, return **RETURN-BIND**: actual successor text/version/SHA256, prior pin/source hashes, exact registered `init plan`/`init bind` options supported by the candidate, resolved actions/roles/consent, complete output paths and before/after digests, receipts/state/evidence/lock effects and source/head guards. Missing dry-plan support is a blocker requiring its own exact proposal; do not substitute a guessed CLI flag. An unowned output stops, including any new policy binding or proof event. Preserve the pre-bind state in immutable custody. No self-binding was run here.

**RETURN-INTEGRATE** separately requires independent review, exact-head affected checks against fetched base, current required CI, approved source publication/integration authority, unchanged history and completed binding closure. Install the pre-push hook in each future worktree and never bypass it. Publishing a local preparation branch/PR is a separate source effect under current AGENTS.md. Contract acceptance/integration never authorizes B1 runtime or release.

## Decisions presented to the human

**B1-A contract decision:**

> Approve contract authoring for REC-B1-A's exact two Article 6 paragraphs, the proposed source-only typed proof-index contract, and the nine named Architect/Inspector paths at source 2df84159caabf869b866fb2a05e5b06be83295fb. Preserve Article 9, all existing authority rows, ADR bodies and historical constitution checks. Return the actual successor version/digest and registered self-binding output plan before any binding or integration. This approves no B1 runtime, release or adopter action.

**B1-A-C companion decision, separately explicit:**

> Approve only the three named catalogue companion paths: one SOURCE_ONLY_SCHEMAS entry under Engineer ownership, and the two Inspector-owned schema census fixtures. Keep runtime ROSTER at 121, preserve every negative, and permit no action, authority or adapter implementation. Require Inspector RED before the mechanical Engineer change and independent Inspector GREEN.

Neither decision approves source push/PR/merge, U1 runtime, binding, release, DETRAN installation/recovery, #211 merge, C6 or S3 runtime. The later exact reviewed outputs and candidate remain return gates. These are proposed wording, not recorded consent.
