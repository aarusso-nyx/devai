# Ordered U1/B1 implementation, release and DETRAN handoff plan

**PLAN ONLY. No runtime implementation or execution authorized.** Exact preparation baseline and custody are in [README](README.md). All later source drift invalidates dependent path/head/output plans until refreshed; it never invalidates preserved historical evidence. No new managed task/round IDs, runtime budget, waiver, review-counter reset or target version are allocated here.

## Dependency order and authority gates

| Stage | Responsible discipline / artifact | Entry gate | Exit evidence and next gate |
| --- | --- | --- | --- |
| P0 | Maintainer preparation, this packet | Human's current request | Hash-bound references, drift/census, exact proposed decisions; no implementation |
| U1-A | Architect contract/schema/docs checkpoint | Separate approval of original REC-U1 envelope in DEVAI | Accepted ADR-EVI-0006 remains exact; optional provenance schema + docs within six-source envelope |
| U1-I | Inspector independent-assurance session | Approved U1 envelope and Architect checkpoint | Authentic RED at frozen preimplementation source, eight IA cases and unchanged newest regressions |
| U1-E | Engineer session | Inspector RED checkpoint | Four permitted runtime files only; stop on extra lock/helper/effect path |
| U1-G | Independent Inspector/reviewer | Exact Engineer candidate | GREEN, concurrency/crash/refusal receipts, installed-package checks and exact-head CI; separate integration authorization |
| B1-A | Architect / Inspector contract sessions | Explicit REC-B1-A contract approval | Exact normative proposal and tests; RETURN-BIND then RETURN-INTEGRATE, no runtime |
| B1-A-C | Inspector → Engineer → Inspector | Explicit three-path companion approval | One source-only catalogue name, exact census and authentic RED/GREEN |
| B1-D | Architect design, Inspector review | Accepted normative contract and actual binding closure | Fresh B1 design and B1-I-r2 exact ownership/actions/effects inventory, returned for approval |
| B1-I-r2 | Inspector RED → Engineer → Inspector GREEN | Exact B1-I-r2 approval | Public actions/typed boundary/bootstrap implemented, all negatives and independent review/CI |
| R | Release preparation and protected workflow owners | Integrated exact U1+B1 candidate; separate build/bind/package effects authority | Current policy gates, signed exact-source candidate and artifact qualification; separate release authorization |
| D1-L | DETRAN's own Architect/Inspector/Engineer sessions | Immutable U1+B1-capable release exists | Exact dependency/transitive diff, constitution/bind/output/acceptance packet returned to DETRAN Owner |
| D1 execution | DETRAN approved roles | Explicit exact D1-L execution approval | Supported recovery and genuine final clean native acceptance; #211 remains held pending distinct merge decision |

U1 and normative B1 preparation can progress independently once separately approved. B1 runtime depends on accepted/bound normative references; release qualification needs both delivered capabilities. For any governed coupled work follow Article 24 Architect→Inspector→Engineer checkpoint branches and merge ordering, rebasing downstream only at authorized checkpoints. Use separate sessions and declared roles where the governed product requires them; DEVAI maintainer sessions follow its effective AGENTS.md rather than inventing role declarations. Do not allow one session to author both reference and its own assurance verdict. Independent review is not claimed from this preparation.

## U1 exact envelope and contract

The lossless [REC-U1](reference/preserved-packets/REC-U1-upstream-recovery.md) and [accepted ADR-EVI-0006](reference/preserved-packets/reference-ADR-EVI-0006.md) control. Their old release/date descriptions are historical; their accepted behavior is unchanged and matches current ADR bytes. The supported public spelling to implement is:

```text
evidence record --recover-divergent-anchor --proof-path <canonical-path> --proof-sequence <positive-integer> --source-chain <repository-relative-path> --source-chain-sha256 <hex> --expected-head <manifest-hash> --repo-root <root> --as-role inspector --write
```

