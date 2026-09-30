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

## Where a member applies

Every check member declares where it applies
([ADR-CHK-0005](../../../law/adr/ADR-CHK-0005-check-member-applicability.md), #187).
The declaration is the `applicability` field of `law/policy/check-suites.json`, closed to
three values, and the schema rejects a member that omits it:

| Value     | Meaning                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `self`    | The member reads only the DEVAI source repository's own law, policy, scripts, or catalogue. In an adopter it reports not-applicable. |
| `adopter` | The member reads only an adopter repository. On the DEVAI source repository it reports not-applicable.                               |
| `both`    | The member reads the checked repository, whichever kind it is, and executes in both.                                                 |

Suite members are declared in `member_definitions`. The `--only` selectors that the CLI
dispatches without a suite member definition are declared in `selector_definitions`, one
entry per selector with `id` and `applicability`. The two lists are disjoint, every
selector the CLI accepts appears in exactly one of them, and a selector that is dispatched
without a declaration is a policy error (`CHECK_MEMBER_APPLICABILITY_UNDECLARED`), never a
pass and never not-applicable. A malformed `selector_definitions` section is
`CHECK_POLICY_SELECTORS_INVALID`.

The declared values, with the rationale for each one that is not obvious from the
member's inputs:

| Member                                                                                                                                              | Applicability | Rationale                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `action-coverage`                                                                                                                                   | `both`        | Evaluates the detected scope: the framework's registry on the source repository, the adopter's referenced actions and invariant claims in an adopter. The forced self scope is gone.                                                             |
| `action-effects`                                                                                                                                    | `self`        | Reads the framework's `law/policy/subprocess-effects.json`, `tests/config/tsconfig.effects.json`, and the effect-contract catalogue. Option B of #187, a package-owned input mode, is a later record.                                            |
| `cli-reference`                                                                                                                                     | `self`        | Compares the framework's canonical descriptors with its own `docs/reference`, driven by `law/policy/documentation-information-architecture.json`. Same option B reservation.                                                                     |
| `prompt-overlays`                                                                                                                                   | `self`        | Audits the recipe manifests that ship inside the package. It reads no adopter input, so in an adopter it would measure the framework, not the repository under check.                                                                            |
| `campaign`, `scorecard-page`                                                                                                                        | `self`        | Literal-argv members that run `scripts/check-campaign.mjs` and `scripts/generate-scorecard-page.mjs` from the source repository's `scripts/`.                                                                                                    |
| `ledger-local`, `ledger-rc`                                                                                                                         | `both`        | Run the repository's own `test-tasks.json` closure.                                                                                                                                                                                              |
| `adrs`, `glossary`, `invariants`, `invariant-strategies`, `overrides`, `trace`, `test-trace`, `journeys`, `pr-compliance`                           | `both`        | Read the checked repository's `law/adr`, `law/glossary`, `law/invariants`, `law/trace.json`, or `product/journeys`, which an adopter authors. A missing source in an adopter is that member's own failure, not not-applicable.                   |
| `change-taxonomy`, `ci-economy`, `forbidden-actions`, `glob-guards`, `schemas`, `sensor-integrity`, `dependencies`, `docs-links`, `docs-governance` | `both`        | Read the bound configuration under `.devai/config/`, the repository's workflows, manifests, `docs/`, or recorded readings. `schemas` already selects the canon rule set on the source repository and the bound-configuration rule set elsewhere. |
| `blueprint`, `schema`, `mutation`, `translation`                                                                                                    | `both`        | Take their inputs from explicit options (`--file`, `--schema` and `--instance`, the mutation report paths, `--witness`).                                                                                                                         |

### Repository kind

The dispatcher detects the repository kind once per run, from the bound configuration and
never from the presence of a directory: an adopter with a `law/` or `packages/` directory
is still an adopter. The kind is one of two values:

- `self` when the adopter-policy binding receipt `.devai/config/adopter-policy-binding.json`
  exists and its `policy_id` is `devai.devai-adoption`, the identity that
  `law/policy/devai-adoption.json` declares for the DEVAI source repository;
- `adopter` when the receipt exists and binds any other `policy_id`.

A checkout with no binding receipt is not classified: every member that needs the kind,
which is every member declared `self` or `adopter`, fails with
`CHECK_REPOSITORY_KIND_INVALID`, and the kind never defaults to `adopter` and never
yields not-applicable. A receipt that exists but cannot be parsed, or whose `policy_id`
is not a string, is the same `CHECK_REPOSITORY_KIND_INVALID`: an execution error, never a
default to either kind. The detection is reported as `kind_evidence`, an object with the
repository-relative `source` consulted, the JSON `pointer` read, and the `value` found. A
member executes when its applicability equals the detected kind or is `both`.

### Input source

Every member selects exactly one input source, reported as `input_source`, from a closed
set: `repository` when the member reads its defaults beneath the repository root,
`explicit` when an explicit option named the input, and `none` when nothing was read
because the member did not apply. `package`, the installed package's own sources, is
reserved for option B of #187 and is not a valid value until a record declares it.

## The not-applicable result

A member whose applicability excludes the detected kind returns one structured
not-applicable result. It is a distinct result class: `na` is a value of the member
`status` beside `pass`, `review`, `fail`, `unknown`, and `error`, and it is never a
substitute for any of them. `check` and `check --only` classify a member identically.

```json
{
  "id": "action-effects",
  "status": "na",
  "code": "CHECK_MEMBER_NOT_APPLICABLE",
  "message": "action-effects applies to self; the repository kind is adopter",
  "effect": "read",
  "binding": { "kind": "runtime-gate", "gate_id": "check-action-effects" },
  "duration_ms": 0,
  "value": {
    "member": "action-effects",
    "applicability": "self",
    "repository_kind": "adopter",
    "kind_evidence": {
      "source": ".devai/config/adopter-policy-binding.json",
      "pointer": "/policy_id",
      "value": "acme.devai-adoption"
    },
    "input_source": "none",
    "reason": "reads law/policy/subprocess-effects.json and tests/config/tsconfig.effects.json of the DEVAI source repository; an adopter holds neither"
  }
}
```

The `value` carries exactly these fields: `member`, the selected member id;
`applicability`, its declared value; `repository_kind`, the detected kind;
`kind_evidence`, how the kind was identified; `input_source`, always `none` here; and
`reason`, one sentence naming the framework inputs the member would have read. The result
class is named by the code `CHECK_MEMBER_NOT_APPLICABLE`, which the
[error-code reference](../error-codes.md) carries with a not-applicable exit class rather
than a failure class. `duration_ms` is `0` because nothing executed, so two runs of the
same repository produce byte-identical results; a not-applicable member reads no file
beyond the binding receipt and creates none.

In human output the member line reads `NA <member> (0ms, <effect>)` followed by the
message, beside `PASS`, `REVIEW`, `FAIL`, and `ERROR` lines. In the aggregate the member
counts under `counts.na` and nowhere else. A run whose every member is not-applicable has
`readiness_status: "na"`, `ok: false`, and exit `0`: nothing failed and nothing passed.
A run that mixes not-applicable and passing members has `readiness_status: "pass"` with a
non-zero `counts.na`; `ok` reports that every executed member passed, and a CI list that
requires a member to pass must read the member's own `status`, never the aggregate alone.

### Never a substitute for a failure

Applicability absorbs no failure. Each of the following stays a failure or an execution
error with its named code, and none of them is ever reported as `na`:

- a missing required source of an `adopter` or `both` member in the checked repository,
  for example `CHECK_DOCS_DIR_MISSING` for `docs-links`, `CHECK_TASK_DESCRIPTOR_MISSING`
  for the ledger members, or `CHECK_SERVICE_ERROR` carrying the unreadable path;
- an explicit input path that does not exist or does not parse, which is
  `CHECK_INPUT_PATH_INVALID` for the option that named it; an invalid explicit path never
  falls back to the defaults and never to not-applicable;
- a policy error in `law/policy/check-suites.json`, which is the `CHECK_POLICY_*` code
  that names the broken section;
- a checkout whose repository kind cannot be read, because the binding receipt is absent,
  unparsable, or carries no string `policy_id`, which is `CHECK_REPOSITORY_KIND_INVALID`
  for every member that needs the kind;
- a genuine finding of a `self` member on the DEVAI source repository, which is that
  member's own `fail`.

### Empty population

A `both` member that executes in an adopter but finds no population to evaluate reports
that explicitly instead of an empty pass. `action-coverage` with no adopter action in scope
returns `status: "review"` with the code `CHECK_MEMBER_POPULATION_EMPTY` and a `value`
carrying `member`, `applicability`, `repository_kind`, `kind_evidence`, `input_source`
(`repository`), `scope` (`adopter`), `population` (`0`), and `reason`. The aggregate then
has `readiness_status: "review"`, `ok: false`, and exit `1`; the aggregate never reports
`ok: true` while any member's population was empty. With a real population the member
evaluates the adopter scope and an unclaimed action fails as before.

### Test the classification

On the DEVAI source repository every `self` member executes its substantive check; the
result is `pass` or `fail`, never `na`:

```sh
node .devai/state/pr-bootstrap/cli/bin.js check --only action-effects --format json
node .devai/state/pr-bootstrap/cli/bin.js check --only cli-reference --format json
node .devai/state/pr-bootstrap/cli/bin.js check --only action-coverage --format json
```

In an adopter, the same three members through `check --only` return the not-applicable
result for `action-effects` and `cli-reference` and an evaluated adopter scope for
`action-coverage`. Read `.results[0].status`, `.results[0].code`, and
`.results[0].value.repository_kind`; rerun and compare the two outputs byte for byte; and
confirm with `git status --porcelain` that no file was created beneath the root:

```sh
pnpm exec devai check --only action-effects --repo-root . --format json
pnpm exec devai check --only cli-reference --repo-root . --format json
pnpm exec devai check --only action-coverage --repo-root . --format json
```

To confirm the declarations themselves, run `check --only schemas` on the source
repository, which validates `law/policy/check-suites.json` against its schema: removing
`applicability` from any member or selector fails the check.

## Suites and gate nodes

The check suites above are distinct from the nodes of `test-tasks.json`, which the
check runner plans for `--affected`, `--local` and `--rc`. Several gate nodes run one
check member each, so a change of one class reaches every member that class lists in
the change taxonomy:

| Gate node             | Runs                                                | Selected by  |
| --------------------- | --------------------------------------------------- | ------------ |
| `plan:validate`       | `check --only journeys`, after the two below        | `plan` class |
| `plan:campaign`       | `node scripts/check-campaign.mjs`                   | `plan` class |
| `plan:scorecard-page` | `node scripts/generate-scorecard-page.mjs --check`  | `plan` class |
| `docs:validate`       | `check --only cli-reference`, after the three below | `docs` class |
| `docs:links`          | `check --only docs-links`                           | `docs` class |
| `docs:governance`     | `check --only docs-governance`                      | `docs` class |
| `docs:ci-economy`     | `check --only ci-economy`                           | `docs` class |

A diff whose every path is an added or modified `plan`-class path plans the fixed
`planning` profile of `test-tasks.json` (`plan:validate` and `format`, plus the
preflight nodes) instead of the affected floor, so no `generate` or `build` runs for a
ledger, prompt or scorecard record. The campaign check also refuses a closed round
whose required Owner effect carries no `performed_at`.

The `campaign` and `scorecard-page` services run the same two scripts through
`devai check --only` once the check-suite policy declares them as members.

## Canonical descriptor

- [Check-suite policy](../../../law/policy/check-suites.json) — exact descriptors,
  membership, order, bindings, effects, costs, outputs, and prerequisites.
- [Check-suite schema](../../../law/schemas/check-suites.schema.json) — closed descriptor
  shape and ordering constraints.
- [Check suites](../../../law/policy/check-suites.json) —
  suite semantics, failure boundary, and non-publication posture.
- [Check action contract](../../../law/policy/action-registry.json) — public route,
  authority, consent, and output envelope.
