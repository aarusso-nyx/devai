# Self-scorecard campaign

The plan that computes and persists the framework's own scorecard lives at
[`product/campaigns/CMP-0002-self-scorecard/campaign.json`](../../../../product/campaigns/CMP-0002-self-scorecard/campaign.json).
Its structure is `law/schemas/campaign.schema.json`; its semantics are
`law/policy/campaign-execution.json`; the vocabulary, model tiers, escalation,
and the round open and close procedures are those of the
[workflow economy campaign guide](../workflow-economy-campaign/README.md).
This page is the mandate reference and the human guide. It records the
baseline the campaign starts from and the outcome each round must move.

The six decision records the campaign implements are ADR-SCR-0001 to
ADR-SCR-0006 under `law/adr/`, all proposed at the time of writing. The
Architect sets each round's records to accepted before that round opens.

Target: a computed, persisted scorecard for the DEVAI repository in which every scoreable cell reads PASS.
Baseline measured on main `f5bd9d17` on 2026-09-26 with the trusted 1.5.4 CLI.

## 1. Where the scorecard stands

| Fact                              | Value                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Grid                              | 5 substrates x 9 properties = 45 cells                                                         |
| N/A cells                         | 2: F1:T1 (repo override, no contract-validation emitter) and F4:T5 (Article 5 degenerate cell) |
| Scoreable cells                   | 43                                                                                             |
| Persisted scorecards              | none (`record/proofs/compliance/scorecards/` holds only `.gitkeep`)                            |
| Persisted readings                | none (`.devai/state/sensor-readings/` absent, `record/proofs/freshness/readings/` empty)       |
| On-demand `audit scorecard` today | 43 UNKNOWN, 2 N/A, overall UNKNOWN                                                             |

The "44-PASS" phrase matches the law-level override alone (45 minus F1:T1). The runtime also forces F4:T5 to N/A, so the honest ceiling on this tree is 43 PASS plus 2 N/A. Round 1 below decides whether to record 44 or 43 as the target in law.

## 2. What ran today

The `sweep` preset (round R-0107, dry-run first, then a real read-only run) executed 49 sensors in 32 seconds without persisting anything. Ten write-effect sensors were excluded by the preset.

| Outcome  | Count | Sensors                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pass     | 15    | lint, test_weakening_review, trace_resolution, inventory_dep_graph, spec_idiomaticity, spec_freshness, inventory_determinism, harness_security, plant_coherence, test_coherence, harness_coverage, harness_depth, docs_drift, archive_immutability, round_record_integrity                                                                                                                 |
| review   | 18    | security_scan, inventory_api, inventory_routes, inventory_data_model, inventory_data_handling, inventory_coverage, test_coverage_depth, test_invariant_alignment, spec_alignment, plant_depth, test_idiomaticity, test_security_coverage, test_performance_coverage, test_robustness_coverage, harness_coherence, harness_invariant_alignment, harness_idiomaticity, inventory_performance |
| fail     | 8     | type_check, spec_depth, plant_coverage, spec_security_coverage, spec_performance_targets, spec_robustness_targets, decision_record_integrity, decision_citation_resolution                                                                                                                                                                                                                 |
| unknown  | 4     | perf_test, inventory_rbac, inventory_adherence, site_drift                                                                                                                                                                                                                                                                                                                                 |
| error    | 4     | harness_green_main, harness_performance, harness_robustness, action_effect_inference                                                                                                                                                                                                                                                                                                       |
| excluded | 10    | build, unit_test, integration_test, e2e_test, migration_check, inventory_regeneration (write effects); llm_judge, runtime_probe_api, runtime_probe_auth, runtime_probe_data (remote effects)                                                                                                                                                                                               |

Two of the passes are vacuous: spec_idiomaticity and spec_freshness scanned zero files because `law/invariants/` is empty. They will turn into real measurements once Round 3 populates the spec substrate.

## 3. Sensor-by-sensor: can it run today, and what it needs

