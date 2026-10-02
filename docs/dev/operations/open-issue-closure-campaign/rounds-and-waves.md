# CMP-0006 rounds and waves

Accepted plan: 9 rounds, 20 CTGs, 46 tasks. All remain planned. PR-A collects the 44 remediation/preparation task contributions in R-0601–R-0607; PR-B contains TASK-0681 and bounded TASK-0691 accounting after immutable publication. Role boundaries, attributed single-family commits and human review remain.

Source sequencing uses the exact reviewed checkpoints in integration-contract.md under the CMP-0006 source-only policy override. Runtime round/task records retain their normal lifecycle. A checkpoint never means merged or closed. After each observed PR merge, perform actual close gates; effects keep R-0607/R-0608/R-0609 open until verified.

## R-0601 — Verify accepted contracts and establish campaign entry

Verify accepted contracts, settled issue dispositions and the two-PR source integration entry; preserve exact checkpoint and effect boundaries.

Source dependency phases: none. R-0608 requires actual R-0607 closure and publication, not just a source checkpoint.
Accepted records: ADR-EVI-0004, ADR-SCR-0012, ADR-EVI-0005, ADR-MDL-0003, ADR-CHK-0005.
Actual closure checks: universal close checks plus campaign:check.
Required effects at actual closure: OE-01, OE-02, OE-03. OE-02/OE-03 are already recorded; all other effects require observed completion.

### CTG-0611 — Verify accepted contracts and establish campaign entry evidence

