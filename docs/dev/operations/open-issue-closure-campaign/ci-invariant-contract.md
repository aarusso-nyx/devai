# CTG-0622 CI invariant evidence and Pages cancellation contract

TASK-0624, Architect design proposal for issues #234 and #235. Entry source is
970514e90ebbdb0d2f6d7de6722619585715c973, tree
98fc52ce988c3ce679276e9ed3e13d0d26bf93fb, with base
180a122787193f9bdfce9b7f4cd5600e85ae7854. R-0602 depends only on the
human-ratified R-0601 source checkpoint; CTG-0622 has no wave predecessor.
The separate CTG-0621 Inspector red tests remain byte-exact. This document is
source design for human review, not an accepted amendment, runtime proof,
implementation result, merge admission or publication authorization.

## Trace resolution producer

INV-DEVAI-002 requires every active constitutional, hard-fail and gate invariant
to resolve to an existing executable test, rejects unknown invariant ids and
dangling paths, and refuses an empty readiness-bearing population. Its exact
candidate producer is the bootstrapped CLI invocation:

```bash
node .devai/state/pr-bootstrap/cli/bin.js check --only trace --format json
```

The mandatory companion validates discovered tests and canonical trace mappings:

```bash
node .devai/state/pr-bootstrap/cli/bin.js check --only test-trace --format json
```

`tests/contract/invariant-resolution.contract.test.ts` supplies the executable
readiness-population assertion. The planned Inspector suite
`tests/contract/cmp0006-ci-invariants.contract.test.ts` must exercise the actual
candidate gate, not just fixture schema validation. Its trace adversaries are an
unknown id, deleted test, path escape, untracked test, empty readiness population,
and a readiness invariant linked only to a script/config attestation. Each blocks
candidate admission. A warning or REVIEW reading is insufficient for the binary
hard gate; preserve the underlying diagnostic and block without rewriting it.

Required CI producers run in `.github/workflows/pull-request-checks.yml` on the
exact checked-out PR head or merge-group head, with the corresponding exact base.
A bare `check`, `check --only schemas`, comment, echo, skipped step, unrelated
named member, success from another candidate, or fixture-only PASS does not prove
trace resolution. Existing workflow preflight and affected selection are not
proof that either companion executes for every candidate. The Engineer must
wire both explicitly and make each exit/output independently binding.

## Hard and soft gate producers

INV-HARNESS-006 is a conjunction. Three kinds of evidence are required:

| Obligation            | Exact producer and required result                                                                                                                                                              | Evidence consumer                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hard gate             | Existing preflight and affected task execution in the PR workflow, plus both trace producers and the focused invariant gate contract suite; every selected required task passes                 | Candidate gate inspects selected task roster, exits and outcome bodies; rejects missing members, invalid verdicts and contradictory exit/output                      |
| Soft measurement      | Human-initiated isolated model evaluation through the registered `llm_judge` emitter and strict `review-verdict.schema.json` extraction, attributed to the producer, with retained reply digest | Candidate gate validates rubric, scores, thresholds, exact candidate and independent evaluator provenance; no live evaluation is dispatched by this design           |
| Candidate composition | `node .devai/state/pr-bootstrap/cli/bin.js audit scorecard --repo-root . --at <exact-current-40-character-SHA> --format json`                                                                   | Required workflow step verifies the composed result and its constituent evidence; the read-only scorecard is not itself a new model invocation or human ratification |

`<exact-current-40-character-SHA>` is a design placeholder, never a literal
acceptance argument. The installed help confirms `--at` is mandatory. The
scorecard command alone proves neither an isolated evaluation nor threshold
conformance. A test of a model-shaped fixture proves the gate's rejection
behavior, not that a real model evaluated the candidate. No CI step may initiate
a provider call automatically under this source-only mandate. Accepted candidate
measurement must come from separately authorized human-initiated evaluation.
The existing workflow is a non-attesting preflight and must remain so: consuming
candidate evidence does not sign, export, supplement a receipt or authorize merge.

Hard verdicts are exactly PASS or FAIL; a hard REVIEW, arbitrary string, missing
verdict or unobserved/crashed producer cannot admit. Soft verdicts are exactly
PASS, REVIEW or FAIL; the extractor's explicit unknown and operational error
states remain observable and block admission. REVIEW follows Article 23 and
requires a new recorded resolution; a human ratification is separate from the
measurement. Neither gate substitutes for the other. A fixture may prove
rejection of an invalid verdict without producing a runtime FAIL record.