This is an option on existing `evidence record`, never a new action or private-entry workaround. Current registry/initiator/consent checks stay binding; disagreement with the accepted Inspector contract requires a bounded authority amendment, not bypass. No installed 2.7.0/2.7.1 supports it.

**Engineer, exactly four paths:**

- `packages/evidence/src/evidence/verb-evidence.ts`
- `packages/evidence/src/evidence/anchors.ts`
- `packages/cli/src/commands/evidence/facade-collect-record.ts`
- `packages/cli/src/commands/evidence/facade.ts`

**Architect, exactly two paths:** `law/schemas/evidence.schema.json` (optional closed `recovered_from`, existing entries unchanged), and `docs/reference/cli/evidence-verify.md` (actual routed help, refusal/custody/retry guidance).

**Inspector, exactly three new paths:**

- `packages/evidence/tests/unit/divergent-anchor-recovery.test.ts`
- `packages/cli/tests/unit/divergent-anchor-recovery.test.ts`
- `packages/schemas/tests/contract/divergent-anchor-recovery-schema.test.ts`

**Inspector, existing regression additions only:**

- `packages/evidence/tests/unit/verb-evidence.test.ts`
- `packages/evidence/tests/proof-line-anchoring.test.ts`
- `packages/cli/tests/unit/cmp0006-evidence-recovery.test.ts`
- `packages/cli/tests/unit/evidence-facade-acceptance.test.ts`
- `packages/cli/tests/unit/evidence-verify-anchors.test.ts`

Total original envelope: 14 paths. All accepted ADRs are read-only. Registry, help router, package assembly, generated schema copies, lock/manifests and release files are validation targets, not write scope. Refresh existence/blob identities before execution. A required separate lock module, persistent lock output, schema reference consumer or command-routing path outside these 14 returns for exact amendment. Do not widen scope to make tests pass.

Verify the source custody from the original **166-record direct-anchor chain**, not from the later 169-record recovery chain. In DETRAN's historical reference its SHA256 is `46b1459576b3e51fbaf6ea1e8f3492d91c3171239fadf38bd8af78917cb36f73`, path `work/rounds/R-0025/reports/S2-execution/CI-2026-10-21/preserved-premerge-S2-chain.json`. Later execution must revalidate its exact bytes and source entry, full epochs and common prefix against then-current canonical inputs. Do not manufacture a source from flattened receipts or a recovered anchor.

`recovered_from` closes source path/hash, original entry id/sequence/manifest hash and fork point. Add one normal canonical anchor through `appendVerbEvidence`, with source-chain and physical-line digests as manifest artifacts. Recheck expected head, source bytes and line immediately inside serialization; temporary-file rename alone does not prove mutual exclusion. Preserve all source entries/epochs, existing canonical prefix and historical cutoff. Do not copy/resequence/replay source events or proof payloads. Verification checks the manifest-bound artifacts as the accepted ADR specifies; do not add a new requirement to re-read the external source chain at later verification time.

## U1 Inspector acceptance matrix

Every row needs authentic preimplementation RED and candidate GREEN with full argv, role/consent, source/tree, status/streams, before/after hashes and immutable fixture custody. Preserve the historical 2.6.3 reproduction and additionally reproduce the missing capability against the exact current preimplementation package/source. Neither a fabricated failing assertion nor truncated epoch qualifies RED.

