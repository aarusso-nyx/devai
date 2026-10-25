# B1-I — exact proposed upstream bootstrap implementation packet

Architect. **PROPOSED FOR OWNER REVIEW; NOT APPROVED OR IMPLEMENTED.** REC-B1 authorized design only. This packet is a reviewable implementation proposal; it does not extend that authorization. First accept the accompanying upstream ADR under actual DEVAI authority and resolve its Article6 canonical-materialization interpretation. Any constitutional amendment required by that review is a separate stop/approval. Then obtain explicit B1-I approval before Inspector/Engineer actuation. **Canonical materialization is BLOCKED pending that authority determination; B1-I approval alone cannot waive a constitutional hard-fail or authorize an unsupported machine write.**

Reference upstream38b96f923b9adb35b62a2f992a0ee1f584d04180. No future release/version assumed. U1 remains separately approved/owned. These names/flags are proposed, not available in2.6.3.

## Inspected implementation seams, not extra grants

At upstream38b96f92, `packages/loop/src/inventory/regen.ts:101` exports `regenerateInventory`; `packages/loop/src/inventory/walker.ts:52` exports `withInventoryReadSnapshot`. `packages/cli/src/commands/sense/inventory.ts` imports those private runtime-core exports. The proposal adds a distinct typed staged-snapshot adapter at those owned seams; it does not mutate sensor algorithms or pretend the current wrapper already accepts dirty inputs. Existing `law/policy/action-registry.json` is the canonical action source, and `scripts/generate-action-registry.mjs` produces the two enumerated generated views. Existing CLI router/help consumes registry metadata and registered runtime options; actual routed installed help is mandatory acceptance.

The companion `B1-I-path-inventory.proposed.json` verifies27 unique paths against that upstream tree:13 existing and14 proposed new. This existence inventory is not a runtime capability proof. A missing registered mutation adapter, additional schema-census dependency or generated output stops for a closed amendment; no implicit extra file grant.

## Exact proposed public surface

1. `devai evidence reconcile plan --repo-root <root> --source-manifest <repository-relative-json> --source-manifest-sha256 <hex> --as-role architect --format json`
   Read-only, JSON stdout. Returns a closed plan including status READY/BLOCKED, bound source/index/parents, complete expected effects/phase identities and refusal reasons. No state/lock/output-file write. A blocked plan cannot be consumed by a writer. Source manifest must equal the Owner-reviewed D1-L digest, not an arbitrary caller waiver.
2. `devai evidence reconcile materialize --repo-root <root> --plan <repository-relative-json> --plan-sha256 <hex> --expected-source <hex> --as-role inspector --write --format json`
   Machine custody and approved canonical-prefix materialization only; does not append U1/newest anchors or stage unrelated files. Exposes immediate canonical head and phase token for existing recovery modes. Stops if plan/authority/custody/phase/index differs.
3. `devai evidence reconcile stage-proof --repo-root <root> --plan <repository-relative-json> --plan-sha256 <hex> --expected-phase <hex> --as-role inspector --write --format json`
   Requires completed exact recovery receipts and passing native chain verification. Compare-and-swap update ONLY record/proofs/chain.json in index to verified machine blob; leave every other stage0/unmerged entry unchanged. Returns next source token. No merge commit or push.
4. `devai sense bootstrap-inventory --repo-root <root> --plan <repository-relative-json> --plan-sha256 <hex> --expected-source <hex> --as-role architect --write --format json`
   Reads bound virtual staged snapshot; writes only isolated diagnostic body/journal outputs. Must not invoke the conventional clean-HEAD producer with its guard disabled. Requires exact two-conflict initial plan or its verified chain-resolved successor phase; no other unresolved path. Refuse any producer input depending on unresolved catalogue. No sensor reading, canonical inventory pointer, scorecard or reference modification.

No arbitrary --out, skip, no-git, ignore-dirty, accept-orphan, payload, target/index path or undocumented option is admitted. Route/help/schema tests require exact mutual exclusions and unknown-option refusal. Existing evidence record/newest/divergent U1 contracts unchanged. Existing clean sense run inventory_regeneration unchanged.

