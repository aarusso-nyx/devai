---
id: ADR-SCR-0013
title: Gate invariant producers run in the preflight step, and audit scorecard is observed in process
type: adr
status: accepted
date: 2026-10-05
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0008
  - ADR-CHK-0001
  - ADR-SCR-0004
  - law/invariants/INV-DEVAI-002.json
  - law/invariants/INV-HARNESS-006.json
  - docs/dev/operations/trustworthy-observations-campaign/README.md
affected_rules:
  - .github/workflows/pull-request-checks.yml
  - packages/sensors/src/harness-invariant-alignment-workflow.ts
  - packages/sensors/src/harness-invariant-alignment.ts
  - packages/sensors/src/harness-invariant-alignment-evidence.ts
  - packages/cli/src/commands/sense/adapter-readers.ts
  - packages/cli/src/commands/sense/adapters.ts
  - packages/cli/src/commands/audit/scorecard.ts
inspector_acceptance:
  - IA-001 -- A gate step that feeds an inline Node program through a quoted heredoc whose body has if ( and for ( lines, followed by a fail-closed devai command, reads as binding; the same control flow inside a heredoc fed to bash, sh, cat piped into bash, or eval keeps the step non-binding, set +e inside such a shell heredoc is still seen, and a heredoc written to a file by redirection or tee and sourced later keeps its set +e visible.
  - IA-002 -- A devai command written only inside a program heredoc body is never credited as a CI measurement, and an unterminated heredoc leaves the step as it was read before, so its control flow stays visible.
  - IA-003 -- On the pull request workflow the alignment sensor finds an executable fail-closed step for sense run and for audit scorecard in the preflight step; removing either producer line makes its invariant misaligned again, and the workflow contract still reports exactly the install, preflight, and affected run steps.
  - IA-004 -- The adapter observation names devai audit scorecard with the exact head, binds the head it ran at, and reads fail when the shared composition throws; an observation that fails, binds another head, or is stale or future-dated never aligns an invariant, and no observation aligns one without the fail-closed CI step.
  - IA-005 -- After the ordered recording protocol of ADR-SCR-0008 at a head that carries both producers, harness_invariant_alignment reads PASS with zero misaligned gate invariants, and removing the recorded sense run readings makes INV-DEVAI-002 misaligned again.
  - IA-006 -- When the chain holds an earlier sense.readings.record receipt for the same store path at another head, a reading recorded at the candidate binds through the receipt whose digest names its current bytes; a candidate receipt whose digest names other bytes, or a reading edited after its receipt, never binds, and receipts without a digest keep the first-receipt rule.
---

# Gate invariant producers run in the preflight step, and audit scorecard is observed in process

## Status

Accepted on 2026-10-05 by the Architect for the 2.0.0 release. The Owner's
release decisions of 2026-10-05, relayed by the release coordinator, direct
that #235 be resolved and authorize the decision records the release work
needs. This record extends the evidence rule of ADR-SCR-0008 and keeps the
three-step preflight lane of ADR-CHK-0001 unchanged.

## Context

The second self-scorecard reads F5:T4 REVIEW with
`HARNESS_INVARIANT_ALIGNMENT_UNMEASURED_IN_CI` (#235). The framework has two
gate invariants. INV-DEVAI-002 is measurable through `check` or `sense run`,
and INV-HARNESS-006 through `audit scorecard`. The
`harness_invariant_alignment` sensor counts an invariant as aligned only when
one of its actions has an executable fail-closed CI step and fresh passing
evidence bound to the candidate whose command runs the same action.

Four facts kept both invariants misaligned:

- Every run step of the pull request gate reads as non-binding. The install
  and affected steps carry shell `if` blocks. The preflight step is binding
  under `set -euo pipefail`, but it feeds an inline Node program through a
  quoted here-document, and the sensor's line splitter reads the program's
  `if (` and `for (` lines as shell control flow.
- ADR-CHK-0001 collapses the gate to exactly three run steps (`install`,
  `preflight`, `affected`) in one job, and `scripts/check-workflows.mjs`
  refuses a fourth run step or a second job with `CI_PREFLIGHT_GATE_INVALID`.
- Recorded readings carry a `devai sense run <kind>` command only for the
  governance kinds, which is enough for INV-DEVAI-002. Nothing can carry
  evidence for `audit scorecard`: the action persists nothing, the
  test-result receipt the sensor accepts (`devai-record-run`, `test-run.*`)
  has no writer, and `evidence record --kind test` needs a round.
- Reading ids are content-derived, so a governance reading with the same
  content lands on the same store path at every candidate, and the
  append-only chain keeps each earlier `sense.readings.record` receipt for
  that path. The sensor bound a stored reading to the first receipt for its
  path, so a reading recorded at a new head was judged against the head of
  the second scorecard and never counted.

## Decision

The preflight step runs two producers after `check --preflight`, each failing
the step on its own:
`sense run trace_resolution --as-role inspector --format json` for
INV-DEVAI-002 and
`audit scorecard --repo-root . --at "$(git rev-parse HEAD)" --format human` for
INV-HARNESS-006. Trace resolution is INV-DEVAI-002's own subject, and any
reading other than PASS exits non-zero. The scorecard composition at the
exact checked-out candidate fails on a moved head, a rejected store reading,
or a scorecard outside its schema. No existing command changes, and the lane
keeps its three run steps.

The alignment sensor reads the body of a here-document fed to a program
other than a shell as that program's input, not as shell. A body fed to a
shell or an evaluator (`sh`, `bash`, `eval`, `source`, and their peers), or
one whose line pipes or redirects output onward, so that a later line may run
it, stays in place, and its control flow and any `set +e` keep the step
non-binding. An unterminated or unreadable here-document leaves the script
unchanged, and a devai command written inside a removed body is never
credited.

For a read-only action that persists nothing, the CLI adapter of
`harness_invariant_alignment` observes the action in process at the
candidate head and hands the observation to the sensor. Today this covers
`audit scorecard` only, through `composeExactHeadScorecard`, the function the
command itself runs. The observation binds the head it ran at and the time it
completed, reads `fail` when the composition throws, and is judged by the
sensor's existing rules: it must pass, bind the candidate, be fresh, and name
the action as a fail-closed devai command. It never stands in for the CI
step. Recorded readings keep the ADR-SCR-0008 rules, and INV-DEVAI-002's
evidence stays the recorded `sense run` readings.

A stored reading binds through every `sense.readings.record` receipt whose
artifact digest names the file's current bytes, as ADR-SCR-0008 makes the
digest part of the receipt. A receipt whose digest names other bytes binds
nothing, so an edited reading is never evidence. Receipts that carry no
digest keep the earlier rule of the first receipt for the path.

## Consequences

At the next recorded scorecard F5:T4 can read PASS: both invariants have a
fail-closed producer in the required gate, INV-DEVAI-002 has recorded
evidence, and INV-HARNESS-006 has the in-process observation. Every pull
request now fails at the preflight step when the trace stops resolving or the
scorecard stops composing, and the gate takes a few seconds longer. A store
that holds a rejected reading now also shows as a misaligned INV-HARNESS-006.

The sensor still matches actions, not sensor kinds, so any fail-closed
`sense run` step and any recorded `sense run` reading satisfy INV-DEVAI-002.
Narrowing alignment to named producers remains future work. The soft-gate
part of INV-HARNESS-006, evaluation by a model instance distinct from the
working agent, is still measured outside CI; this record does not claim it.

## Alternatives Considered

A fourth run step or a second job is rejected because ADR-CHK-0001 collapses
the gate to three steps and the workflow contract enforces it. Adding
`sense run` to INV-HARNESS-006's `measurable_via` is rejected because an
unrelated step and unrelated readings would then count as measuring gate
verdicts. Reviving the test-result receipt is rejected because it has no
writer and its registered replacement needs a round. Persisting the
`audit scorecard` output is rejected because it would change a read-only
action's effects. The provider-backed soft-gate evidence designed in CMP-0006
stays out of the pull request lane, which makes no provider call.

## Affected Rules

- `.github/workflows/pull-request-checks.yml` runs the two producers at the end of the preflight step.
- `packages/sensors/src/harness-invariant-alignment-workflow.ts` removes program here-document bodies before splitting a step into commands.
- `packages/sensors/src/harness-invariant-alignment.ts` accepts in-process observations beside the loaded evidence.
- `packages/sensors/src/harness-invariant-alignment-evidence.ts` binds a stored reading through the receipts whose digest names its current bytes.
- `packages/cli/src/commands/audit/scorecard.ts` exposes the exact-head composition the command runs.
- `packages/cli/src/commands/sense/adapter-readers.ts` and `packages/cli/src/commands/sense/adapters.ts` observe `audit scorecard` at the candidate head for `harness_invariant_alignment`.

## Inspector Adversarial Acceptance

- IA-001 -- A gate step that feeds an inline Node program through a quoted heredoc whose body has if ( and for ( lines, followed by a fail-closed devai command, reads as binding; the same control flow inside a heredoc fed to bash, sh, cat piped into bash, or eval keeps the step non-binding, set +e inside such a shell heredoc is still seen, and a heredoc written to a file by redirection or tee and sourced later keeps its set +e visible.
- IA-002 -- A devai command written only inside a program heredoc body is never credited as a CI measurement, and an unterminated heredoc leaves the step as it was read before, so its control flow stays visible.
- IA-003 -- On the pull request workflow the alignment sensor finds an executable fail-closed step for sense run and for audit scorecard in the preflight step; removing either producer line makes its invariant misaligned again, and the workflow contract still reports exactly the install, preflight, and affected run steps.
- IA-004 -- The adapter observation names devai audit scorecard with the exact head, binds the head it ran at, and reads fail when the shared composition throws; an observation that fails, binds another head, or is stale or future-dated never aligns an invariant, and no observation aligns one without the fail-closed CI step.
- IA-005 -- After the ordered recording protocol of ADR-SCR-0008 at a head that carries both producers, harness_invariant_alignment reads PASS with zero misaligned gate invariants, and removing the recorded sense run readings makes INV-DEVAI-002 misaligned again.
- IA-006 -- When the chain holds an earlier sense.readings.record receipt for the same store path at another head, a reading recorded at the candidate binds through the receipt whose digest names its current bytes; a candidate receipt whose digest names other bytes, or a reading edited after its receipt, never binds, and receipts without a digest keep the first-receipt rule.
