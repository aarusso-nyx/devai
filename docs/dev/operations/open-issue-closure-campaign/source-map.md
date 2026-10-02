# Verified baseline source map

All spans refer to 180a122787193f9bdfce9b7f4cd5600e85ae7854. They locate work;
they never freeze a source span across integration. Run graft callers before
editing a symbol and graft grep for exhaustive occurrences. Re-check spans and
boundaries at task open. No source implementation was changed during drafting.

| Issue     | Verified entry point and reference                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #238      | packages/loop/src/governance-ledger/index.ts:397-453, roundRecordIntegrity, includes(phaseClosure) at 439; archive-history test fixture                                               |
| #239      | packages/evidence/src/evidence/verb-evidence.ts:45-98, appendVerbEvidence; packages/cli/src/commands/evidence/facade-collect-record.ts:33-52 and 322-442                              |
| #236/#242 | packages/sensors/src/test-coverage-depth.ts:143-327, measureTestCoverageDepth; producer failure at 219; release-lifecycle-execution and sense-adapter-acceptance tests                |
| #249      | packages/skills/src/model-bridge/index.ts:86-96 and 98-218; packages/schemas/src/reply-extract.ts:155-232                                                                             |
| #254      | packages/cli/src/commands/sense/adapter-readers.ts:228-253, actionEffectInference; adapters.ts:358                                                                                    |
| #252      | packages/cli/src/command-router.ts:139-433, SENSE_SELECTION_INVALID at 367; authority/sense-selection.ts:190-208                                                                      |
| #241      | packages/cli/src/authority/authority-results.ts:69-123, authorityRemediation                                                                                                          |
| #237      | packages/loop/src/inventory/regen.ts:89-142, regenerateInventory; bound observation path and inventory-readers must be traced before mutation                                         |
| #234/#247 | .github/workflows/site-publish.yml and pull-request-checks.yml; group exists with cancellation disabled; bootstrap cache retains only pr-bootstrap while runtime links workspace dist |
| #235      | law/invariants/INV-DEVAI-002.json and INV-HARNESS-006.json; law/trace.json; harness-invariant-alignment-workflow.ts                                                                   |
| #250      | scripts/generate-error-code-reference.mjs:1-60; sourceRoots limited to cli/authority/utils and filesUnder selects only .ts                                                            |
| #240      | ADR-EVI-0001 IA-005 and ADR-SCR-0008 final Decision paragraph/IA-006; sensor-registry maps adherence F4:T4, regeneration F4:T9                                                        |
| #243      | docs/dev/operations/release-discipline.md:431-474; trusted verifier package remains 1.5.4, vendored source is 8b215d706a828af7361f9c6799b9cb0a30c9d00b                                |
| #245      | DETRAN fixtures and PROVENANCE.md under tests/fixtures/closures and proof-baseline; read-only issue #168/#169 addenda and CMP-0005 closure                                            |
| #251      | Exhaustive unindexed docs search, preserving historical claims; rejected reply confidence 0 is current; current calibration owner paths must be confirmed before mutation             |

No guessed internal command or host flag is an acceptance instruction. Current
package scripts supply campaign:check, build, release:bootstrap, focused Vitest,
release:static-integrity, error-codes:generate/check, and formatting checks.
Registered public action discovery and installed --help precede runtime use.
Proposed recovery syntax is explicitly unavailable until CTG-0642 lands.

Integration support: scripts/check-commit-range.mjs:87-113 performs class-only pairing; packages/cli/src/services/ci-scaffold/index.ts:36-68 emits ledger/attested-RC output; .github/workflows/release.yml:245 requires main ancestry; docs/dev/operations/release-discipline.md:458-473 requires post-publication repin. CTG-0624 owns the bounded schema, tests and implementation seams declared in its prompts.
