---
id: ADR-MDL-0003
title: Live reviews isolate host tools and declare exact envelope and verdict bytes
type: adr
status: accepted
date: 2026-10-01
authority: Architect
supersedes:
  - ADR-MDL-0001
provenance:
  - ADR-MDL-0001
  - docs/dev/operations/open-issue-closure-campaign/decision-register.md
  - product/campaigns/CMP-0006-open-issue-closure/issue-snapshot.json
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
  - IA-007 -- A valid structured host envelope with a positively completed terminal event and no tool or MCP events yields the canonical verdict; truncation, a real tool request or provider failure is still refused.
  - IA-008 -- Each host accepts its provider schema projection, canonical validation rejects malformed projected replies, and the isolated live review emits no tool or MCP use; fixtures declare and verify the exact reply byte digest.
---

# Live reviews isolate host tools and declare exact envelope and verdict bytes

## Status

Accepted by the Owner in this preparation session on 2026-10-01: “I Accept all four ADR proposed.” The Architect records that acceptance here. The predecessor stays byte-exact; this forward record is the accepted superseding decision. The catalogue is regenerated and its exception digest repinned. Acceptance does not report implementation or authorize an external effect.

## Context

Issue #249 reports four live bridge gaps. Current finish mapping is packages/skills/src/model-bridge/index.ts:86-96; host argv and reply byte selection are :98-218. No live review or paid invocation is authorized by drafting this record.

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

Accepted transport refinement: a Claude structured-output transport stop marker alone is not an executed tool call. Completion is admitted only with positive terminal completion, valid structured_output, no provider error or truncation, and no actual tool or MCP events. The reviewer process runs with an explicitly empty tool and MCP configuration, isolated from user and project configurations; installed host help and a transcript prove that isolation before live use. Codex uses the same no-tool/no-MCP requirement and positive completed-turn evidence. A read-only sandbox alone is insufficient proof.

The fixture contract stores two identified byte streams: the bounded, sanitized original host envelope or event stream and the bridge reply bytes submitted to the extractor. When structured_output supplies the verdict, reply bytes are UTF-8 JSON.stringify(structured_output), with no appended newline. reply_sha256 is over those exact reply bytes, never the envelope result string or the raw envelope digest. Fixture metadata labels both digests and their encodings. Any redaction is recorded and never presented as the digest of the original unredacted bytes.

The canonical reply schemas keep their semantic validation. A provider-specific strict projection may require optional properties with explicit null only in that transport projection; normalization removes only nulls at declared optional positions before canonical validation. Unknown keys, missing canonical required fields, ambiguity, unsupported nested shapes and invalid non-null values remain refusals. The projection never changes the canonical schema, silently fills a required field or fabricates a finding. Tests cover both host CLI forms and the API projection without a live provider call. Each separately authorized host experiment stores a valid verdict plus no-tool/no-MCP transcript and resolved host/schema identities.

## Consequences

All substantive predecessor obligations and adversarial acceptance not expressly replaced below remain binding. This record changes no role, threshold, publication consent, historical proof byte, or default write scope.

## Alternatives Considered

Treating every tool_use marker as successful completion is rejected. Disabling only built-in tools while inheriting MCP servers is rejected. Requiring all optional fields in the canonical schema is a compatibility change and is not selected by this draft.

## Affected Rules

- law/schemas/review-verdict.schema.json
- law/schemas/triage-breaker.schema.json
- packages/schemas/src/index.ts
- packages/skills/src/model-bridge/index.ts
- packages/sensors/src/judge.ts
- packages/loop/src/loop/triage.ts
- packages/skills/resources/recipes/devai-verify/SKILL.md
- packages/skills/resources/recipes/devai-verify/devai.recipe.json
- law/policy/sensor-notes/llm_judge.md

## Inspector Adversarial Acceptance

- IA-001 -- A reply reading `Here is my assessment` followed by one fenced or unfenced verdict object yields `pass` through the shared extractor, in the judge sensor and in the orchestrator review step alike.
- IA-002 -- A reply whose verdict is `maybe` yields `error` with a bounded redacted excerpt and the SHA-256 of the full reply, never a silent `unknown`.
- IA-003 -- A reply containing two conflicting candidate objects, or an echoed example beside the real verdict, yields `error`, never the first object.
- IA-004 -- A CLI transport reply cut off by a `length` finish yields `error`, and no transport reports `stop` unconditionally.
- IA-005 -- The tie-breaker rejects a document shaped as a review verdict and the judge rejects a document shaped as a triage classification; neither consumer accepts the other's schema.
- IA-006 -- No request from the bridge carries an assistant prefill, and a provider that offers schema-constrained output receives the consumer's schema on the request.
- IA-007 -- A valid structured host envelope with a positively completed terminal event and no tool or MCP events yields the canonical verdict; truncation, a real tool request or provider failure is still refused.
- IA-008 -- Each host accepts its provider schema projection, canonical validation rejects malformed projected replies, and the isolated live review emits no tool or MCP use; fixtures declare and verify the exact reply byte digest.