Issues: [240](https://github.com/aarusso-nyx/devai/issues/240), [253](https://github.com/aarusso-nyx/devai/issues/253).
Wave predecessors: none. Shared lock prefixes serialize.
Gate members: adrs, docs-links.
Lock scopes: law/adr/ADR-EVI-0004-canonical-closure-acceptance-amendment.md, law/adr/ADR-SCR-0012-inventory-cell-naming-amendment.md, law/adr/ADR-EVI-0005-newest-line-recovery-cli.md, law/adr/ADR-MDL-0003-live-review-envelope-contract.md, law/adr/README.md, law/policy/adr-validation.json, law/policy/campaign-execution.json, docs/dev/index.md, docs/dev/operations/open-issue-closure-campaign/, product/campaigns/CMP-0006-open-issue-closure/.

- [TASK-0611](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0611.md) — architect, architect/high: Verify the already accepted four forward ADRs and effective lineages, regenerated catalogue, recorded Owner choices and two-PR integration procedure. Revalidate main/issues/comments and preserve the serialized-admission fallback. Establish exact source checkpoint handoffs and current tier pins without re-requesting acceptance or fabricating merged/closed state. Preserve and integrate the entire manifested preparation bundle within the declared campaign/doc directories as Architect-authored planning work; do not lose uncommitted artifacts when creating the first isolated task worktree.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

## R-0602 — Remove security findings and make CI trustworthy

Resolve every high-severity advisory and produce reliable candidate gates with actionable failures.

Source dependency phases: R-0601. R-0608 requires actual R-0607 closure and publication, not just a source checkpoint.
Accepted records: ADR-SEC-0001, ADR-SCR-0010, ADR-SCR-0012, ADR-GOV-0023, ADR-CHK-0003, ADR-CHK-0004, ADR-GOV-0017, ADR-GOV-0018, ADR-GOV-0021.
Actual closure checks: universal close checks plus ci-economy, test:root, test:sensors.
Required effects at actual closure: none. OE-02/OE-03 are already recorded; all other effects require observed completion.

### CTG-0621 — Resolve all high-severity dependency advisories

Issues: [233](https://github.com/aarusso-nyx/devai/issues/233).
Wave predecessors: none. Shared lock prefixes serialize.
Gate members: test:sensors.
Lock scopes: docs/dev/operations/open-issue-closure-campaign/dependency-remediation.md, packages/sensors/tests/unit/cmp0006-dependency-advisories.test.ts, package.json, pnpm-lock.yaml, packages/cli/package.json, packages/sensors/src/security-scan.ts, packages/sensors/tests/unit/security-scan-shape-boundaries.test.ts, packages/sensors/tests/unit/mutation-wave8-security-scan.test.ts, packages/sensors/tests/unit/security-perf-depth.test.ts.

- [TASK-0621](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0621.md) — architect, architect/high: Inventory current advisory IDs, affected dependency paths and fixed versions using live audit evidence; document upgrade/replacement scope. The Owner grants no waiver. Do not freeze the obsolete count of eight. Record the Owner-approved CTG-0621 source/test scope amendment, bounded moderate patches needed by the unchanged full-audit gate, synchronized prompts and acceptance commands, and refreshed integrity hashes. The six planning-file writes expire at this Architect checkpoint; no downstream role or effect is dispatched.
- [TASK-0622](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0622.md) — inspector, worker-high/high: Prove the actual vulnerability sensor cannot turn an unwaived high advisory or incomplete audit into PASS; retain fixture provenance and negative cases. Preserve all existing security and unrelated performance cases; replace incomplete successful audit fixtures with complete evidence and correct unsafe PASS expectations in the three owned existing security test files. Exercise the registered security_scan emitter through its actual process seam; retain negative shape/count/process cases and audit fixture provenance.
- [TASK-0623](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0623.md) — engineer, worker-high/high: Upgrade or replace every high-severity affected dependency, keep lockfiles coherent and run affected package checks; document residual lower-severity results without waiver or threshold changes. Harden packages/sensors/src/security-scan.ts against incomplete, malformed or failed audit evidence without changing sensor identity, thresholds, controlled subprocess bounds, public actions or waiver policy. Apply only the documented fast-uri, brace-expansion, Vitest/coverage and ip-address patches within the owned manifests/lockfile, including moderate fixes needed for the unchanged pnpm audit --json gate; revalidate live advisory drift and preserve residual findings.

The Owner approved the bounded amendment in [dependency-remediation.md](dependency-remediation.md). TASK-0621 additionally owns and locks only the six listed planning files for this one-time amendment, expiring at its Architect checkpoint. Inspector and Engineer acceptance adds all three existing focused security files while retaining the new campaign test and complete live audit. All existing test cases and unrelated performance cases remain. No Inspector/Engineer session, publication or merge is initiated by this amendment.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

### CTG-0622 — Prove Pages concurrency safety and invariant gate evidence

Issues: [234](https://github.com/aarusso-nyx/devai/issues/234), [235](https://github.com/aarusso-nyx/devai/issues/235).
Wave predecessors: none. Shared lock prefixes serialize.
Gate members: ci-economy, test:sensors.
Lock scopes: docs/dev/operations/open-issue-closure-campaign/ci-invariant-contract.md, law/trace.json, tests/contract/cmp0006-ci-invariants.contract.test.ts, packages/sensors/tests/harness-invariant-alignment.test.ts, tests/contract/cmp0006-pages-concurrency.contract.test.ts, .github/workflows/site-publish.yml, .github/workflows/pull-request-checks.yml, scripts/check-workflows.mjs, packages/sensors/src/harness-invariant-alignment-workflow.ts.

- [TASK-0624](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0624.md) — architect, architect/high: Declare exact CI evidence producers for INV-DEVAI-002 trace resolution and INV-HARNESS-006 hard/soft gating, thresholds and distinct evaluator identity. Correct #234 reproduction: the group exists with cancel-in-progress false. Review journal reconciliation under cancellation; no blanket exception is proposed.
- [TASK-0625](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0625.md) — inspector, worker-high/high: Inject dangling/unknown trace entries, invalid hard verdicts, below-threshold soft verdicts and shared evaluator identity; each must fail the candidate gate. Test cancelled Pages runs cannot assert a verified journal and a replacement reconciles its predecessor.
- [TASK-0626](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0626.md) — engineer, worker-high/high: Add the fail-closed invariant gate paths and candidate evidence. Make the existing Pages concurrency policy satisfy harness_coherence only after cancellation/reconciliation safety is proved; preserve main guard, scoped permissions and exact deployment identities.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

### CTG-0623 — Make bootstrap cache hits safe and report the failing node

Issues: [247](https://github.com/aarusso-nyx/devai/issues/247), [248](https://github.com/aarusso-nyx/devai/issues/248).
Wave predecessors: CTG-0622. Shared lock prefixes serialize.
Gate members: ci-economy, test:root.
Lock scopes: docs/dev/operations/open-issue-closure-campaign/ci-cache-and-diagnostics.md, tests/contract/cmp0006-bootstrap-cache.contract.test.ts, tests/contract/cmp0006-pr-gate-diagnostics.contract.test.ts, .github/workflows/pull-request-checks.yml, scripts/process/bootstrap-check-runner.mjs, scripts/run-pr-release-gate.mjs.

- [TASK-0627](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0627.md) — architect, architect/high: Declare the complete transitive bootstrap artifact identity, restore verification and rebuild-on-incomplete-hit rule; keep the planning lane free of candidate execution. Specify a bounded per-node failure report with redaction and retention.
- [TASK-0628](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0628.md) — inspector, worker-high/high: Prove cold-cache, complete warm-cache, missing workspace dist, corrupt restore and changed dependency inputs; inject a failing affected node and assert its ID, code and bounded tail reach log/artifact with nonzero exit.
- [TASK-0629](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0629.md) — engineer, worker-high/high: Restore a complete dependency closure or make the runner self-contained under the approved contract, validate restored bytes before reuse, and preserve fail-closed exit while printing/uploading actionable affected-node diagnostics.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

### CTG-0624 — Enforce the approved campaign integration boundaries

Issues: [243](https://github.com/aarusso-nyx/devai/issues/243), [250](https://github.com/aarusso-nyx/devai/issues/250).
Wave predecessors: CTG-0623. Shared lock prefixes serialize.
Gate members: test:root, test:cli.
Lock scopes: law/schemas/change-taxonomy.schema.json, law/policy/change-taxonomy.json, law/policy/campaign-execution.json, docs/dev/operations/open-issue-closure-campaign/integration-contract.md, tests/contract/cmp0006-campaign-integration.contract.test.ts, tests/contract/cmp0006-scoped-verifier-pairing.contract.test.ts, packages/cli/tests/unit/cmp0006-release-verifier-restatement.test.ts, scripts/check-campaign.mjs, scripts/check-commit-range.mjs, packages/cli/src/services/ci-scaffold/index.ts, packages/cli/src/services/ci-scaffold/workflows.ts, packages/cli/src/services/ci-scaffold/verifier-package.ts, packages/cli/src/services/ci-scaffold/release-verifier-restatement.ts.

- [TASK-06210](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-06210.md) — architect, architect/high: Specify the CMP-0006-only cumulative remediation PR plus post-release repin PR and human-ratified checkpoint dependency procedure, preserving default adopter/runtime lifecycles. Define schema-declared path-scoped law/CI pairing: mandatory trusted-local-rc-verifier-package.json plus only the two exact workflow restatements; unrelated paths fail closed. Keep workflow paths CI, all gates and existing law/generated compatibility. Define a pure release verifier-section generator preserving all unrelated release bytes; no new public action or effect. The second PR is the accepted post-release repin boundary; it never precedes immutable publication.
- [TASK-06211](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-06211.md) — inspector, worker-high/high: Prove one campaign PR is counted once across waves, different PR identities are refused and checkpoint evidence is not merged/closed evidence. Prove scoped pairing permits exactly the declared policy/restatement population, rejects extras and policy-only/workflow-only changes, preserves legacy pairings and schema validation. Prove deterministic ledger/release restatements track policy identity and preserve release main ancestry, signing, approvals, permissions and exact surrounding bytes.
- [TASK-06212](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-06212.md) — engineer, worker-high/high: Implement the accepted bounded checkpoint/PR accounting checks and path-scoped pairing enforcement without widening unrelated campaigns. Add a deterministic pure release verifier-restatement generator using the current protectedVerifierPackageStep seam; preserve unrelated release workflow bytes and keep output population exact. Add no action, public flag, dependency or remote effect. Do not generate or edit canonical workflows in this Engineer task; Architect TASK-0681 owns later generated outputs.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

## R-0603 — Produce the inventory and stabilize observations

Keep F4:T4/F4:T9 measured and make the coverage producer and reported load-sensitive cases repeatable.

Source dependency phases: R-0601, R-0602. R-0608 requires actual R-0607 closure and publication, not just a source checkpoint.
Accepted records: ADR-SCR-0012, ADR-SCR-0004, ADR-SCR-0007, ADR-CHK-0003.
Actual closure checks: universal close checks plus test:cli, test:loop, test:sensors, test:skills.
Required effects at actual closure: none. OE-02/OE-03 are already recorded; all other effects require observed completion.

### CTG-0631 — Produce the framework inventory expected by its sensors

Issues: [237](https://github.com/aarusso-nyx/devai/issues/237).
Wave predecessors: none. Shared lock prefixes serialize.
Gate members: test:loop, test:sensors.
Lock scopes: law/policy/sensor-notes/inventory_adherence.md, law/policy/sensor-notes/inventory_regeneration.md, docs/dev/operations/open-issue-closure-campaign/inventory-production.md, packages/loop/tests/unit/cmp0006-framework-inventory.test.ts, packages/sensors/tests/unit/cmp0006-framework-inventory-readings.test.ts, packages/loop/src/inventory/regen.ts, packages/cli/src/commands/audit/observe.ts, packages/cli/src/commands/sense/readings-rebuild.ts, packages/cli/src/commands/sense/adapter-readers.ts, packages/sensors/src/inventory-adherence.ts.

- [TASK-0631](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0631.md) — architect, architect/high: Specify the existing inventory schema, body paths, kinds and integration-head bindings consumed by F4:T4 and F4:T9; use existing registered producers and no hand-authored inventory. The Owner chose production, not N/A.
- [TASK-0632](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0632.md) — inspector, worker-high/high: Prove generation from a clean fixture, deterministic bytes for fixed inputs, real nonempty measured population, candidate binding, and rejection of missing/stale inventory, kind omissions and fabricated N/A.
- [TASK-0633](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0633.md) — engineer, worker-high/high: Connect the existing typed inventory producer to the framework observation/rebuild path and correct bounded persistence of its required bodies; do not add a new public action or copy an adopter workaround.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

### CTG-0632 — Make coverage safe under sweep and nested test execution

Issues: [236](https://github.com/aarusso-nyx/devai/issues/236), [242](https://github.com/aarusso-nyx/devai/issues/242).
Wave predecessors: CTG-0631. Shared lock prefixes serialize.
Gate members: test:cli, test:sensors.
Lock scopes: law/policy/sensor-notes/test_coverage_depth.md, docs/dev/operations/open-issue-closure-campaign/coverage-reproduction.md, packages/cli/tests/unit/release-lifecycle-execution.test.ts, packages/cli/tests/unit/sense-adapter-acceptance.test.ts, packages/sensors/tests/e2e-and-coverage-outcomes.test.ts, tests/contract/cmp0006-coverage-recursion.contract.test.ts, packages/sensors/src/test-coverage-depth.ts, packages/cli/src/commands/sense/adapter-readers.ts.

- [TASK-0634](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0634.md) — architect, architect/high: Freeze local coverage population, exclusions and authority shape; declare recursion refusal before spawning and bounded failing-test identity diagnostics from stdout/stderr. A nested producer never launches even if authority configs are added.
- [TASK-0635](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0635.md) — inspector, worker-high/high: Reproduce the release-task-policy-identity-mismatch under sweep/load; isolate test state. Prove adding coverage configs to the host test scope cannot recurse, a failing producer reading names its failing test file and no changed population/threshold makes the fixture green.
- [TASK-0636](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0636.md) — engineer, worker-high/high: Implement the approved pre-spawn recursion guard and bounded producer diagnostic extraction. Preserve real nonzero producer FAIL, refusal UNKNOWN and local-population sidecar checks; do not broaden host authority.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

### CTG-0633 — Isolate every reported load-sensitive test case

Issues: [246](https://github.com/aarusso-nyx/devai/issues/246).
Wave predecessors: CTG-0632. Shared lock prefixes serialize.
Gate members: test:cli, test:skills.
Lock scopes: docs/dev/operations/open-issue-closure-campaign/load-test-matrix.md, packages/cli/tests/unit/cli-shard09-verify-translation-c-overlay-boundaries.test.ts, packages/cli/tests/unit/check-runner.test.ts, packages/cli/tests/unit/authority-command-boundary-finalization.test.ts, packages/cli/tests/unit/sense-adapter-acceptance.test.ts, packages/skills/tests/, packages/skills/tests/unit/authority-host-test-scope.ts, packages/authority/tests/unit/authority-host-test-scope.ts, packages/cli/src/services/check-runner/runner-execution.ts, packages/sensors/src/sensor-reading.ts.

- [TASK-0637](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0637.md) — architect, architect/high: Declare a reproduction matrix for all five cases named in #246: translation overlay, skills teardown ENOTEMPTY, check-runner timeout, authority disposal order, negative duration. Specify concurrent companion suite and fixed repetition protocol, timing source and cleanup ownership; a missed fixture path is a boundary replan.
- [TASK-0638](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0638.md) — inspector, worker-high/high: Give each run its own files/scope, await teardown, restore clocks and dispose authority boundaries in tested order. Repeat every named case while a separate suite runs, retain complete result count and failures, and preserve substantive assertions.
- [TASK-0639](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0639.md) — engineer, worker-high/high: Change production cleanup/timing only where the Inspector demonstrates a plant defect and the contract declares its solution; use monotonic duration as appropriate. A fixture-only fix requires a documented no-change Engineer outcome, never unrelated code edits.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

## R-0604 — Finish exact closure membership and crash recovery

Eliminate substring closure acceptance and expose a bounded append-only newest-line repair.

Source dependency phases: R-0601. R-0608 requires actual R-0607 closure and publication, not just a source checkpoint.
Accepted records: ADR-EVI-0004, ADR-EVI-0005.
Actual closure checks: universal close checks plus test:loop, test:evidence, test:cli.
Required effects at actual closure: none. OE-02/OE-03 are already recorded; all other effects require observed completion.

### CTG-0641 — Make governance integrity use exact terminal closure rows

Issues: [238](https://github.com/aarusso-nyx/devai/issues/238).
Wave predecessors: none. Shared lock prefixes serialize.
Gate members: test:loop.
Lock scopes: docs/dev/operations/open-issue-closure-campaign/closure-membership.md, packages/loop/tests/unit/round-archive-history-boundaries.test.ts, packages/loop/tests/unit/cmp0006-exact-closure-integrity.test.ts, packages/loop/src/governance-ledger/index.ts, packages/loop/src/governance-ledger/render.ts, packages/loop/src/round-lifecycle/index.ts.

- [TASK-0641](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0641.md) — architect, architect/high: Declare one exact terminal-row parser shared by round seal and roundRecordIntegrity; the closure and round ID cells, terminal flag and supersession state must agree, with existing refusal identities retained.
- [TASK-0642](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0642.md) — inspector, worker-high/high: Replace legacy prose-only fixtures with canonical rows and attack prefix IDs, prose, superseded-only rows, wrong round, malformed row and ambiguous terminal membership; each refuses with ROUND_PHASE_CLOSURE_UNRESOLVED.
- [TASK-0643](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0643.md) — engineer, worker-high/high: Use the same exact-row semantics in roundRecordIntegrity as the seal and preserve archive history and all proof immutability checks; no direct edit of derived indexes.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

### CTG-0642 — Recover only the newest unanchored proof line through the CLI

Issues: [239](https://github.com/aarusso-nyx/devai/issues/239).
Wave predecessors: CTG-0641. Shared lock prefixes serialize.
Gate members: test:evidence, test:cli.
Lock scopes: docs/reference/cli/evidence-verify.md, docs/reference/cli/evidence-render.md, packages/evidence/tests/proof-line-anchoring.test.ts, packages/cli/tests/unit/cmp0006-evidence-recovery.test.ts, packages/cli/src/commands/evidence/facade-collect-record.ts, packages/cli/src/commands/evidence/facade.ts, packages/evidence/src/evidence/verb-evidence.ts.

- [TASK-0644](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0644.md) — architect, architect/high: Document the exact accepted ADR-EVI-0005 flag spelling and newest-line-only contract in the evidence reference; describe the options as proposed until the implementation lands. No new public action or role widening.
- [TASK-0645](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0645.md) — inspector, worker-high/high: Crash the proof writer between line and chain append, invoke the implemented CLI recovery and verify chain success; check immutable old bytes, exact one append, safe retry and every ADR-EVI-0005 negative case.
- [TASK-0646](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0646.md) — engineer, worker-high/high: Expose the approved mode on evidence record, revalidate immutable newest bytes and append the missing anchor via the typed library; refuse path escapes, older orphans and ambiguous anchors without mutation.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

## R-0605 — Align CLI refusals and complete the references

Refuse inline presets consistently, emit all selected readings and make current references complete.

Source dependency phases: R-0601, R-0602, R-0603, R-0604, R-0606. R-0608 requires actual R-0607 closure and publication, not just a source checkpoint.
Accepted records: ADR-SCR-0011, ADR-AUT-0002, ADR-CHK-0005, ADR-GOV-0021, ADR-MDL-0003.
Actual closure checks: universal close checks plus test:cli, error-codes:check.
Required effects at actual closure: none. OE-02/OE-03 are already recorded; all other effects require observed completion.

### CTG-0651 — Refuse inline presets consistently in selection and admission

Issues: [252](https://github.com/aarusso-nyx/devai/issues/252).
Wave predecessors: none. Shared lock prefixes serialize.
Gate members: test:cli.
Lock scopes: docs/reference/cli/sense-presets.md, docs/dev/operations/open-issue-closure-campaign/sense-refusal-contract.md, packages/cli/tests/unit/sense-selection-authority-values.test.ts, packages/cli/tests/unit/sense-selection-authority-depth.test.ts, packages/cli/tests/unit/cmp0006-inline-preset-refusal.test.ts, packages/cli/src/command-router.ts, packages/cli/src/authority/sense-selection.ts.

- [TASK-0651](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0651.md) — architect, architect/high: Record the Owner refusal decision and one public refusal identity (proposed existing SENSE_SELECTION_INVALID); --preset <name> is supported and --preset=<name> is unsupported. Keep action registry effect resolution fail-closed.
- [TASK-0652](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0652.md) — inspector, worker-high/high: Prove the inline form refuses identically at selection and schema admission, named invalid presets refuse, spaced presets preserve exact population/effect resolution and no member runs after rejection.
- [TASK-0653](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0653.md) — engineer, worker-high/high: Unify selection/admission refusal for the inline form without broadening selection syntax or authority; preserve the supported spaced form and all existing named-preset negative cases.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

### CTG-0652 — Emit the missing-input sensor reading and a useful refusal hint

Issues: [241](https://github.com/aarusso-nyx/devai/issues/241), [254](https://github.com/aarusso-nyx/devai/issues/254).
Wave predecessors: CTG-0651. Shared lock prefixes serialize.
Gate members: test:cli.
Lock scopes: law/policy/sensor-notes/action_effect_inference.md, docs/dev/operations/open-issue-closure-campaign/sense-refusal-contract.md, packages/cli/tests/unit/sense-adapter-acceptance.test.ts, packages/cli/tests/unit/cmp0006-sense-refusal-hints.test.ts, packages/cli/tests/unit/cmp0006-action-effects-missing-input.test.ts, packages/cli/src/commands/sense/adapter-readers.ts, packages/cli/src/authority/authority-results.ts, packages/cli/src/commands/sense/adapters.ts.

- [TASK-0654](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0654.md) — architect, architect/high: Specify a schema-valid UNKNOWN missing-registry reading with a named code for action_effect_inference in a clean adopter, distinct from malformed explicit registry failure and substantive framework findings. Define sense hints by sensor kind and declared input; retain descriptor wording for check.
- [TASK-0655](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0655.md) — inspector, worker-high/high: Prove a clean adopter produces exactly one valid reading for that selected member, absent default policy never raises ENOENT, malformed or missing explicit input remains a named refusal/failure, and check/sense hints name their correct contract.
- [TASK-0656](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0656.md) — engineer, worker-high/high: Guard the default missing registry and return the declared UNKNOWN reading; improve sensor-specific refusal context and rendering without assuming a descriptor or widening process admission.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

### CTG-0653 — Make emitted error-code discovery exhaustive and deterministic

Issues: [250](https://github.com/aarusso-nyx/devai/issues/250).
Wave predecessors: CTG-0652. Shared lock prefixes serialize.
Gate members: test:root.
Lock scopes: docs/dev/operations/open-issue-closure-campaign/error-reference-contract.md, tests/contract/cmp0006-error-code-reference.contract.test.ts, scripts/generate-error-code-reference.mjs.

- [TASK-0657](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0657.md) — architect, architect/high: Declare scan roots covering every CLI-reachable code source and operational script, including campaign checker kebab-case codes and TASK_REGISTRY_IDENTITY_MISMATCH, RELEASE_PACKED_ADOPTER__, SENSOR_KIND_NOT_IN_SCHEMA, PROOF__, INTENT__, COVERAGE__ and BUILD_ARGV_CONFLICT. Resolve the reported TASK_REGISTRY name against current TASK_MODEL_REGISTRY spelling rather than fabricate an entry.
- [TASK-0658](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0658.md) — inspector, worker-high/high: Use a fixture root with one representative code per source/grammar, dynamic-family declarations, unknown prefixes, escaped examples and stable ordering; prove emitted codes are included without treating every string as an error.
- [TASK-0659](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0659.md) — engineer, worker-high/high: Extend deterministic roots and grammar under the declared code-source contract. The test exercises an isolated fixture; the canonical generated docs page is owned by following Architect TASK-06510.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

### CTG-0654 — Regenerate the canonical error reference after all code changes

Issues: [250](https://github.com/aarusso-nyx/devai/issues/250).
Wave predecessors: CTG-0653. Shared lock prefixes serialize.
Gate members: docs-links.
Lock scopes: docs/reference/error-codes.md.

- [TASK-06510](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-06510.md) — architect, architect/high: Generate the canonical error page from the accepted generator, include every declared CLI-emittable code and verify byte freshness. No manual entries or source changes.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

### CTG-0655 — Retire the midpoint claim from current calibration documentation

Issues: [251](https://github.com/aarusso-nyx/devai/issues/251).
Wave predecessors: CTG-0654. Shared lock prefixes serialize.
Gate members: docs-links.
Lock scopes: docs/dev/operations/, docs/theory/, docs/reference/, docs/adopters/.

- [TASK-06511](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-06511.md) — architect, architect/high: Locate every current midpoint assertion in unindexed documentation and generated projections. State rejected tie-breaker replies escalate with confidence 0; preserve labeled historical facts and unrelated 0.5 values. If the exhaustive search finds another owning page, stop for a declared boundary addition before editing it.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

## R-0606 — Prove the live review bridge

Finish offline host-envelope safety and obtain separately authorized live verdicts on both hosts.

Source dependency phases: R-0601. R-0608 requires actual R-0607 closure and publication, not just a source checkpoint.
Accepted records: ADR-MDL-0003, ADR-GOV-0023.
Actual closure checks: universal close checks plus test:skills, test:schemas.
Required effects at actual closure: OE-04. OE-02/OE-03 are already recorded; all other effects require observed completion.

### CTG-0661 — Make structured review transport ready for an authorized live campaign

Issues: [249](https://github.com/aarusso-nyx/devai/issues/249).
Wave predecessors: none. Shared lock prefixes serialize.
Gate members: test:skills, schemas.
Lock scopes: law/policy/sensor-notes/llm_judge.md, docs/dev/operations/open-issue-closure-campaign/live-review-preflight.md, packages/skills/tests/model-bridge/structured-extraction.test.ts, packages/skills/tests/operations/model-bridge.test.ts, packages/schemas/tests/unit/cmp0006-provider-review-projection.test.ts, tests/fixtures/review-replies/cmp0006-claude-envelope.json, tests/fixtures/review-replies/cmp0006-codex-events.jsonl, tests/fixtures/review-replies/README.md, packages/skills/src/model-bridge/index.ts, packages/skills/src/model-bridge/extract.ts.

- [TASK-0661](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0661.md) — architect, architect/high: Finalize the exact accepted envelope completion, no-tool/no-MCP isolation, fixture byte stream/digest and provider projection contract. Record installed host versions/help and isolated configuration locations in the live preflight without assuming --tools alone disables MCP.
- [TASK-0662](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0662.md) — inspector, worker-high/high: Prove completed structured envelopes work but real tool calls, inherited MCP, errors, truncation and malformed strict output fail; fixtures label envelope bytes and exact extractor reply bytes independently. Test both transports offline.
- [TASK-0663](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0663.md) — engineer, worker-high/high: Implement host completion mapping, isolation and strict schema projection/normalization under ADR-MDL-0003. Produce the preflight-ready adapter; never initiate a live provider call inside offline tests or claim mocked replies prove live readiness.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

## R-0607 — Prepare and authorize the shipping release and Pages deployment

Bind closure, receipt, release and site evidence to the actual reviewed heads.

Source dependency phases: R-0602, R-0603, R-0604, R-0605, R-0606. R-0608 requires actual R-0607 closure and publication, not just a source checkpoint.
Accepted records: ADR-REL-0031, ADR-CHK-0006, ADR-AUT-0002, ADR-REL-0032.
Actual closure checks: universal close checks plus release:static-integrity.
Required effects at actual closure: OE-05, OE-06, OE-07. OE-02/OE-03 are already recorded; all other effects require observed completion.

### CTG-0671 — Prepare exact release prerequisites and receipt disposition

Issues: [243](https://github.com/aarusso-nyx/devai/issues/243).
Wave predecessors: none. Shared lock prefixes serialize.
Gate members: adrs, docs-links.
Lock scopes: docs/dev/operations/open-issue-closure-campaign/release-handoff.md.

- [TASK-0671](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0671.md) — architect, architect/high: Produce a concrete exact-candidate release handoff after preceding rounds close: check mandatory floor first, identify version intent under current policy, preserve the R-0401 receipt binding, enumerate signer/export/rehearsal/publication boundaries and retained artifacts. OE-05 and OE-06 remain Owner actions.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

### CTG-0672 — Prepare the exact Pages audit and deployment handoff

Issues: [244](https://github.com/aarusso-nyx/devai/issues/244).
Wave predecessors: CTG-0671. Shared lock prefixes serialize.
Gate members: adrs, docs-links.
Lock scopes: docs/dev/operations/open-issue-closure-campaign/pages-handoff.md.

- [TASK-0672](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0672.md) — architect, architect/high: Prepare the selected control-commit audit identities, exact site bytes and reconciliation/readback checklist; require a verified journal record and live content digest. The observed gh-pages 404 and an old green run are insufficient. OE-07 performs audit-variable updates and deployment separately.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

## R-0608 — Repin from the published artifact and prove adopter delivery

Complete verifier step 4 and obtain independent DETRAN adoption confirmation.

Source dependency phases: R-0607. R-0608 requires actual R-0607 closure and publication, not just a source checkpoint.
Accepted records: ADR-REL-0031, ADR-CHK-0006, ADR-EVI-0004, ADR-EVI-0005, ADR-AUT-0004.
Actual closure checks: universal close checks plus release:static-integrity, ci-economy.
Required effects at actual closure: OE-08, OE-09. OE-02/OE-03 are already recorded; all other effects require observed completion.

### CTG-0681 — Prepare the atomic published-verifier repin and DETRAN delivery

Issues: [243](https://github.com/aarusso-nyx/devai/issues/243), [245](https://github.com/aarusso-nyx/devai/issues/245).
Wave predecessors: none. Shared lock prefixes serialize.
Gate members: adrs, docs-links.
Lock scopes: law/policy/trusted-local-rc-verifier-package.json, .github/workflows/devai-ledger-verify.yml, .github/workflows/release.yml, docs/dev/operations/open-issue-closure-campaign/detran-notice.md, docs/dev/operations/open-issue-closure-campaign/repin-manifest.md.

- [TASK-0681](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0681.md) — architect, architect/high: Only after the cumulative remediation PR merges and the shipping release is immutable under OE-06, prepare the second PR from the current fetched main. Read every package, release_source commit/tree, provenance, payload-count and selector identity from that immutable artifact. Repin the trusted policy and its two workflow restatements in one narrow law(release) commit using the deterministic helpers delivered by CTG-0624; no manual generated bytes. Keep supporting manifest/notice documentation in separate single-family commits. Verify workflow consistency and record OE-08 variable readback after authorized integration. Prepare the DETRAN notice; OE-09 alone sends it and obtains clone confirmation. No generator or sibling source change is permitted in the repin PR.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.

## R-0609 — Verify issue closure and reconcile the final live backlog

Accept immutable evidence, close all snapshot issues under exact authority, and account for arrivals/reopens.

Source dependency phases: R-0608. R-0608 requires actual R-0607 closure and publication, not just a source checkpoint.
Accepted records: ADR-SCR-0012, ADR-EVI-0004, ADR-EVI-0005, ADR-MDL-0003, ADR-REL-0031.
Actual closure checks: universal close checks plus campaign:check.
Required effects at actual closure: OE-10, OE-11. OE-02/OE-03 are already recorded; all other effects require observed completion.

### CTG-0691 — Ratify the complete coverage and issue closure evidence

Issues: [233](https://github.com/aarusso-nyx/devai/issues/233), [234](https://github.com/aarusso-nyx/devai/issues/234), [235](https://github.com/aarusso-nyx/devai/issues/235), [236](https://github.com/aarusso-nyx/devai/issues/236), [237](https://github.com/aarusso-nyx/devai/issues/237), [238](https://github.com/aarusso-nyx/devai/issues/238), [239](https://github.com/aarusso-nyx/devai/issues/239), [240](https://github.com/aarusso-nyx/devai/issues/240), [241](https://github.com/aarusso-nyx/devai/issues/241), [242](https://github.com/aarusso-nyx/devai/issues/242), [243](https://github.com/aarusso-nyx/devai/issues/243), [244](https://github.com/aarusso-nyx/devai/issues/244), [245](https://github.com/aarusso-nyx/devai/issues/245), [246](https://github.com/aarusso-nyx/devai/issues/246), [247](https://github.com/aarusso-nyx/devai/issues/247), [248](https://github.com/aarusso-nyx/devai/issues/248), [249](https://github.com/aarusso-nyx/devai/issues/249), [250](https://github.com/aarusso-nyx/devai/issues/250), [251](https://github.com/aarusso-nyx/devai/issues/251), [252](https://github.com/aarusso-nyx/devai/issues/252), [253](https://github.com/aarusso-nyx/devai/issues/253), [254](https://github.com/aarusso-nyx/devai/issues/254).
Wave predecessors: none. Shared lock prefixes serialize.
Gate members: adrs, docs-links.
Lock scopes: docs/dev/operations/open-issue-closure-campaign/closure-register.md, product/campaigns/CMP-0006-open-issue-closure/campaign.json, product/campaigns/CMP-0006-open-issue-closure/coverage.md, product/campaigns/CMP-0006-open-issue-closure/revalidation.json.

- [TASK-0691](../../../../product/campaigns/CMP-0006-open-issue-closure/prompts/TASK-0691.md) — architect, architect/high: Prepare and verify the bounded final accounting artifacts alongside the repin candidate. After the second PR actually merges, re-fetch issue bodies and all paginated comments and verify each coverage row against observed merged heads, tests, readings, releases, Pages journal and DETRAN confirmation. Final runtime evidence comes only from OE-10 registered verbs, and OE-11 alone authorizes issue closure. Do not fabricate a future merge SHA, close a round from a checkpoint, or create a third implementation PR; any newly discovered source repair requires a bounded amended plan. Preserve #253 not_planned and reconcile arrivals/reopens.

Acceptance requires each declared outcome, its hashed prompt commands and negative counterexamples on the exact candidate. Final admission runs all declared acceptance and the mandatory floor. Implementation, live-provider, release, deployment and adopter evidence are separate; no stub or source-only test replaces the latter.