### A. Runs today and passes (no work)

| Sensor                                       | Cell         | Note                                           |
| -------------------------------------------- | ------------ | ---------------------------------------------- |
| lint                                         | F2:T5        | 0 errors, 0 warnings                           |
| test_weakening_review                        | F3:T9        | 0 drift                                        |
| trace_resolution                             | F1:T3        | 0 unresolved                                   |
| inventory_dep_graph                          | F4:T1, F4:T3 | 1102 nodes, 5800 edges                         |
| inventory_determinism                        | F4:T8        | identical hashes across two runs               |
| harness_security                             | F5:T6        | all actions pinned, permissions blocks present |
| plant_coherence                              | F2:T3        | 0 incoherent directories                       |
| test_coherence                               | F3:T3        | test to source ratio 1.55                      |
| harness_coverage                             | F5:T1        | 100 percent                                    |
| harness_depth                                | F5:T2        | 3 workflows, 9 jobs                            |
| docs_drift                                   | F5:T3        | 0 drift                                        |
| archive_immutability, round_record_integrity | diagnostics  | 0 findings                                     |

### B. Runs today, needs an input or a parameter (Round 2)

| Sensor                                                                                         | Cell                       | Today                                           | Fix                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| type_check                                                                                     | F2:T8                      | fail, 1106 TS6305 errors                        | The registered command is `npx tsc --noEmit` against project references with no built `dist/`. Run after `pnpm build`, or register the workspace typecheck script the PR gate already uses.                                                                        |
| test_coverage_depth                                                                            | F3:T2                      | review, 0 lines                                 | Needs `coveragePath`. The RC already produces coverage under the evidence artifacts; wire the same JSON as the sensor input.                                                                                                                                       |
| test_idiomaticity, test_security_coverage, test_performance_coverage, test_robustness_coverage | F3:T5, F3:T6, F3:T7, F3:T8 | review, "No test files found"                   | Test discovery walks `packages/*/test`; DEVAI keeps tests in `packages/*/tests` and `tests/`. Add the roots as pack params or an adopter parameter. After discovery works, the security, performance and robustness percentages still need tagged tests (Round 5). |
| action_effect_inference                                                                        | diagnostic                 | error, missing `tsconfig.effects.json` at root  | The file lives at `tests/config/tsconfig.effects.json`. Point the sensor at it or add a root alias.                                                                                                                                                                |
| harness_green_main, harness_performance, harness_robustness                                    | F5:T9, F5:T7, F5:T8        | error `AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED` | They shell out to `gh run list`. The authority broker only admits read-only processes it can prove read-only. Declare `gh run list` as a read-only process in the authority policy, the same way preflight probes were admitted in R-0104.                         |
| spec_depth                                                                                     | F1:T2                      | fail, 0 invariants, 0 ADRs                      | ADR discovery defaults to `docs/meta/adr`; DEVAI keeps 66 ADRs in `law/adr`. Parameterize `adrDir`. Invariants remain empty until Round 3.                                                                                                                         |
| site_drift                                                                                     | diagnostic                 | unknown                                         | The gh-pages tip commit message must be exactly `docs: publish from <sha>`. The pages publication path writes a different message. Align `publish-pages.mjs` or relax the sensor by ADR.                                                                           |
| security_scan                                                                                  | F2:T6                      | review, 1 high and 4 moderate via `pnpm audit`  | Dependency bumps. Pass threshold is 0 high.                                                                                                                                                                                                                        |
| plant_depth                                                                                    | F2:T2                      | review                                          | File size distribution; largest file 3836 lines. Either split the outliers or set thresholds for a CLI monorepo in the adopter thresholds.                                                                                                                         |
| harness_coherence, harness_idiomaticity, harness_invariant_alignment                           | F5:T3, F5:T5, F5:T4        | review                                          | Workflow conventions (composite actions, caching, invariant references in gate steps). Small workflow edits plus invariant references once Round 3 exists.                                                                                                         |
| perf_test                                                                                      | F2:T7                      | unknown                                         | No `test:perf` script. Add one that runs the existing RC performance fixtures.                                                                                                                                                                                     |

