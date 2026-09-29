---
id: ADR-MDL-0001
title: Structured review contracts with consumer-specific schemas and one shared extractor
type: adr
status: accepted
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 18 (soft gate)
  - law/constitution.md Article 23 (tie-breaking ladder)
  - law/constitution.md Article 39 (explicit uncertainty)
  - law/policy/sensor-notes/llm_judge.md
  - ADR-GOV-0023
  - packages/skills/src/model-bridge/index.ts
  - packages/sensors/src/judge.ts
  - packages/loop/src/loop/triage.ts
  - docs/dev/operations/harness-convergence-proposals.md
affected_rules:
  - law/schemas/review-verdict.schema.json
  - law/schemas/triage-breaker.schema.json
  - packages/schemas/src/index.ts
  - packages/skills/src/model-bridge/index.ts
  - packages/sensors/src/judge.ts
  - packages/loop/src/loop/triage.ts
  - packages/skills/resources/recipes/devai-verify/SKILL.md
  - packages/skills/resources/recipes/devai-verify/devai.recipe.json
  - law/policy/sensor-notes/llm_judge.md
inspector_acceptance:
  - IA-001 -- A reply reading `Here is my assessment` followed by one fenced or unfenced verdict object yields `pass` through the shared extractor, in the judge sensor and in the orchestrator review step alike.
  - IA-002 -- A reply whose verdict is `maybe` yields `error` with a bounded redacted excerpt and the SHA-256 of the full reply, never a silent `unknown`.
  - IA-003 -- A reply containing two conflicting candidate objects, or an echoed example beside the real verdict, yields `error`, never the first object.
  - IA-004 -- A CLI transport reply cut off by a `length` finish yields `error`, and no transport reports `stop` unconditionally.
  - IA-005 -- The tie-breaker rejects a document shaped as a review verdict and the judge rejects a document shaped as a triage classification; neither consumer accepts the other's schema.
  - IA-006 -- No request from the bridge carries an assistant prefill, and a provider that offers schema-constrained output receives the consumer's schema on the request.
---

# Structured review contracts

## Status

Accepted on 2026-09-29 by the Architect before the round that implements it
opened; proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Replaces the ad hoc reply parsing
in the judge sensor, the triage tie-breaker, and the campaign orchestrator
with two declared schemas and one extractor, and is the Architect disposition
that the `llm_judge` sensor note requires for a change to its emitter.

## Context

Model-evaluated replies are parsed by a bare `JSON.parse` over the whole text
in the `llm_judge` sensor (`packages/sensors/src/judge.ts`) and in the triage
tie-breaker (`packages/loop/src/loop/triage.ts`), after a first look at a
provider `json` field that only the OpenAI adapter fills, in `json_object`
mode rather than against a schema. The two consumers expect different
documents, `verdict` versus `classification`. On a parse failure the judge
emits an `error` reading that the scorecard maps to FAIL, and the tie-breaker
returns `inconclusive` and escalates; neither keeps the reply. Neither CLI
bridge in `packages/skills/src/model-bridge/index.ts` asks the host for
schema-constrained output, and both CLI transports report
`finish_reason: stop` unconditionally, so a truncated reply looks complete.
The consumer that rejected the maintainer's PASS replies during CMP-0002 is
the campaign orchestrator session, which parses the review subagents' replies
by hand with no schema. The `llm_judge` sensor note requires an Architect
disposition before its emitter changes.

## Decision

Two reply schemas are declared under `law/schemas` and registered in
`packages/schemas/src/index.ts` so every consumer validates through
`getValidator`. `review-verdict.schema.json` carries `verdict` from
`pass | review | fail | unknown`, `confidence`, `rationale`, and `findings`,
and is consumed by the judge sensor and by the campaign review that
ADR-GOV-0023 admits. `triage-breaker.schema.json` carries `classification`,
`confidence`, and `rationale`, and is consumed by the tie-breaker. Neither
consumer accepts the other's document.

