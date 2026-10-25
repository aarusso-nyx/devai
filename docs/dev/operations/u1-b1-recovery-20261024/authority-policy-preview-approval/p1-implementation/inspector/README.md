# Inspector return — P1 bounded implementation, public acceptance RED

Current six-path verification: **145 passed, 7 failed** in
[final-six-paths-extended.txt](final-six-paths-extended.txt), through the unchanged repository
validation runner, `--maxWorkers 1`. No test timeout, threshold or assertion was
relaxed; nothing was skipped. ESLint and Prettier check pass on all six owned test
paths. This is **partial implementation, not acceptance or permission for live
use**. Binding, integration, U1/B1 runtime, release and every DETRAN effect remain
held.

Five failures preserve the required READY/confirmation contract: four handler I/O
flows and the actual public action-output wrapper acceptance. The current code
safely refuses before artifact construction because the unchanged action-output
boundary captures both stdout and stderr until the handler Promise settles. A
separate passing counterexample exercises that actual boundary and shows neither
READY nor prompt reaches the caller during the wait. Its eventual mixed-channel
result becomes an output-contract violation. Direct-handler tests that passed
before the safe guard, in `command-io-first.txt`, are historical observations;
they do not establish current public behavior.

The remaining two failures are unchanged shard09 constitution-binding assertions:
this worktree has no resolvable installed canonical Constitution asset. The exact
error is `devai init bind --constitution: no installed Constitution text could be
resolved`. No fake package was supplied to those legacy tests, no asset was built
or installed, and their assertions remain intact. These environmental failures
are distinct from the two held binding failures in the orchestrator's historical
selection (real policy absent and real 1.1.0 pin versus 1.2.0 source).

## Evidence and genuine counterexamples

- `public-route-red.txt`: authentic preimplementation CAC registration failure,
  `Unknown option --reviewAuthorityPolicy`; the ordinary advisory plan remains
  exactly `{ "plan": "authority-policy" }`.
- `lifecycle-publication-first.txt`: mutable ready input aliased into the displayed
  target; the independent test caught `foreign` rather than the fixed target.
  Engineer corrected constructor-time defensive copying.
- `first-production-green-attempt.txt`: actual successor publication initially
  failed with `AUTHORITY_DECISION_RESOLUTION_FOREIGN_POLICY`; refreshing sources
  alone left the bounded plan's envelope on the predecessor. Engineer corrected
  final actual-state plan registration. The final real guarded fixture create
  passes without weakening that test.
- `public-boundary-held-red.txt` and the final log: required public READY remains
  RED under the explicit safe guard. This is not replaced by the passing
  fail-closed assertion.
- `synthetic-fixture-ready.json`: full ready payload, immutable bytes in base64,
  whole artifact SHA256, complete before/prospective inputs, real invocation and
  construction provenance from a **synthetic disposable installed-layout fixture**.
- `synthetic-fixture-completion.json`: exact real guarded create result, decimal
  filesystem identity, and before/after inventories. Only the declared policy
  target differs after the separately simulated precursor.
- `evidence-index.json`: exact argv, source hashes, raw evidence hashes and
  independently recomputed plan/artifact digests.

The fixture import-location and canonical-resolver mocks are testing seams. They
are not a caller override, a live installed candidate, an admitted package,
release evidence, a live preview or an authorization token. The fixture directories
were removed after each test. No preview or publication ran against DEVAI's actual
binding files or any sibling repository.

Final retained synthetic fixture identities:

- Plan: `8f98f972a6b07c3cd3844bda2c27f7e2e6a1eb4ac1b4c22496410118b10fe089`
- Artifact: `a7e34dcecf57943cff34583fdd48345575c20d41a29fb24237f1b3d6d5d964d9`
- Exact bytes: `69922`
- Constitution: `1.2.0`,
  `d5dfdc972161e0f848dd859be7bbfa510973c5c9a449a0f9e6b8960e4f5ac96a`

The original 124-pass/7-failure six-path result remains byte-preserved in
`final-six-paths.txt`. The extended run adds independent counterexamples for
fresh review from an already exact successor, wall-clock jumps, complete-token
mutations, receipt/source/host/dependency drift, FIFO/ancestor symlink targets,
preview mutator instrumentation and real child-process SIGKILL after link.
`extended-counterexamples-first.txt` captures five genuine equals/camelCase
selector dispatch defects. Engineer fixed the admitted strict-selection trigger;
all six exact-spelling variants now refuse before dispatch. Original and current
fixture reports are both preserved (`*.initial.json` and current `*.json`).

