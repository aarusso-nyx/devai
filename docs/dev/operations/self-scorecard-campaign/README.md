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

decision_record_integrity: 65 ADRs do not satisfy `decision-record.schema.json` and 40 supersession links are asymmetric. decision_citation_resolution: 5 unresolved citations (two legacy numeric ADR citations in the schema examples, two draft DII identities in `scorecard.ts`). These are diagnostics rather than cells, but they fail the sweep gate, so the sweep can never report readiness until they are clean.

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

ADR-SCR-0001 is implemented by TASK-0211 (policy version 1.1.0). The
self-dogfood policy now admits three sensing actions and nothing else:
`sense run` with an aggregate effect of read is in every role's
`may_initiate`; `sense record` and `audit observe` are harness-write actions
in the inspector row only, and the schema rejects them with any other effect
or initiator. A `sense run` whose population resolves to a write member, or
that carries `--write`, is decided as harness-write and therefore admitted for
the inspector alone, with explicit write consent; a population with a
remote-write member is refused for every role. `--publish` on any sense
action is refused before the matrix is consulted. A recorded reading must
carry the declaring role and the human invocation, or `sense record` rejects
it. The unit cases live in `packages/cli/tests/unit/self-dogfood-policy.test.ts`,
one per inspector acceptance item of the record.

## 8. Reproducing the baseline

```text
node <cli> sense run --preset sweep --round R-0107 --repo-root . --dry-run --format json
node <cli> sense run --preset sweep --round R-0107 --repo-root . --format json
node <cli> audit scorecard --repo-root . --at <head>
```

The real sweep run has aggregate effect read and persists nothing; its
per-member readings are printed in the action payload. The baseline in
section 2 was taken from that payload on main `f5bd9d17`.

## 9. Round ledger and follow-ups

### R-0201 closed 2026-09-27 at `cbf2d132`

