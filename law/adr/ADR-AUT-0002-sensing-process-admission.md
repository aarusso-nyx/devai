---
id: ADR-AUT-0002
title: Exact admission of the build sensor process and the Pages journal reads
type: adr
status: proposed
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-AUT-0001
  - ADR-SCR-0001
  - ADR-SCR-0005
  - ADR-GOV-0002
  - law/policy/subprocess-effects.json
  - docs/dev/operations/harness-convergence-proposals.md
affected_rules:
  - packages/cli/src/authority/broker.ts
  - law/policy/subprocess-effects.json
  - packages/sensors/src/build.ts
  - packages/sensors/src/site-drift.ts
  - packages/sensors/src/harness/gh-api.ts
  - law/schemas/sensor-inputs.schema.json
  - .devai/config/sensor-inputs.json
  - law/policy/sensor-notes/build.md
  - law/policy/sensor-notes/site_drift.md
inspector_acceptance:
  - IA-001 -- On the framework checkout with the descriptor build node declared and a package that fails to compile, sense run build records FAIL with the exit code and the stderr head, never a broker refusal, never an error reading, and never PASS.
  - IA-002 -- A gh api argv that adds --method, -X, -f, -F, --field, --raw-field, --input, --paginate, or any query key beyond the fixed template is refused by the broker before a process starts, and site_drift reports the refused argv verbatim.
  - IA-003 -- A gh api GET whose repository differs from the declared journal repository, whose deployment id is not a decimal integer, or whose endpoint is neither declared shape is refused although the method is GET.
  - IA-004 -- With the journal holding no verified deployment, site_drift reads REVIEW with journal-not-verified rather than SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED, and with the local gh-pages tip ahead of the verified identity it reads FAIL.
  - IA-005 -- A declared build input whose argv differs from the descriptor build node fails the declared-inputs contract test with both argv named, and at run time reads error with BUILD_ARGV_CONFLICT instead of silently preferring either.
  - IA-006 -- Removing one of the two gh api templates from subprocess-effects.json while the broker literal still admits the shape, or the converse, fails the mirror test in the broker suite.
---

# Exact admission of the build sensor process and the Pages journal reads

## Status

Proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Binds nothing until the Architect sets it to accepted
before the round that implements it opens. Extends the read-only host process
admission of ADR-SCR-0005 with a write process and two `gh api` GET shapes;
ADR-AUT-0001 and its exact-effect ledger are unchanged.

## Context