`../existing-issuer-boundaries.txt` is the orchestrator's separately run unchanged
lower-boundary selection: 120 passed, zero failed across issuer contracts,
robust decision issuer, bounded batch, machine context and boundary runtime.
Those foreign/expired/role/one-use checks do not substitute for missing integrated
public positive-review/expiry assurance.

## Acceptance standing for all 24 packet rows

A passing private or lower primitive check does not close a public protocol row.
`PARTIAL` names the tested portion and the remaining gap; none is silently waived.
The approved packet's broader fault/missing-check-counterexample requirement is
not exhaustively completed for every safety assertion.

The row IDs below follow the frozen approval acceptance matrix. Several source
test names used different P1-02 through P1-07 labels during authoring; those names
are descriptive test labels, not an authoritative remapping. Their actual
assertions govern the evidence. Frozen source tests and raw logs were not edited
to relabel them or change any result.

| Row   | Current evidence and remaining work                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-01 | PARTIAL. Authentic preimplementation unknown-option public-route RED is retained, and ordinary advisory regression passes. Whole-byte public preview remains unavailable; no positive public READY acceptance is inferred.                                                                                                                                                                                       |
| P1-02 | PARTIAL. Synthetic broker projection keeps actual 1.1.0 pin/project/receipt unchanged and constructs a policy binding exact 1.2.0, with receipt-present and receipt-absent fixtures. Private report contains exact prospective inputs and policy bytes. The required public READY-before-any-write path remains RED; positive transient-effect instrumentation remains incomplete.                               |
| P1-03 | PARTIAL overall; private fresh-successor scenario PASS. A new broker starts a new review from exact actual successor inputs, before/prospective manifests agree, no files revert/change, fresh invocation/plan differ, old confirmation refuses, and another fresh review publishes exact bytes once. Full public READY/confirmation qualification remains held.                                                 |
| P1-04 | PARTIAL. Before/after inventories and guarded-host plus imported raw-filesystem mutator spies report zero mutation during private prepare/start/cancel; public safe guard invokes no constructor. Strict selector table refuses --round. This is scoped instrumentation, not a full OS syscall trace. Positive public wait/expiry, attempted tracking/state writes and all rejection variants remain incomplete. |
| P1-05 | PASS for source public selector grammar: missing role/write, wrong role, machine/session declarations, conflicting/tier/non-JSON/human/replay/output/duplicate/unknown flags and equals/camelCase aliases refuse before dispatch. Authentic five-case alias RED was fixed within the approved router path. Old advisory behavior remains exact. Installed qualification is held.                                 |
| P1-06 | PARTIAL. Non-TTY refuses before preparation; private cancellation/disposal prevents publication/retry, and async operation remains scoped through wait. Required positive command EOF/cancel and timeout flows remain RED after the safe guard. Interrupt and rejection/cleanup combinations are not exhaustively tested; mocked terminal properties are fixture seams, not a live PTY run.                      |
| P1-07 | PARTIAL. Private ready base64/size/whole SHA256, canonical whole-plan digest, deep freeze and constructor-time byte/document defensive copying pass, including the captured mutable-ready-alias counterexample. Full modified decoded-byte/digest/length/target/serialized-ready attack combinations and public confirmation pipeline remain incomplete; public READY is held.                                   |
| P1-08 | PARTIAL. Private foreign invocation confirmation, cloned object and detached method refuse. Serialized report possession cannot invoke a live method. Full installed public export/replay qualification remains held.                                                                                                                                                                                            |
| P1-09 | PARTIAL overall; private monotonic lifetime PASS. Controlled elapsed 0/299999 accepted and 300000/300001 refused; forward/backward wall-clock jumps cannot expire or extend the monotonic handle. No five-minute sleep or receipt TTL change. Public expiry/cleanup remains RED; unchanged lower receipt/issuer tests pass separately.                                                                           |
| P1-10 | PARTIAL overall; private exact confirmation negatives PASS. Empty/yes/omitted literal/plan-only/artifact-only and full tokens with wrong plan hash, wrong artifact hash, lower-case literal or extra whitespace refuse and dispose; prior invocation confirmation also refuses. Positive public confirmation flow remains RED.                                                                                   |
| P1-11 | PARTIAL. Source checkout without synthetic test seam refuses; fixture package-code and dependency-code drift invalidate confirmation. Actual admitted distributable, registry/rule/validator mutation combinations and installed assets/help qualification remain held.                                                                                                                                          |
| P1-12 | PARTIAL overall; listed private stale inputs PASS. Pointer, source, project, partial precursor, index, HEAD, installed code, lock, config/pin parent identities, receipt, receipt source, host mode and dependency drift all refuse without writes. Full public cross-host/admitted-package integrated transition assurance remains held.                                                                        |
| P1-13 | PASS for bounded fixture admission: extension receipt, source authority block, missing/drifted source and host-integrated declaration refuse without altering files.                                                                                                                                                                                                                                             |
| P1-14 | PARTIAL. Pending actual precursor refuses; exact fixture successor permits guarded publication. Expiry/process death after the real separately approved precursor and its custody evidence remain held.                                                                                                                                                                                                          |
| P1-15 | PARTIAL. Actual-state checks and a fresh ordinary final bounded plan allow the real fixture create; the stale-envelope counterexample is retained. Exhaustive final decision-expiry/foreign-grant instrumentation remains required.                                                                                                                                                                              |
| P1-16 | PARTIAL. Real broker/guarded publisher creates exactly displayed bytes once after actual fixture successor; all other fixture files unchanged. Public completion pipeline acceptance remains held.                                                                                                                                                                                                               |
| P1-17 | PARTIAL overall; private file/malformed/symlink/directory/FIFO existing targets and symlinked configuration ancestor refuse without touching targets/referents; parent inode replacements invalidate. Fully schema-valid equal-semantics existing-policy and other ancestor combinations remain unexecuted.                                                                                                      |
| P1-18 | PARTIAL. Two independent real processes contend through the unchanged no-replace primitive: exactly one winner and one EEXIST; foreign target preserved. Two complete broker/public reviews reaching READY remain held.                                                                                                                                                                                          |
| P1-19 | PARTIAL. Real fixture pre-link open/write/fsync/link faults leave no target; simulated post-link crash and actual independent child self-SIGKILL after real link preserve whole target/staged inode. Cleanup/fsync uncertainty preserves bytes; handle propagates uncertainty without retry. Full broker/public crash/fault scheduling remains held.                                                             |
| P1-20 | PARTIAL. Private single-use/cancelled/uncertain handles cannot retry; existing target primitive retry refuses unchanged. Full new-process public review/inspection acceptance remains held.                                                                                                                                                                                                                      |
| P1-21 | PARTIAL. Existing stale marker refuses at entry and a new marker invalidates confirmation without deletion. No new lock path was implemented. Full positive public transient-effect instrumentation remains held.                                                                                                                                                                                                |
| P1-22 | PASS for actual/prospective shared rule/provenance equality after exact synthetic successor, both no-extension receipt populations, and invalid/drifted source admission refusal.                                                                                                                                                                                                                                |
| P1-23 | PARTIAL. Existing eight legacy shard09 cases preserved; six pass, two need installed canonical assets. New advisory/non-TTY cases pass. Full installed default/full/operational/subprocess/adopter/host/upgrade qualification remains a separate held gate.                                                                                                                                                      |
| P1-24 | PASS for the owned ADR census: 133 records / 134 files / 642 effective subjects, proposed ADR-AUT-0008 non-effective and superseding none; prior 132/131 populations and GOV-0027 checks retained. Orchestrator separately reports protected-source/manifests and generator checks.                                                                                                                              |

## Exact scope blocker returned

No `action-output.ts` change was made. Its SHA256 is
`11da5e163aa687ce01130367bf8b2715c19f56c5e8ef50bbc4e9c18459791c8d`,
Git blob `a89e3717947cb05cebca920caccb5062dec6aeca`.

Closing the public stream gap needs a separately approved addition of
`packages/cli/src/action-output.ts` and a dedicated
`packages/cli/tests/unit/action-output-authority-policy-review.test.ts` test path.
The orchestrator's proposed amendment is the reviewable authority boundary.
Current source tests intentionally retain the missing-feature RED until an exact
approved change can pass it through the real wrapper. No fallback, suppression,
bypass, binding, integration or release is inferred from private fixture success.