- TASK-0211 merged through [#112](https://github.com/aarusso-nyx/devai/pull/112);
  TASK-0212 through [#113](https://github.com/aarusso-nyx/devai/pull/113); the
  ledger through [#114](https://github.com/aarusso-nyx/devai/pull/114).
- TASK-0212's boundary was widened twice by the orchestrator: to the three
  tests that pinned the pre-record N/A list and the retired readings path,
  then to the bootstrap seed test and the doctor identity snapshot, which read
  the built package and only fail after a rebuild.

Follow-ups recorded at close, to be scheduled as tasks or decided by the
maintainer before R-0206 records readings:

1. The self-dogfood service decides `sense run`, `sense record`, and
   `audit observe`, but the `sense` and `audit` command paths do not yet call
   it. Wire the service before the inspector records readings.
   Closed by TASK-0262 (R-0206). On a repository whose
   `law/policy/self-dogfood.json` names `devai-source-repository`, the CLI
   refuses `--publish` on the three actions before the policy is parsed, and
   hands the role and write consent of a read-effect `sense run` to the matrix,
   since generic authority admits no declaration on a read effect. `sense run`,
   `sense record`, and `audit observe` then decide from the declared role, the
   consent, the resolved population, and for `sense record` the reading's
   attribution. A refusal writes a `POLICY_DENY` error carrying the policy's
   fail-closed reasons to stderr before any adapter runs or anything is
   written. The dry run of `sense run` reports the decision as `self_dogfood`.
   Adopter repositories without the policy are unaffected. The acceptance items
   are exercised through the command paths in
   `packages/cli/tests/unit/self-dogfood-command-paths.test.ts`.
2. The three sensing ids were added to `permitted_checks` as roster entries
   keyed by action id. No runner reads them. Drop them if row-only admission
   is preferred.
3. `packages/skills/src/post-merge-auditor` still reads the retired
   `record/proofs/freshness/readings` store; switch it to the loop resolver.
4. `.devai/config/adopter-policy-binding.json` pins a stale digest for
   `scorecard-na.json` and was already failing at the base head over a
   version mismatch. Regenerating it through `init bind` would materialize
   the adopter default rather than the law ledger. Decide which source the
   framework's own binding materializes from.
5. Task acceptance commands in R-0202 to R-0206 were remapped from
   `check --only <test task>` to the runnable `pnpm run <script>` form;
   `law:validate` runs as `check --only adrs` and `docs:validate` as
   `check --only cli-reference`. Round `close_checks` keep the test-task node
   ids, which the check runner executes.

### R-0202 closed 2026-09-27 at `df545e13`

- TASK-0221 through [#118](https://github.com/aarusso-nyx/devai/pull/118);
  TASK-0222 and TASK-0223 through the wave pull request
  [#121](https://github.com/aarusso-nyx/devai/pull/121); TASK-0224 through
  [#120](https://github.com/aarusso-nyx/devai/pull/120); TASK-0225 through
  [#117](https://github.com/aarusso-nyx/devai/pull/117); TASK-0226 to
  TASK-0228 through the wave pull request
  [#122](https://github.com/aarusso-nyx/devai/pull/122); the ledger through
  [#119](https://github.com/aarusso-nyx/devai/pull/119).
- Coupled waves ship as one pull request from the engineer's head, because the
  inspector's tests are red until the engineer's commits and the gate does not
  merge red tests. The architect's task keeps its own pull request.
- Boundaries were widened by the orchestrator for frozen catalogue and
  digest tests, the generated error-code reference, the published validator
  roster, and the sense resolver and adapters.

Follow-ups recorded at close:

1. The two read-only `gh api` GET shapes the site drift sensor needs were not
   admitted in the authority broker: the session's permission classifier
   refused that edit as a security weakening. The maintainer adds them (see
   the notes on #120), or `site_drift` stays unknown with a precise finding.
2. Only 41 of 61 registered actions are linked from `product/use-cases`, so
   `plant_coverage` and `inventory_coverage` read review at 67 percent. The
   20 links are Owner-authored specification and belong to R-0203.
3. The sensor inputs adopter default is not registered in the skills copy
   policy or the bootstrap file list, so `init bind` does not materialize it
   for adopters yet.
4. DEVAI's declared type check runs `tsc -b`, whose diagnostics may not print
   in the one-line form the sensor parses; confirm in the R-0206 sweep.
5. `inventory_performance` reads review until readings are persisted.
6. The three harness sensors now return honest readings: green-main fails at
   46 percent success over the last 50 runs, performance fails at a 503 s
   median, robustness reviews at 6 percent flaky. R-0205 owns them.

### R-0203 closed 2026-09-27 at `dae76911`

- TASK-0231 through [#127](https://github.com/aarusso-nyx/devai/pull/127);
  TASK-0232 and TASK-0233 through the wave pull request
  [#129](https://github.com/aarusso-nyx/devai/pull/129); TASK-0234 through
  [#125](https://github.com/aarusso-nyx/devai/pull/125); the ledger through
  [#124](https://github.com/aarusso-nyx/devai/pull/124),
  [#126](https://github.com/aarusso-nyx/devai/pull/126) and
  [#128](https://github.com/aarusso-nyx/devai/pull/128).
- The framework now carries 30 invariant records (29 readiness-bearing), a
  threat model with three trust boundaries, a data-handling declaration, six
  performance and four robustness targets, and a trace that links every
  invariant to existing tests. All five spec sensors, test invariant
  alignment, plant coverage and inventory coverage read pass on the
  repository.

Follow-ups recorded at close:

1. Four invariants have partial observations only: INV-AUTH-001 (the
   two-segment path-prefix rule), INV-HARNESS-006 (hard-gate binarity),
   INV-DATA-001 (the inventory data handling sensor does not yet read the
   declaration), INV-CORE-003. An Architect or Inspector strengthens them
   before R-0206.
2. The `spec_security_coverage` adapter does not pass `surfaces`; the sensor
   reads the declaration file itself.
3. `harness_invariant_alignment` reads review until readings exist (R-0206).
4. Records for Articles 25, 27 and 37 remain to be authored in a later round.

### R-0205 in progress: combined pull request

On 2026-09-27 the maintainer directed that the four single-role waves of
R-0205 (TASK-0252, TASK-0253, TASK-0254, TASK-0255) merge through one pull
request, [#138](https://github.com/aarusso-nyx/devai/pull/138), carrying their
forty commits in order, because the strict-up-to-date gate would otherwise
run four times in series. The execution policy's one-pull-request-per-wave
preference is deviated from here by that decision. The per-task pull
requests #134 to #137 are closed as superseded once #138 is green. One
conflict was resolved in the combination: TASK-0255's threshold wiring was
reapplied onto the adapters module after TASK-0253's split moved the input
helpers into `adapter-readers.ts`.

### R-0204 closed 2026-09-27 at `2928b5cc`

- TASK-0241 through [#133](https://github.com/aarusso-nyx/devai/pull/133).
  Both governance ledger sensors report zero findings on the repository:
  records validate against the second-generation schema, supersession is
  judged from the `supersedes` array, and scoped citations resolve.

Follow-ups recorded at close:

1. `law/adr/README.md` is byte-pinned in the adr-validation exception
   catalog, so the lifecycle paragraph the sensors enforce could not land
   without a catalog digest update in law policy. The draft text is kept in
   the session scratchpad; a law task applies it with the catalog change.
2. Sealed-history checks still apply only to first-generation records.

### R-0205 closed 2026-09-27 at `b401b5e9`

- TASK-0251 through [#132](https://github.com/aarusso-nyx/devai/pull/132);
  TASK-0252, TASK-0253, TASK-0254 and TASK-0255 through the combined
  [#138](https://github.com/aarusso-nyx/devai/pull/138); TASK-0256 through
  [#142](https://github.com/aarusso-nyx/devai/pull/142); the ledger through
  [#131](https://github.com/aarusso-nyx/devai/pull/131),
  [#139](https://github.com/aarusso-nyx/devai/pull/139) and
  [#141](https://github.com/aarusso-nyx/devai/pull/141).
- On the merged head the security scan, the three test coverage sensors,
  harness coherence, harness idiomaticity and plant depth read pass. Plant
  depth took two tasks: thirty seam splits (p95 921 to 624) and then
  seventeen more splits plus twelve function-body extractions with the
  generated action registry declared out of the plant (p95 630 to 454).

Follow-ups recorded at close:

1. The authority broker stays above 500 authored lines by design: its single
   admission function cannot be split under the pure-helpers rule.
2. Two moderate advisories remain in the test runner below 4.1.11; a minor
   bump is a separate decision.
3. The workflow checker does not yet reject a peeled pnpm commit or a
   `version:` input inside the composite action; two small checker cases.
4. Several function-body extractions kept behavior identical through small
   textual changes (a sequence counter helper, a reentrancy holder object, one
   extra `await` in the lifecycle executor, two literal-type casts); listed
   in #142.

### R-0206 opened 2026-09-27

Wave CTG-0262 (TASK-0262, wiring the self-dogfood service into the `sense`
and `audit` command paths) runs first; the recording wave CTG-0261 depends on
it. Still blocked by the maintainer: the two read-only `gh api` GET shapes the
site drift sensor needs (see R-0202 follow-ups).

Follow-ups recorded during the round:

1. `sense record` enforces the reading's attribution (declaring role and
   human invocation) at record time, but does not store it, because the
   closed reading schema admits no attribution field.