## Closed proposed source ownership

Engineer existing files, bounded dispatch/exports and typed input plumbing only:
- packages/cli/src/commands/evidence/facade.ts
- packages/cli/src/command-router.ts
- packages/cli/src/commands/sense/inventory.ts
- packages/loop/src/inventory/regen.ts
- packages/loop/src/inventory/walker.ts
- packages/loop/src/index.ts
- packages/cli/src/runtime-core.ts

Engineer new files:
- packages/cli/src/commands/evidence/reconcile.ts
- packages/cli/src/commands/sense/bootstrap-inventory.ts
- packages/loop/src/inventory/staged-snapshot.ts
- packages/evidence/src/evidence/reconciliation-bootstrap.ts

Engineer existing public export only:
- packages/evidence/src/evidence/index.ts

Architect existing canonical source:
- law/policy/action-registry.json — add exactly four named actions, no existing authority/capability/role relaxation.

Architect new closed schemas:
- law/schemas/evidence-reconciliation-plan.schema.json
- law/schemas/evidence-reconciliation-phase.schema.json
- law/schemas/staged-inventory-bootstrap.schema.json

Architect new reference:
- docs/reference/cli/evidence-reconcile.md
- docs/reference/cli/inventory-bootstrap.md

Inspector new files:
- packages/evidence/tests/unit/reconciliation-bootstrap.test.ts
- packages/loop/tests/unit/staged-inventory-bootstrap.test.ts
- packages/cli/tests/unit/evidence-reconcile-bootstrap.test.ts
- packages/cli/tests/unit/staged-inventory-bootstrap.test.ts
- packages/schemas/tests/contract/reconciliation-bootstrap-schemas.test.ts

Inspector existing exact census/registry compatibility only:
- packages/schemas/tests/contract/action-registry-schema.test.ts
- packages/schemas/tests/contract/schema-roster.test.ts

Generated outputs only through existing scripts, separately role-attributed:
- packages/cli/src/generated/action-registry.ts
- packages/effects-check/src/generated/action-catalog.ts

These27 named paths are the closed proposal. Recheck actual source/existence and generator dry-plan before approval. Any additional source/schema/test/generated file, package dependency, unowned adapter or host output requires an exact amendment. No directory grant, release/workflow/manifests, constitution/pin/config mutation or DETRAN wrapper edit. No source fallback through fs:unknown-write or unrestricted shell. If the existing adapters cannot express the exact effects below without constitutional/path changes, return the missing-authority packet before coding.

## Action authority and exact effects

Plan is read-only with no write consent side effect. Materialize/stage-proof are Inspector-initiated harness writes through registered proof/worktree-admin boundaries; bootstrap-inventory is Architect-initiated regeneration to isolated F5 diagnostic state, not final F4/native readiness. Preserve initiator and actual machine attribution. No action may author its own approved source manifest, policy, schemas, tests or adoption receipt. Registry capability declarations use existing admitted capability types only; run schema/authority derivation. Missing exact adapter support is a stop, never a default grant.

For one approved plan digest P, proposed machine output set is:
- `.devai/state/reconciliation/P/phase.json` and `phase.json.tmp` (atomic rename intermediate).
- `.devai/state/reconciliation/P/lease.json` (exclusive, no force-expiry; ownership proof required to release).
- `.devai/state/reconciliation/P/custody/main-chain.json`, `s2-chain.json`, `common-base-chain.json`, `original-s2-chain.json`, `R-0025-generic.jsonl`, `legacy-chain.json`.
- `.devai/state/reconciliation/P/diagnostic/inventory.json`, `api-map.json`, `routes.json`, `data-model.json`, `data-model-pii.json`, `rbac.json`, `dep-graph.json`, `coverage-matrix.json`, `admission.json`.
- `record/proofs/chain.json` and its existing writer's single temporary sibling only, exact path/mode frozen by release-specific D1-L.
- Existing `.git/index.lock`/index compare-and-swap only for the single chain index entry; exact linked-worktree git-dir resolution must be bound by plan, no arbitrary git-dir target.