### C. Shape mismatch: DEVAI is a CLI framework, not a service (Round 1 decides)

| Sensor                                                                    | Cell         | Today                                   | Decision                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| inventory_api, inventory_routes, inventory_data_model, inventory_coverage | F4:T1, F4:T2 | review, 0 endpoints, 0 routes, 0 tables | Either mark F4:T2 N/A for repositories with no HTTP or database surface, or teach the inventory to treat the action registry as the route surface (61 actions). The second option is the stronger dogfood signal. |
| inventory_rbac, inventory_data_handling                                   | F4:T1, F4:T6 | unknown / review                        | Same choice for F4:T6. There is no role or PII surface in a CLI; N/A by override is defensible.                                                                                                                   |
| plant_coverage                                                            | F2:T1        | fail, 0 endpoints                       | Plant coverage counts endpoints and routes. Redefine the plant model for a CLI as action handlers, or N/A.                                                                                                        |
| inventory_adherence                                                       | F4:T4        | unknown                                 | Needs a generated inventory (`inventory_regeneration`, harness-write). Runs once the inspector persists inventory in Round 6.                                                                                     |
| inventory_performance                                                     | F4:T7        | review, 0 observations                  | Needs recorded runtime observations. Runs after readings persist.                                                                                                                                                 |
| llm_judge                                                                 | F1:T3        | excluded                                | Remote-write; the self-dogfood policy forbids remote effects on this repository. F1:T3 is already covered by trace_resolution, so leave excluded.                                                                 |
| runtime_probe_api, runtime_probe_auth, runtime_probe_data                 | diagnostics  | excluded                                | No runtime to probe; forbidden as remote effects. Leave excluded.                                                                                                                                                 |

Because a cell collapses to the worst reading among its sensors, F4:T1 stays REVIEW as long as any inventory sensor reports review, even though inventory_dep_graph passes. Round 1 must settle the CLI-shaped inventory before F4 can go green.

### D. Missing spec substrate (Round 3)

spec_depth, spec_alignment, spec_security_coverage, spec_performance_targets, spec_robustness_targets, test_invariant_alignment and harness_invariant_alignment all read `law/invariants/*.json`, which is empty. spec_security_coverage additionally wants a threat model, a PII registry and an RBAC invariant. Nothing here runs green until the invariants exist as JSON records, not prose.

### E. Governance diagnostics failing today (Round 4)

decision_record_integrity: 65 ADRs do not satisfy `decision-record.schema.json` and 40 supersession links are asymmetric. decision_citation_resolution: 5 unresolved citations (ADR-001, ADR-003 in schemas, DII-103 and DII-104 in `scorecard.ts`). These are diagnostics rather than cells, but they fail the sweep gate, so the sweep can never report readiness until they are clean.

### F. Write-effect sensors (Round 6)

build, unit_test, integration_test, e2e_test, migration_check and inventory_regeneration need `--write` under the inspector role. The self-dogfood policy permits harness-write only to the inspector and lists no `sense` action in any role's `may_initiate`. The CLI authority path allowed the dry runs, so today the policy is normative rather than enforced for `sense run`; Round 1 makes them agree.

## 4. Blockers that are governance, not code

1. **Self-dogfood policy.** `sense run`, `sense record` and `audit observe` are absent from every role's `may_initiate`, and `fail_closed` names `undeclared-action-id`. Amend the policy to admit them: read-effect sensing for every role, harness-write recording and Auditor observation for the inspector only, remote effects still forbidden.
2. **Readings location.** `sense record` writes `.devai/state/sensor-readings/<kind>/`, the loop's scorecard inputs walk the same path, but the `audit scorecard` facade reads `record/proofs/freshness/readings/`. One ADR must pick the canonical store and the facade must follow it, or the persisted readings never reach the scorecard.
3. **N/A count.** Record in `law/policy/scorecard-na.json` whether F4:T5 is N/A by law as well as by runtime, so the target is stated once.
4. **CLI-shaped inventory.** Decide per cell (F2:T1, F4:T2, F4:T6) between N/A overrides and an action-registry-based inventory model.