| Accepted case | Required fixture and result |
| --- | --- |
| IA-001 | Real eight-line Git divergence, recovered newest 8 and orphan 7. Supported U1 fixes 7 once. Baseline, epochs, earlier canonical entries and source chain remain byte-identical. |
| IA-002 | Wrong source SHA, bad sequence/link/manifest, no common first entry, or line at/before fork: refuse before mutation. Compare whole files, not only head. |
| IA-003 | Missing/duplicate original direct anchor, wrong raw physical-line SHA, any other source-anchored line in epoch changed: refuse. |
| IA-004 | Newest line, existing direct/historical anchor, unproved orphan: refuse. No wildcard, bulk, historical-gap waiver or widened newest mode. |
| IA-005 | Stale expected head inside real serialization writes nothing. Two independent processes contend; one append, loser stale; retry against new head returns existing identity. |
| IA-006 | Exact same line/source entry retry returns alreadyAnchored with zero append. Different chain/entry for same line refuses; no second anchor. |
| IA-007 | Symlink component, outside path, nonregular file, active chain as source, missing final newline, missing Inspector or consent: refuse before mutation with real filesystem/authority receipts. |
| IA-008 | New entry links to immediate head and new sequence; both artifact digests bound. Tampering fails chain verification. No reuse of source sequence/previous hash. |

Also prove source/line replacement between plan and append, crash before/during/after atomic publication, old-or-new complete JSON, retry after uncertain completion, foreign/unterminated epoch, unsupported flags and routed help. Preserve newest-only recovery and all existing orphan/history-modification regressions. Record exact refusal codes, including `PROOF_ANCHOR_RECOVERY_STALE_HEAD` and accepted `PROOF_ANCHOR_RECOVERY_REFUSED <reason>`.

After GREEN run the smallest trustworthy affected schema/evidence/CLI checks against fetched base, package contract tests and installed tarball public help/schema/behavior in disposable fixtures, with no DETRAN writes. Current release gates remain independent; source unit PASS is not installed-package acceptance. Use the pre-push hook without bypass, independent reviewer and required exact-head CI; any commit/rebase changes the head binding.

**Separate proposed U1 execution wording:**

> Approve the original REC-U1 fourteen-path DEVAI implementation envelope against accepted ADR-EVI-0006 IA-001–008, with Architect schema/docs, Inspector-first authentic RED, four-file Engineer implementation, independent Inspector GREEN and unchanged newest regressions. Additional paths/effects require an exact amendment. This grants no source publication/integration, release, self-binding, DETRAN adoption/recovery, #211 merge, C6 or S3 runtime.

The historical approval of the DETRAN handoff is not this execution approval.

## Subsequent B1-I-r2 design closure

Prepare this exact implementation envelope **after** accepted normative references and reviewed actual binding closure. The old 27-path B1-I and its reported 18 missing consumers are historical proposals, not a 45-path grant. The original nine-path B1-A is also not a runtime grant. At that future candidate, traverse actual consumers and return each path with role, operation, before blob, tests, action/effect and generator outputs. No broad directory write grant.

The current static review identifies these mandatory closure families and baseline anchors; this is a discovery checklist, not permission to edit all of them:

| Family | Current anchors to close in B1-I-r2 |
| --- | --- |
| Logical target, selectors and identity | `packages/authority/src/types.ts`; `packages/authority/src/decision-plan.ts`; `packages/authority/src/adapters.ts` |
| Trusted host classification and mutation | Host resource-classification, boundary-runtime-targets, boundary-runtime, host-scope and actual adapter/policy-resolver wiring under `packages/authority/src/` |
| Core path/effect decisions | Existing policy-core-rules/path-domains; action registry, exact authority/effect schemas and generated CLI/effects/sensor views |
| Public reconciliation routing | Actual CLI registration/router/command/services, supported help/refusals and porcelain boundary; names in historical B1-I remain proposed |
| Evidence | Complete canonical chain/epoch verification, selection event schema, normal writer, supported U1/newest recovery dependencies |
| Staged-source admission | Current inventory read snapshot/walker and `regenerateInventory`, integration-head token semantics, explicit inventory-body input projection with no state/default fallback |
| Packaging/rosters | Source schema contracts versus runtime ROSTER, validator closure, assembler/runtime assets and installed help/schema checks |
| Assurance | Independent schema/authority/effect/index/linked-worktree/race/crash/bootstrap/clean-mode tests and caller/source census |

