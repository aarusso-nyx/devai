---
title: Check suites
---

# Select and run a check suite

A check suite is an ordered verification population selected through `devai check`.
The generated reference below is rendered from the canonical suite policy; it is the
lookup authority for current membership, order, prerequisites, outputs, effects, cost,
and examples. This page adds operator guidance without restating that mutable
population.

<!-- devai:generated-reference:start category="check-suites" -->

## Check suites

<!-- devai:generated-entry category="check-suites" id="quick" -->

### `quick` — Quick

- **Stable ID:** quick
- **User-facing label:** Quick
- **Purpose:** Run the canonical `quick` acceptance population in declared order without coalescing members.
- **Population or projection:** `ledger-local`. Excluded: Not applicable: the canonical source declares no values.
- **Prerequisites:** `clean-or-explicitly-described-worktree`, `frozen-install-complete`, `pnpm-run-devai-prepare`; a repository-bound authority host-process adapter is required for subprocess-bound members.
- **Required external tools:** `registered-runtime-gate`; the live authority host-process adapter for governed subprocess execution.
- **Accepted inputs:** `--suite quick`, `--repo-root <path>`, `--as-role <inspector>` or a live `--authority-session <id>`, `--write`, output-format options, and member-specific inputs only when the selected binding declares them.
- **Defaults:** `standard` remains the command default; this suite requires explicit selection.
- **Output contract:** One result per member plus a total aggregate; member shapes are `action-envelope-plus-local-task-ledger-report`.
- **Verdict semantics:** `pass` requires every required member to pass; unknown members or outcomes are errors and never pass.
- **Declared effect:** `local-write` aggregate ceiling derived from member effects. The action-level ceiling is `local-write` and does not grant authority.
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `moderate`
- **When to use:** Use when the `quick` acceptance population matches the required confidence level.
- **When not to use:** Do not use to omit a stricter population required by a round, candidate, or close control.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite quick --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/policy/check-suites.json`](../../../law/policy/check-suites.json#/suites)
- **Related workflow:** `check`

<!-- devai:generated-entry category="check-suites" id="standard" -->

### `standard` — Standard

- **Stable ID:** standard
- **User-facing label:** Standard
- **Purpose:** Run the canonical `standard` acceptance population in declared order without coalescing members.
- **Population or projection:** `ledger-local`. Excluded: Not applicable: the canonical source declares no values.
- **Prerequisites:** `clean-or-explicitly-described-worktree`, `frozen-install-complete`, `pnpm-run-devai-prepare`; a repository-bound authority host-process adapter is required for subprocess-bound members.
- **Required external tools:** `registered-runtime-gate`; the live authority host-process adapter for governed subprocess execution.
- **Accepted inputs:** `--suite standard`, `--repo-root <path>`, `--as-role <inspector>` or a live `--authority-session <id>`, `--write`, output-format options, and member-specific inputs only when the selected binding declares them.
- **Defaults:** `standard` is selected when `--suite` and `--only` are omitted.
- **Output contract:** One result per member plus a total aggregate; member shapes are `action-envelope-plus-local-task-ledger-report`.
- **Verdict semantics:** `pass` requires every required member to pass; unknown members or outcomes are errors and never pass.
- **Declared effect:** `local-write` aggregate ceiling derived from member effects. The action-level ceiling is `local-write` and does not grant authority.
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `moderate`
- **When to use:** Use when the `standard` acceptance population matches the required confidence level.
- **When not to use:** Do not use to omit a stricter population required by a round, candidate, or close control.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite standard --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/policy/check-suites.json`](../../../law/policy/check-suites.json#/suites)
- **Related workflow:** `check`

<!-- devai:generated-entry category="check-suites" id="full" -->

### `full` — Full

- **Stable ID:** full
- **User-facing label:** Full
- **Purpose:** Run the canonical `full` acceptance population in declared order without coalescing members.
- **Population or projection:** `ledger-rc`. Excluded: Not applicable: the canonical source declares no values.
- **Prerequisites:** `clean-or-explicitly-described-worktree`, `frozen-install-complete`, `pnpm-run-devai-prepare`; a repository-bound authority host-process adapter is required for subprocess-bound members.
- **Required external tools:** `registered-runtime-gate`; the live authority host-process adapter for governed subprocess execution.
- **Accepted inputs:** `--suite full`, `--repo-root <path>`, `--as-role <inspector>` or a live `--authority-session <id>`, `--write`, output-format options, and member-specific inputs only when the selected binding declares them.
- **Defaults:** `standard` remains the command default; this suite requires explicit selection.
- **Output contract:** One result per member plus a total aggregate; member shapes are `action-envelope-plus-rc-task-ledger-report`.
- **Verdict semantics:** `pass` requires every required member to pass; unknown members or outcomes are errors and never pass.
- **Declared effect:** `local-write` aggregate ceiling derived from member effects. The action-level ceiling is `local-write` and does not grant authority.
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `expensive`
- **When to use:** Use when the `full` acceptance population matches the required confidence level.
- **When not to use:** Do not use to omit a stricter population required by a round, candidate, or close control.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite full --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/policy/check-suites.json`](../../../law/policy/check-suites.json#/suites)
- **Related workflow:** `check`

<!-- devai:generated-entry category="check-suites" id="release" -->

### `release` — Release

- **Stable ID:** release
- **User-facing label:** Release
- **Purpose:** Run the canonical `release` acceptance population in declared order without coalescing members.
- **Population or projection:** `ledger-rc`. Excluded: Not applicable: the canonical source declares no values.
- **Prerequisites:** `clean-or-explicitly-described-worktree`, `frozen-install-complete`, `pnpm-run-devai-prepare`; a repository-bound authority host-process adapter is required for subprocess-bound members.
- **Required external tools:** `registered-runtime-gate`; the live authority host-process adapter for governed subprocess execution.
- **Accepted inputs:** `--suite release`, `--repo-root <path>`, `--as-role <inspector>` or a live `--authority-session <id>`, `--write`, output-format options, and member-specific inputs only when the selected binding declares them.
- **Defaults:** `standard` remains the command default; this suite requires explicit selection.
- **Output contract:** One result per member plus a total aggregate; member shapes are `action-envelope-plus-rc-task-ledger-report`.
- **Verdict semantics:** `pass` requires every required member to pass; unknown members or outcomes are errors and never pass.
- **Declared effect:** `local-write` aggregate ceiling derived from member effects. The action-level ceiling is `local-write` and does not grant authority.
- **Consent flags:** `--write` is required; `--publish` is not implied.
- **Cost class:** `expensive`
- **When to use:** Use to observe release eligibility before a separately authorized ceremony.
- **When not to use:** Do not treat a passing report as publication, release, or deployment authority.
- **Non-pass semantics:** `fail` is a negative finding; `error` is an execution or producer defect; `unknown` never passes; `review` requires human disposition; `skipped` reports an unexecuted member; `N/A` is valid only when the governing contract explicitly permits it.
- **Example:** `devai check --suite release --repo-root . --as-role inspector --write --format json`
- **Canonical source:** [`law/policy/check-suites.json`](../../../law/policy/check-suites.json#/suites)
- **Related workflow:** `check`

<!-- devai:generated-reference:end category="check-suites" -->

## Choose a suite

Run the least costly suite that satisfies the governing workflow or gate. Omitting
`--suite` selects the canonical default. Use `--only <member>` only when diagnosing one
named check; it is mutually exclusive with `--suite` and does not prove that a required
suite ran.

A broader suite contains the earlier suite population in the canonical order. Do not
replace a required broader suite with a smaller one, reorder members, coalesce repeated
work, or treat a partial run as the named suite. The release-facing suite observes
eligibility for a separately authorized ceremony; it neither publishes nor establishes
release standing.

## Run a suite safely

Before execution, satisfy the prerequisites shown in the generated descriptor. Suite
members execute serially in declared order. DEVAI resolves the selected population and
its maximum effect before dispatch, then enforces the resolved authority and consent
contract. Supplying `--write` acknowledges an authorized local or harness mutation; it
does not grant a role, widen the population, or authorize publication.

Members that launch governed processes also require the repository-bound authority
host-process adapter named by the generated descriptor. `--as-role` declares the
initiator; it does not manufacture a missing adapter or authority session.

For example, an Inspector can run the current fast-feedback suite with explicit local
write consent and machine-readable output:

```sh
devai check --suite quick --as-role inspector --write --format json
```

If the governing workflow requires a different suite, substitute the required suite
identifier from the generated reference and retain its declared prerequisites and
consent flags. Do not add `--publish`: check suites have no publication behavior.

## Interpret results conservatively

The machine result separates execution status from readiness status and includes one
result per selected member. A passing aggregate exits `0`; review or unknown exits `1`;
failure or execution error exits `2`. N/A is successful only when the output explicitly
classifies it as such. Missing, malformed, unknown, or unimplemented members are errors
and never PASS. Diagnostic output from an interrupted or partial population is not suite
evidence.

The cost classes are relative workload classes, not duration promises. They do not
authorize skipping a required member or substituting cached, transported, or prior
results for current execution.

## Canonical descriptor

- [Check-suite policy](../../../law/policy/check-suites.json) — exact descriptors,
  membership, order, bindings, effects, costs, outputs, and prerequisites.
- [Check-suite schema](../../../law/schemas/check-suites.schema.json) — closed descriptor
  shape and ordering constraints.
- [Check suites](../../../law/policy/check-suites.json) —
  suite semantics, failure boundary, and non-publication posture.
- [Check action contract](../../../law/policy/action-registry.json) — public route,
  authority, consent, and output envelope.