## 5. Rounds of CMP-0002

Six rounds, each one pull request unless noted. Time matters: every task carries a time budget, and workers stop at the budget and report rather than gold-plate.

| Round                    | Goal                                                                                                                                                                                                                                         | Tasks                                | Tier and effort                                                | Budget |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- | ------ |
| R-0201 law               | ADRs and policy: self-dogfood amendment, canonical readings store, N/A ledger, CLI inventory decision                                                                                                                                        | 4 law tasks                          | architect (Fable), high                                        | 3 h    |
| R-0202 sensor inputs     | Parameters and adapters: tests roots, ADR dir, coverage path, effects tsconfig, `gh run list` read-only admission, typecheck command, `test:perf` script, gh-pages tip message                                                               | 3 waves, 8 tasks                     | worker-high (Opus), medium                                     | 4 h    |
| R-0203 spec substrate    | Author `law/invariants/*.json` from the constitution and accepted ADRs; threat model, PII registry (empty by declaration), performance and robustness targets                                                                                | 2 waves, 5 tasks                     | architect drafts the invariant set, worker-high fills records  | 6 h    |
| R-0204 decision hygiene  | Bring 66 ADRs to `decision-record.schema.json`, symmetric supersession, resolve 5 citations                                                                                                                                                  | 1 wave, 3 tasks                      | worker (Sonnet), low, mechanical                               | 3 h    |
| R-0205 plant and tests   | Dependency bumps to clear the high vulnerability, tag security, performance and robustness tests, split or threshold the largest files, workflow idiomaticity edits                                                                          | 2 waves, 6 tasks                     | worker (Sonnet) with worker-high for the dependency bump       | 4 h    |
| R-0206 persist and audit | Inspector runs `sense run --preset sweep --round R-0206 --as-role inspector --write`, records readings, runs `audit observe --at <head>`, commits `record/proofs/compliance/scorecards/SC-*.json`; release 1.7.0 carries the first scorecard | 1 wave, 2 tasks, owner effects: none | worker-high (Opus) plus owner approval of the persisted record | 2 h    |

Exit criteria per round are the sensor outcomes in section 3 moving to pass, verified by rerunning the sweep dry-run and real run at the round's merged head. Campaign closure is `audit scorecard --at <head>` reporting overall PASS with 43 PASS and 2 N/A, or 44 and 1 if Round 1 lifts F4:T5.

## 6. What can start now, without any decision

- Round 4 (decision hygiene) and the security bump in Round 5 touch no policy and can start immediately as `docs`, `law` and `build` family commits.
- Round 2 parameter work for test roots, ADR dir, coverage path and the effects tsconfig is code-only and independent of Round 1.
- The `gh run list` read-only admission mirrors the preflight probe admission and can be drafted now, subject to the Round 1 policy amendment landing first.

Everything else waits on Round 1.

## 7. Self-dogfood limits

This is DEVAI's own repository. Every session is human-invoked, one role per
session, no backlog dequeue, no self-dispatch, no remote effect. Readings are
recorded only by the inspector, only in R-0206, and only after ADR-SCR-0001
is accepted and its policy amendment merged. The scorecard the campaign
produces is an Auditor observation, not a readiness claim and not a
publication authority.

## 8. Reproducing the baseline

```text
node <cli> sense run --preset sweep --round R-0107 --repo-root . --dry-run --format json
node <cli> sense run --preset sweep --round R-0107 --repo-root . --format json
node <cli> audit scorecard --repo-root . --at <head>
```

The real sweep run has aggregate effect read and persists nothing; its
per-member readings are printed in the action payload. The baseline in
section 2 was taken from that payload on main `f5bd9d17`.