One shared extractor lives in the model bridge. It validates a provider
`json` field when one is present. Otherwise it accepts exactly one
unambiguous candidate document in the reply text, with or without a code
fence, and rejects multiple conflicting objects, echoed examples, malformed
fields, provider errors, and truncation. The extractor returns either a
validated document or an `error` outcome; it never returns a partially parsed
document and never guesses between candidates.

The bridge requests schema-constrained output wherever the provider offers
it: `output_config.format` on the Claude API, `--json-schema` on `claude -p`,
`--output-schema` on `codex exec`, and a JSON schema `response_format` on the
OpenAI API. The bridge never uses an assistant prefill. Both CLI transports
report a real `finish_reason` derived from the host's completion event, so a
`length` finish is `error`, never `unknown`.

A parse or validation failure keeps a bounded, redacted excerpt of the reply
and the SHA-256 of the full reply in the finding. This satisfies the
`partial_output: retain-as-diagnostic-only` rule of the sensor contract
without storing unbounded raw text.

The campaign orchestrator session, which parses the review subagents'
replies, receives the same verdict schema and extractor as a step of the
`devai-verify` recipe that the orchestrator prompt invokes; the orchestrator
no longer parses a reply by hand. One reply that the orchestrator rejected
during CMP-0002 is attached to the record as its first fixture and must yield
`pass` through the shared path.

This record is the Architect disposition that
`law/policy/sensor-notes/llm_judge.md` requires; the note is updated to cite
it, and the sensor's identity, standing, tier, and emitter path are unchanged.

## Consequences

A conversational reply that wraps a valid verdict is accepted, and a reply
that only looks valid is refused with evidence a human can inspect. The judge
readings gain an excerpt and a digest on failure, the tie-breaker stops
escalating on formatting accidents, and the bridge tests cover the four
request forms; a host without schema-constrained output falls back to the
text path with the same extractor. The verdict recording of ADR-GOV-0023
depends on this record, so the two land in the same round or this one first.

## Alternatives Considered

One universal reply schema for every consumer is rejected because the judge
and the tie-breaker answer different questions and a shared shape would let
one consumer accept the other's document. Prefilling the assistant turn with
an opening brace is rejected because it forces a document where the model
may need to refuse and because two of the four transports cannot do it.
Storing the full raw reply on failure is rejected as unbounded and possibly
sensitive; the excerpt plus digest lets a human verify the stored reply
elsewhere. Keeping the orchestrator's own parsing and only fixing the two
programmatic consumers is rejected because the orchestrator is the consumer
that produced the observed false rejections.

## Affected Rules

- `law/schemas/review-verdict.schema.json` and
  `law/schemas/triage-breaker.schema.json`: the two new reply contracts.
- `packages/schemas/src/index.ts`: their registration for `getValidator`.
- `packages/skills/src/model-bridge/index.ts`: the shared extractor, the
  schema-constrained request forms, and the real `finish_reason` on the CLI
  transports.
- `packages/sensors/src/judge.ts` and `packages/loop/src/loop/triage.ts`: the
  consumers, which validate through the extractor and keep the excerpt and
  digest on failure.
- `packages/skills/resources/recipes/devai-verify/SKILL.md` and
  `devai.recipe.json`: the orchestrator review step.
- `law/policy/sensor-notes/llm_judge.md`: the disposition reference.

## Inspector Adversarial Acceptance

Feed the extractor `Here is my assessment: {"verdict":"pass", ...}` with and
without a fence and confirm `pass` from the judge and from the recipe step.
Feed `{"verdict":"maybe"}` and confirm `error` with an excerpt no longer than
the declared bound and a digest equal to the SHA-256 of the reply. Feed a
reply holding an example object and a real object with different verdicts and
confirm `error`. Simulate a `length` finish on `claude -p` and on
`codex exec` and confirm `error` and a `finish_reason` other than `stop`.
Send a triage classification to the judge and a review verdict to the
tie-breaker and confirm both refuse. Capture the outbound request on each
provider and confirm the schema is attached where the provider supports it
and that no assistant prefill is present. Run the attached CMP-0002 fixture
reply and confirm it yields `pass`.