The first self-scorecard (`SC-20260927T205906-001`) left F2:T4 unmeasured
because `sense run build` was refused on the framework checkout, although the
broker literal in `packages/cli/src/authority/broker.ts` admits `pnpm -r
build` under `sense run`, `test-tasks.json` declares that exact argv on the
`build` node, and `packages/sensors/src/build.ts` reads the descriptor before
falling back to the package manifest. The refusal has no reproduced cause
(#155). The same scorecard left F2:T9 unmeasured because `site_drift` needs
the Pages publication provenance that `scripts/process/github-pages-journal.mjs`
records through the GitHub deployments API, and the broker admits only `gh
auth`, `gh auth status`, and `gh run list` shapes, so the sensor reads
`SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED` (#162, item 1). The templates in
`law/policy/subprocess-effects.json` are descriptive for the effect-inference
sensor and are not loaded by the broker; the literal list in the broker is
what executes.

## Decision

The first task under this record reproduces the `sense run build` refusal on
the framework checkout with the broker trace enabled, and the reproduction
becomes the red test of the fix. The record does not name the cause in
advance; the candidates it discriminates are the executable resolution in
`build.ts`, the canonical working directory of the descriptor node, and the
parent action string the facade passes. The fix lands in the source the
reproduction names, with the reproduction as its test.

Precedence between the descriptor and a declared input is fixed. When
`test-tasks.json` carries a `build` node, that node's argv and cwd are the
build sensor's command; a `build` entry in `.devai/config/sensor-inputs.json`
is admitted only when the descriptor has no `build` node, which is the
adopter case without a descriptor. A declaration that names a different argv
while the descriptor carries a `build` node is a declaration defect: the
declared-inputs contract test rejects it with both argv, and at run time the
sensor reads `error` with `BUILD_ARGV_CONFLICT`. `law/schemas/sensor-inputs.schema.json`
gains the `build` input with an `argv` array and an optional `cwd` under the
same path grammar the other process inputs use.

The build sensor is a write. The registry keeps `local-write` with the
`proc:pnpm-build` and `fs:workspace` capabilities for the compiled workspace
outputs, the `sweep` exclusion stands, and no note, page, or declaration
describes the build as read-only. Recording its reading is an inspector
harness-write under the self-dogfood matrix as it is today.

The broker admits two exact `gh api` GET shapes for the harness sensors. The
first is the repository deployments listing,
`gh api /repos/<owner>/<repo>/deployments?environment=devai-pages-publication&per_page=100`.
The second is the deployment statuses listing,
`gh api /repos/<owner>/<repo>/deployments/<id>/statuses?per_page=100`, with
`<id>` a decimal integer. In both, `<owner>/<repo>` is the journal
repository the sensor declares, the endpoint and query are fixed strings, the
method is the implicit GET, and every option is refused, including
`--method`, `-X`, `-f`, `-F`, `--field`, `--raw-field`, `--input`,
`--paginate`, and `--hostname`. The shapes are declared as templates `gh-api-pages-deployments`
and `gh-api-pages-deployment-statuses` in `law/policy/subprocess-effects.json`
with the `proc:gh-read` capability, and the broker suite carries a mirror
test that fails when a template and the literal diverge. The record states
what the code already comments: the broker's literal list is the executable
policy, and the templates describe it.

`packages/sensors/src/site-drift.ts` keeps `SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED`
only for an argv the broker actually refuses, which after this record is a
policy regression. With the shapes admitted the sensor reads the journal and
reports what it finds: PASS when the local `gh-pages` tip matches the last
verified identity, REVIEW with `journal-not-verified` or
`journal-no-matching-intent` when the journal holds no usable record, and
FAIL when the tip differs. `packages/sensors/src/harness/gh-api.ts` keeps
spawning through the authority wrapper so the admission is enforced. At the
next observation F2:T4 and F2:T9 carry the verdict the build and the journal
measure; a failing build reads FAIL and stays visible on the scorecard.

## Consequences

Two scorecard cells become measurable on the framework without a host
adapter and without widening the `gh` surface beyond two read-only GET
strings. Adopters gain a documented precedence for the build command. The
task-policy digest changes with the broker literal and the templates, so the
attestation is re-issued once, in the same round as ADR-SCR-0007. Every
future read-only `gh` shape follows the same path: broker literal, mirrored
template, mirror test.

## Alternatives Considered

Admitting any `gh api` argv whose method is GET is rejected because the
endpoint would be chosen at run time and the broker would admit a class
rather than an effect, which ADR-AUT-0001 forbids. Routing the journal read
through a host adapter is rejected because that contract exists for remote
writes, and this read has none. Declaring the build sensor read-only so it
can join the sweep is rejected because the compiler writes under the package
directories. Fixing the refusal without a reproduction is rejected because
reasoning from the source alone concluded it could not happen.

## Affected Rules

- `packages/cli/src/authority/broker.ts` admits the two `gh api` GET shapes and carries the build refusal fix the reproduction names.
- `law/policy/subprocess-effects.json` declares templates `gh-api-pages-deployments` and `gh-api-pages-deployment-statuses`.
- `packages/sensors/src/build.ts` applies the descriptor-first precedence and `BUILD_ARGV_CONFLICT`.
- `packages/sensors/src/site-drift.ts` and `packages/sensors/src/harness/gh-api.ts` read the journal through the admitted shapes.
- `law/schemas/sensor-inputs.schema.json` and `.devai/config/sensor-inputs.json` carry the `build` input grammar.
- `law/policy/sensor-notes/build.md` and `law/policy/sensor-notes/site_drift.md` describe the write effect and the journal read.

## Inspector Adversarial Acceptance

Break one package so `pnpm -r build` exits non-zero and run `sense run build`
on the framework checkout; confirm a FAIL reading with the exit code and no
refusal. Issue `gh api` with `--method POST`, `-f state=x`, `--paginate`,
another repository, a non-integer deployment id, and a third endpoint;
confirm each is refused before a process starts and that `site_drift` prints
the refused argv. Empty the journal fixture and confirm REVIEW with
`journal-not-verified`; advance the local `gh-pages` tip past the verified
identity and confirm FAIL. Declare a `build` input with a different argv
beside a descriptor `build` node and confirm the contract test fails naming
both and the sensor reads `BUILD_ARGV_CONFLICT`. Delete one template and
confirm the mirror test fails.
