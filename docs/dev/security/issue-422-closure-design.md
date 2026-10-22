# Issue 422 runtime boundary and closure design

Status: revised design awaiting independent human security disposition. This is not an approval, native implementation or release authorization. The original loader-read admission proposal is withdrawn; its review and evidence remain preserved in issue #422.

## Evidence and scope

The Node 24.20.0 comparison passed both frozen commits without native source changes: local closures had 18 PASS nodes each; required affected gates had 13 PASS nodes on a1521a78 and 18 on f26f26bc. CLI and root suites executed freshly in all four passes. Captures from Node 24.15.0 remain historical. These results establish successful checks on the approved runtime, not acceptance of the original security design or fresh DETRAN scorecard readings.

This package addresses recurrence prevention and the residual conditions of the human review. It does not implement internal-loader read admission or the alternative context.source path. Existing open/descriptor guards, trustedReadDepth boundaries, package/candidate validation, source observation, effects and permissions stay unchanged. C6 remains blocked; this is not a review request for the withheld service/custody prototype.

## Proposed changes for review

1. Repository pre-push: before fetching, bootstrapping or running checks, require the executing Node version to match the existing canonical toolchain pin. Missing/malformed pins or a mismatch refuse the enabled preflight with an actionable diagnostic. Do not switch runtimes silently or disable the hook. The unopted-in hook keeps its existing inert behavior.
2. Active native input preload: immediately after the existing unsupported emitter is available, refuse process.version other than v24.20.0 with an explicit unsupported runtime operation, before reading private adapter/service context, installing loader hooks or activating factories. Diagnostic imports without a governed trace/nonce keep their existing behavior. This adds a refusal; it grants no runtime identity or execution origin. Existing host custody, exact executable identity and child flag controls remain mandatory.
3. Inspector regressions: approved-runtime positives, explicit refusal for unapproved runtime, no module/config execution after refusal, retained-reference attempts through an unapproved child CJS preload with binary and UTF-8 encodings, and tampering with the sole pinned framework preload. Prove refusal before that preload executes, not detection by the low-level open guard. Keep existing direct descriptor refusal and native provenance tests.
4. Documentation: explicitly state that early-preload provenance and the fixed CJS preload identity prevent retained references from gaining native standing. The open guard alone is not a universal retained-reference control. Host compromise or code running before the trusted preload is outside this in-process observation guarantee and cannot gain standing from a diagnostic trace.

The native runtime check is intentionally fixed to the already approved native runtime; adopter configuration cannot select another admitted runtime. A regression binds this literal to the canonical provider toolchain. The pre-push check reads the repository toolchain and only chooses whether to refuse the maintainer operation; it cannot confer native authority.

## Disposition of review findings

| Finding                                 | Proposed closure disposition                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 wrong runtime                        | Measured operational correction complete. Add early preflight refusal to prevent an accidental repeat.                                                                                            |
| A2 unverifiable internal read admission | Withdraw that proposal; no implementation or stack-based authority.                                                                                                                               |
| A3 source-first alternative             | Not needed to resolve the measured failures and excluded from implementation. No undocumented context.source dependency or new loader self-test is introduced.                                    |
| A4 retained-reference control           | Correct the control description and add adversarial regressions of the existing preload admission boundary. No promise that arbitrary pre-instrumentation references are universally intercepted. |

The reviewer must explicitly decide whether source-divergence, swap-during-next and ignored-context.source cases are inapplicable because this package introduces no source injection path. This document does not waive those cases on its own. Any need to alter loader source delivery or read authority returns to a new bounded packet and new review.

## Owned paths and stopping conditions

Proposed implementation paths: scripts/pre-push-preflight.mjs; tests/integration/pre-push-preflight.integration.test.ts; packages/cli/src/native-input-provenance.ts; focused tests under packages/cli/tests/unit/; this security document and its index. No changes to the action registry, contracts, permissions, thresholds, service/custody protocol, signing configuration, release policy or DETRAN are permitted by this packet.

No native implementation begins before a favorable independent human disposition bound to this revised packet hash. A contrary or incomplete disposition blocks the dependent native change. Broader changes require a new packet. The operational pre-push runtime check and its integration tests can proceed separately without changing native observation or authority.

After favorable disposition, implement only accepted items; run meaningful focused positive/negative tests, build/type/lint checks and the mandatory affected gate in Node 24.20.0, serially. Preserve all old outcomes. Any resulting native code needs an independent implementation review before integration. PR-only integration and green mandatory checks remain required. No new package release, adoption, native producer activation or C6 clearance follows from closing this issue.

## Human disposition requested

Reviewer: @aarusso-nyx, designated by the Owner. Record reviewer independence, the exact packet hash, accepted/rejected items, rationale and conditions. Accepting this bounded correction does not approve the withdrawn design or C6. Issue closure requires verified implementation of every accepted condition and its integration status; it must not use a passing gate to manufacture a missing security approval.