### Threshold binding

The consumer hashes the exact `.devai/config/thresholds.json` bytes together with
the rubric/configuration and task roster used by each producer. Existing hard
bounds are lint errors/warnings 0/0, type errors 0 and coverage
lines/branches/functions/statements 70/60/70/70. All assigned tests and required
schema/generated checks must pass. Mutation remains optional external hardening:
its `not-required` disposition cannot become a synthetic PASS or delivery gate.
The freshness configuration is 168 hours; alignment currently uses its own
24-hour maximum and must continue to reject stale or future evidence rather
than silently substitute the larger window.

At entry the thresholds file has **no soft rubric score thresholds**. Coverage
or mutation percentages are not soft thresholds; review confidence is not a
rubric score. Thus there is no justified numeric soft PASS boundary to infer.
For each required rubric dimension, the future accepted threshold declaration
must provide its comparator and numeric minimum; the producer reports the
observed score and the consumer applies that exact comparator, including its
boundary. Missing, malformed, nonfinite or out-of-range scores, missing
thresholds, changed threshold digest, or one below-threshold dimension block
admission even when the verdict says PASS. The Inspector must prove both the
exact boundary and just-below cases for each accepted dimension.

This is a concrete planning gap: TASK-0624 owns neither thresholds nor a rubric
schema, and TASK-0626 owns only two workflows, the workflow checker and the
alignment workflow parser. An Owner/Architect decision must identify the exact
soft rubric/threshold authority, input representation, producer and consumer
implementation paths before claiming a complete INV-HARNESS-006 gate. No new
flag, schema, runtime record or out-of-scope typed operation is installed here.

### Evaluator and input identity

Evidence must identify the working agent instance and the evaluator instance,
runtime/model, task/candidate, input-context digest, isolation/completion status,
rubric digest, threshold digest, reply byte digest and extracted verdict. The
instances must differ and the evaluator must have no shared working-agent
context. A different model name alone is insufficient; the same model may be
used only in a distinct isolated instance. A fixture declaring isolation is not
independent operational evidence. Missing provenance, identical instance ids,
shared conversation/history, partial host completion or unmatched reply bytes
blocks admission. ADR-GOV-0023's advisory model review never supplies human gate
ratification; CMP-0006 still uses human review.

For both invariants, the binding is exact candidate commit/tree/base, actual
executable command/selector, source/lockfile/toolchain, policy/task roster,
producer output digest, completion timestamp and outcome. Preserve earlier
failures and all append-only proof bytes. Reuse is possible only for identical
content-addressed inputs; ancestor equivalence for observation projections is
not permission to reuse changed law, tests, workflows or thresholds.
Alignment's current generic action-token recognition must be narrowed to the
actual named producers and checked companion obligations. Current command-only
PASS matching cannot certify these semantics. The existing registry is unchanged;
this contract creates neither a public action nor a blanket sensor exception.

## Pages interruption counterexamples

The #234 reproduction is precise: `site-publish.yml` already declares the shared
`devai-pages-publication` group, with `cancel-in-progress: false`. The workflow
checker requires that false value. The problem is the coherence finding about
cancellation, not an absent group. Release publication uses the same shared
writer lock; a site-only cancellation change must not interrupt an authorized
release publication or weaken its exact identity.

`pages-publication.mjs:107-172` and
`github-pages-journal.mjs:118-284` show the following boundaries:

| Interruption point                                                      | Durable state and permitted recovery                                                                               | New dispatch with a different sourceRun                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Before intent creation                                                  | No unresolved intent; authenticated complete journal and verified release baseline still required                  | May proceed after proving absence; an HTTP error alone is never that proof                            |
| After intent creation, before submit or before durable submitted status | Intent; whether submission happened is not established by that record                                              | Refused as OTHER_PUBLICATION_UNRESOLVED; same identity is SUBMISSION_UNKNOWN even if live bytes match |
| After durable submitted status, before verification                     | Exact Pages id retained; rerun of the same dispatch can observe that id and verify live bytes without resubmitting | Refused as OTHER_PUBLICATION_UNRESOLVED; the current adapter does not reconcile a different identity  |
| During verified-status POST or before read-after-write                  | External outcome may be unknown; retain all records and reconcile the exact id                                     | Never manufacture verified from a cancelled job's success-shaped output                               |
| After durable verified status                                           | Exact Pages deployment was observed and live bytes verified                                                        | May proceed under the complete journal; same identity with matching bytes is a no-op                  |