`ResourceTarget` at the verified source contains only fs/git-ref/db/remote. A future logical git-index variant must close resourceIdentity, malformedTarget, selector matching, classification, decision derivation, adapter kind dispatch, host-issued capability and effect/runtime schemas—not merely a new TypeScript union arm. Linked worktree Git administration may be outside the checkout; `fs:workspace`, `proc:git`, caller-selected `GIT_INDEX_FILE` or a Git ref target cannot substitute for the typed boundary. Preserve existing target semantics and reject unknown variants.

## B1 machine protocol to specify and then test

1. **Read-only plan.** Bind trusted logical repository/worktree, actual unresolved merge parents/base/publication identity, semantic stage 1/2/3 entries, complete selected/displaced chains, all proof epochs and ancestry, source/native body manifests, constitution/binding digest, roles/consent, approved orphan population and phase. Hash every source; retain original raw index-stage custody separately from a new candidate. Do not claim an archived index is live.
2. **Durable custody.** Machine preserves and hash-verifies complete main/S2/base/original chains and epochs before active replacement. Bind immutable custody receipts and durable publication semantics; missing receipt or partial custody stops. Every displaced event remains archival. The selected prefix is the entire approved current-main chain; no historical count replaces its actual bytes.
3. **Canonical materialization.** Inspector-initiated registered verb validates exact approval and source token, materializes selected prefix under the approved exception and appends one distinct selection evidence event through the normal writer before result publication. Its receipt binds selected prefix, displaced manifests, parent/index/custody and event identity. This event is not generic R-0025 line 9 and cannot be suppressed to preserve an old count.
4. **Logical index CAS.** Trusted host resolves repo/worktree/index administration; caller supplies only logical identity. Acquire the real Git index lock exclusively, re-read semantic index and actual merge/source tokens while locked, and compare approved before witness. Replace only the proof-chain entry with its verified output blob/mode/stage result. Prove every other semantic entry unchanged; publish atomically and release only the owned lock. No commit, ref update, push, business-source staging, arbitrary Git directory write or whole-index capability. Unknown extension/index representation, foreign index override or unsafe path fails closed until deliberately supported. Lock contention cannot be bypassed by using an alternate index.
5. **Anchor recovery.** Derive full orphan obligations from complete custody. Proposed DETRAN target remains generic 7 and 8; additional orphan requires renewed review. Use U1 for non-newest 7 from original direct anchor and newest-only mode for physical newest 8 when still applicable. Rebind immediate head serially for each append. The actual protocol must resolve ordering dependencies between inventory/catalogue and staging; no implicit staging by a proof append. Index CAS must name the exact chain blob it publishes; a later append invalidates that witness and requires a new approved phase/witness, never silent whole-index restaging.
6. **Staged bootstrap.** Architect-owned inventory admission reads every resolved candidate input from the exact staged manifest and verifies working bytes equal admitted staged bytes before analysis, or supplies an actual staged-byte reader. Current invocation-local read cache reads live files and is not such a reader. Define how controlled unresolved chain/authorization dependencies are represented and which phase may consume them; reject a third unresolved path, unrelated dirty/untracked executable input, symlink escape or mixed generation. Bind all native bodies explicitly, no last/default body fallback. Do not forge `integration_head` or clean status. The bootstrap is diagnostic, never final native readiness.
7. **Catalogue resolution.** Deterministic authorization/PII exporters consume complete verified staged-source bodies with separate admission provenance. Preserve shared controls and S2 GET routes. Existing clean-only wrapper cannot accept the new action/provenance by assertion. If independently verified staged admission and unchanged body shapes suffice, propose that exact supported route; otherwise return a named DETRAN wrapper/test amendment. No blanket exporter edits and no manual JSON-side selection.
8. **Resumability and final closure.** Specify pre-state, custody-complete, selection-complete, proof-recovery-complete, bootstrap-complete and index-publication phase tokens, their actual order and crash receipts in B1-I-r2. Each token binds predecessor receipt and source/head/index. A failure leaves unchanged pre-state or a closed-gate resumable phase; never roll back an appended proof history. Exact retry returns original identity without duplicate selection/anchors. Stale/foreign token refuses. After supported reconciliation reaches a genuine clean candidate, run complete unchanged native inventory, deterministic exports, chain/history and required checks at final exact HEAD/tree. Any later source/commit drift requires fresh final-head evidence.