P denotes the literal lowercase approved plan SHA256, not arbitrary caller path substitution. D1-L must enumerate actual resolved paths, intermediate filenames, custody byte hashes, output schema hashes and lease/index effects before execution; no wildcard runtime grant. Existing journal output may advance only allowed phases and is not a new proof/sensor record. No extra canonical chain evidence event beyond the separately inventoried two recovery appends is allowed; any unavoidable action evidence must be explicitly added to B1-I/D1-L before running. No new genericR25line9.

Diagnostic inventory schema records actual HEAD/MERGE_HEAD, semantic index/source hashes and source_kind staged-merge-bootstrap. It must never impersonate integration_head of a clean commit. Every projected body's bytes/hash/projection/population agree with admission. Complete seven kinds required; partial provider/resource availability remains BLOCKED. Existing security exporters stay unchanged; prove their accepted native body schema compatibility or stop for a separate adopter amendment. Exporting/staging authorization/PII remains the Architect-owned D1/R8 handoff, not these actions silently writing law references.

## Exact phase and failure protocol

READ_PLAN→CUSTODY_DURABLE→CANONICAL_MATERIALIZED→RECOVERIES_COMPLETE→PROOF_INDEX_PUBLISHED→BOOTSTRAP_COMPLETE. Materialize does only the first two write phases. Existing U1/newest verbs produce actual anchors; stage-proof verifies them rather than trusting a caller flag. Inventory action may require the verified successor token after proof-index publication. A failure never advances an unverified phase.

Each writer rechecks original parent identities and semantic index/source token plus all legitimately advanced phase effects. Stat-only index changes do not count as source drift. Unknown unstaged/dirty/untracked executable inputs refuse; preserve them untouched. Underlying full Git objects and original ancestry remain available. No synthetic clean checkout, shortened epoch, fabricated commit or rewritten source tree.

Archive original complete bytes first. Before canonical replacement verify archive durability and read-back; replacement is an explicit machine merge-side materialization after upstream constitutional acceptance, never a human proof edit. It preserves both immutable source chains and main prefix. Recovery appends serialize immediate expected heads. No rollback of appended history after a later failure. Journal identifies safe resumable state; later phases remain gated. Retry with exact source/plan returns verified existing state; changed source, token, receipt, output or owner fails before additional effects. Concurrent process cannot steal a lease or publish stale index. Crash/restart tests cover every write boundary and unknown partial temporary files refuse or resume only when their ownership/hash is proven.

After catalogue export resolves remaining index path and source review is complete, normal merge commit creates a genuine clean HEAD. No B1 action creates that commit. Re-run unchanged full native inventory, exact exporter checks, history compatibility and native chain verification there; rerun after drift. Bootstrap PASS is never a final readiness/merge verdict.

## Inspector acceptance and stops

RED first: authentic335/169 fork and two unresolved machine outputs cannot be truthfully resolved by current2.6.3 public actions. Prove full preserved epochs, archived event versus active event standing, allowed main335→two actual appended anchors, and source/role separation. Positives cover exact custody, staged virtual snapshot completeness, one-path index update, idempotent resume and unchanged clean mode.

Negatives: changed parent/index/source/config/toolchain; third conflict; dirty tracked/untracked executable input; symlink/submodule/git-dir escape; altered proof or source chain; unknown orphan; wrong/absent role/consent; arbitrary plan/output/path; self-authored manifest; catalogue-as-input cycle; partial/wrong-kind/body/hash; stale publication token; unknown temporary/phase event; read-only plan mutation; broad index writes; source swapping during generation; concurrent/crashed phases and different-provenance retry. Retain U1 IA001–008 and existing newest regression suite. Verify actual public installed help/actions/schema and packaged fixture before release recommendation.

Inspector acceptance, independent review, exact-head upstream CI and separate release authority are mandatory. B1-I approval would authorize only this proposed upstream implementation envelope after its architecture/authority prerequisite clears. It would not authorize publication, DETRAN package install, canonical execution, merge or S3 runtime. D1-L still returns with real version, immutable integrity, exact diff and resolved outputs. Current exact blocker is unimplemented/unreleased U1+B1 and null D1-L, not missing permission to hand-edit proof JSON.