ADR-REL-0032 removes sourceAttempt from site-only identity, permitting a rerun
of **one dispatch**. It deliberately retains sourceRun. Cancelling dispatch A
and starting dispatch B therefore creates distinct identities. `readJournal`
rejects every other nonverified identity before returning a usable journal;
`publishPages` refuses intent before its matching-bytes branch. A cancelled job
may leave legitimate verified evidence written before cancellation, but its
cancelled outcome is never evidence of new verification. An always-running
artifact upload cannot guarantee a durable submitted journal on forced
interruption. Local retention is not authenticated external reconciliation.

## Required Pages decision

**Existing reconciliation does not support automatic replacement after
cancellation. Do not enable cancellation under the current contract.** Keep the
finding visible; do not change the sensor, add an N/A entry or exempt this
workflow. This is a reviewable stop decision, not waiver or issue closure.

A bounded Owner/Architect amendment must choose and ratify one exact contract:

1. A cancellable preparation stage followed by a serialized noncancellable
   publication stage sharing the release writer lock. It must prove cancellation
   cannot cross intent/submission/verification and must define how the coherence
   obligation applies without suppressing the existing finding.
2. An explicitly authorized cross-dispatch reconciliation protocol that first
   resolves the exact predecessor intent/submission and unknown outcome, then
   admits the replacement. It needs durable evidence of the exact external Pages
   id or authenticated absence, handles a response lost after POST, preserves
   historical records, and cannot resubmit an unknown effect. Current allowed
   TASK-0626 paths exclude the publication/journal scripts and their existing
   tests, so this option requires a precise scope amendment and role triplet.

Neither option is approved here. Inspector TASK-0625 must test cancelled
publication at every boundary, rejection of false verified claims, same-run
resume without duplicate submission, cross-run rejection under the current
contract, and replacement reconciliation only under the subsequently accepted
contract. Preserve the main guard, scoped permissions, exact artifact/source/
control identities, verified release baseline and release attempt semantics.
No live Pages call or downstream dispatch is authorized by this proposal.

## Trace and review checkpoint

The owned `law/trace.json` change adds this document's authority anchors, code
areas and intended assertions to the two existing entries; it preserves every
existing test path and canonical test-corpus byte. Planned Inspector suites are
not inserted as existing tests. After separately authorized Inspector work,
an Architect must add the exact new test paths and regenerate/validate the
canonical assertion projection under an amended trace-write task. The current
TASK-0625 Inspector and TASK-0626 Engineer do not own trace.

Before any local commit, the human reviews the exact diff and focused results.
The proposed commits are separate: `docs(operations)` for this contract and
`law(sensors)` for trace. No commit, checkpoint ratification, round closure,
merged_as, per-wave PR or external effect is implied. The source proposal
records any acceptance failure and executor/toolchain mismatch explicitly.

## Focused source observations

All three declared acceptance commands (adrs, schemas, docs-links), the named
trace check and the existing invariant-resolution suite passed; the latter
ran 62 tests. Five offline probes against the current publication and GitHub
journal controls confirmed cross-dispatch refusal after intent/submission,
same-dispatch unknown-submission refusal, known-submission resume without a
second Pages POST, and verified no-op. These use an in-memory provider fixture,
never a live deployment or a synthetic runtime reading.

Supplementary `check --only test-trace` fails with 1651 diagnostics. Direct
comparison against HEAD's original trace produces identical diagnostics; the
canonical corpus is unchanged. This is an existing source blocker, not a green
gate. Missing markers and assertion projections require the appropriate
Inspector/Architect source tasks; TASK-0624 does not repair unrelated tests.
Supplementary `check --only schema` could not resolve the common-defs reference
in the standalone trace schema. Validation through the package schema registry,
which registers the referenced schemas, passes for the exact changed trace.
Both original failures remain in the local checkpoint evidence.

The pinned tier map resolves Architect/high to codex-cli:gpt-6-astra/high
(policy 1.0.0). The actual host session reports gpt-6.1-sol/high. No override
was supplied and no equivalence is inferred. Node 24.20.0 and pnpm 9.15.0 were
installed in this checkout; Git reports 2.54.0 rather than the manifest's
2.47.3. These executor/toolchain discrepancies remain explicit before any
conforming checkpoint ratification. No policy or campaign record is amended
to conceal them.