The stage names above are proposed explanatory phases, not registered actions or new round allocations. B1-I-r2 must supply a complete state/transition/output table and exact public command grammar; this plan deliberately does not invent executable flags or claim the unresolved multi-output transaction already exists.

## B1 validation matrix and return artifacts

| Area | Required independent evidence |
| --- | --- |
| Full custody positive | Real multi-parent fixture with complete main/S2/base/original epochs; selected prefix exact, archival events accounted, distinct selection event plus supported 7/8 recovery |
| Identity and stale guards | Parent/base/HEAD/source/index/constitution/body/epoch/receipt changes, forged/foreign worktree, wrong phase/role/consent, unapproved orphan each refuse before dependent mutation |
| Index authority | Linked worktree outside checkout, arbitrary physical path, ref/business entry, extra staged path, symlink and foreign index override negatives; only one semantic proof entry changes |
| Contention and crash | Two real processes, actual index lock, held/foreign/stale lock; stale CAS; interruption before/after each durable output; lock ownership and retry receipts; no history loss or partial readiness |
| Inventory admission | Complete native kinds/bodies/hashes, missing/partial body, stale state fallback, mixed staged/live bytes, third unresolved input, dirty/untracked executable input and unauthorized output negatives |
| Final acceptance | Existing clean mode unchanged, genuine clean final native/export/chain checks, installed package public route/schema and independent review/exact-head CI |

Return exact commands, schema/target/action/effect changes, all source/test paths, generated registry/roster/assets, locks/custody/receipt/native output filenames, before/after digests, approval/role/consent and source guards. Unknown extra effects stop. Source-only contract approval is insufficient for runtime ROSTER promotion or any effect registration. New actions require their ADR and closed action-registry amendments.

## Release sequence and evidence

No release version is invented. Re-read the then-current release-verification and release-lifecycle policies and package-owned plan at the approved candidate. This source's `release-verification.json` names required check `devai-release-gate` and capability tasks covering formatting, lint, type integrity, schema consistency, affected/dependent checks, build, package integrity, full local/unit, integration, consumer/API/migration/rollback, security/provenance/reproducibility and operational matrix. Do not replace the RC policy with the focused development checks.

1. Obtain separate source integration and build/bind/packaging effects authority, close all paths/outputs and independently review the final candidate. Install pre-push hooks; run `devai check --affected` against fetched base via supported current invocation. Required exact-head CI must pass; green on a previous commit is not equivalent. Preserve source-family commit grammar and review provenance.
2. Revalidate resource/process/port/database state and acquire exclusive validation capacity before authorized heavy execution. STYNX's notice is not a DEVAI lease. Use current preflight, validation-runner, isolated docs outputs and resumable release orchestration; do not repeat another owner's lane. Full lint/typecheck/coverage and policy-required checks remain mandatory, with real receipts, no relaxed thresholds/timeouts or reset budgets.
3. Resolve actual version and manifest/lock delta under explicit release preparation scope. Enumerate registered build/bind/assembly effects, copied constitution/schema/generated runtime assets, signing inputs, external docs output, package certification and exact clean commit/tree. No human edits to dist/pins. Run installed-package U1/B1 contract and unchanged behavior checks from the actual tarball, not just workspace imports.
4. Follow the current registered lifecycle: read-only **release plan**; Inspector **release preflight** then **release certify**; Architect **release prepare** then **release export**; **release offline-verify** produces a verification receipt without authority. State/roles/effects must match the actual policy and supported adapter; an action unavailable on this host blocks its dependent step.
5. Return the exact immutable candidate/version/artifact/destination/workflow/trust identities and one-time effect requests. **release evidence-publish** and **release publish** are distinct Owner remote effects with separate exact authorization; neither is implied by offline verification, CI or this plan. Product dispatch is not publication completion. **release resume** observes the signed protected external publication receipt and derives published; do not append a fabricated published state or treat a receipt as a grant.
6. Qualify the actual release: annotated tag and peeled source, clean commit/tree, GitHub release, registry exact version URL, SHA256/size and SHA512 SRI, package/source schema/help identity, included accepted successor constitution and enforcement, public U1/B1 acceptance receipts and independent review/CI. A newer mutable latest label, a passed rehearsal, or accepted ADR alone never qualifies. Preserve signing/verifier custody separation and return actual limitations.

