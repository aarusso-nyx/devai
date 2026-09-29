---
id: SENSOR-NOTE-llm_judge
title: Llm Judge
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: llm_judge
emitter: packages/sensors/src/judge.ts
standing: cell
tiers: [SWEEP]
---

# Llm Judge

This note defines `llm_judge`. Its canonical emitter
is `packages/sensors/src/judge.ts`.

Bound cells: F1×T3.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.

## Reply contract (ADR-MDL-0001)

ADR-MDL-0001 is the Architect disposition this note requires for a change to the
emitter. Under it the sensor reads its reply as a document in the shape
`law/schemas/review-verdict.schema.json` declares: `verdict` from
`pass | review | fail | unknown`, `confidence` in [0, 1], `rationale`, and optional
`findings` in the sensor-reading finding shape. The emitter obtains the document
through the one shared extractor in the model bridge
(`packages/skills/src/model-bridge/index.ts`), never through a bare `JSON.parse` of
the reply text. A reply the extractor cannot reduce to exactly one valid document,
including a `length` finish, two conflicting candidates, an echoed example beside the
real verdict, or a malformed field, is an `error` reading whose finding keeps a
bounded redacted excerpt and the SHA-256 of the full reply; `unknown` is the model's
explicit uncertainty under Article 39 and never a parse fallback. The sibling contract
`law/schemas/triage-breaker.schema.json` belongs to the Article 23 tie-breaker, not to
this sensor, and the judge refuses a document in that shape.

The sensor's identity, standing (`cell`), tier (`SWEEP`), bound cell, and emitter
path are unchanged by this disposition.