## Future exact DETRAN D1-L handoff

Return a self-contained **new release-specific proposal** to DETRAN, never perform these effects from DEVAI:

- Immutable source/tag/tree/version, release URL, registry tarball URL, size/SHA256/SRI, Node/pnpm engine compatibility, installed public help/schema fingerprints and U1/B1 assurance evidence. Identify actual installed baseline before deriving any diff; handoff reports 2.7.0, not the old packets' 2.6.3.
- Exact `package.json`/`pnpm-lock.yaml` diff with all direct, transitive, peer, integrity and lifecycle-script changes. Do not duplicate an independently completed scorecard upgrade. Use frozen installation only after exact approval; no package install is authorized by this upstream plan.
- Actual released successor constitution/source digest and complete registered upgrade/bind dry plan, including pin/config/policy/state/receipt/proof/lock effects and before/after identities. The historical four config output candidates are insufficient authority for an unknown release. Never hand edit generated binding outputs.
- Fresh exact main/S2/base/index/source/epoch/custody binding. Main was 449 records at M2 handoff, S2 169 and original source 166; old 335 and 1141 catalogue numbers are not current execution targets. Derive complete orphan population and actual generated event/output counts; selection plus two recovery appends would add three canonical entries only if no other registered events exist. Never suppress extra events, invent IDs or assume a final count.
- Preserve all archived snapshot/index bytes and historical ADR bodies. DETRAN ADR-0061/0062 collisions require then-free identifiers through its ADR-0035 procedure and exact finite HC-01 compatibility refresh. No identifier is allocated here and no round is reopened.
- Source-bound admission/export compatibility. Preserve the existing clean-only wrapper. If a new bootstrap envelope needs wrapper/tests, name the exact additional adopter scope and obtain approval before consumption; no fabricated clean/native envelope. Actual catalogue tuples/native IDs derive from the admitted candidate, preserving shared controls and S2 additions.
- Disposable installed-release positive/negative/race/crash/retry qualification with original full history; exact D1-L execution approval then role-separated supported live protocol. Retain all raw argv/roles/status/signals/streams, hashes and native readings. Bootstrap remains diagnostic; final clean inventory/export/history/chain and original JW-01/kernel/affected required acceptance remains mandatory.

Known smoke transport and 15s provisioning failures remain separate source-bound repair scopes. Preserve the four approved 90s/120s functional controls and 30s performance reference. M1 main PASS does not accept S2; compatibility/export PASS does not promote scorecard cells. Keep DETRAN #211 unmerged even after successful recovery until a separate explicit removal of its hold. S2 integration and separately authorized audit precede S3 runtime and exact S3 packet approval; C6 stays blocked.

## Residual blockers and next authorized step

REC-B1-A and catalogue companion decisions, REC-U1 execution approval, actual successor version/digest/self-binding closure, B1-I-r2 implementation approval, independent assurance/CI, exact release effects and future D1-L remain outstanding. Existing releases lack the required runtime capabilities. No broad expired delegation, new budget or threshold waiver bridges those gates. The next action within present authority is review/refinement of this local packet. Approval wording is available now; no normative/runtime/release/adopter mutation may begin merely because the preparation is complete.
