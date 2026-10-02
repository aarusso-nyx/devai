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

## Reply contract (ADR-MDL-0003)

[ADR-MDL-0003](../../adr/ADR-MDL-0003-live-review-envelope-contract.md) is the
accepted forward Architect disposition, superseding ADR-MDL-0001 while preserving
its substantive obligations. This note specifies the target contract for
CTG-0661; it does not claim the current bridge implements it or that either host
has passed a live review. The sensor's identity, standing (`cell`), tier (`SWEEP`),
bound cell and emitter path remain unchanged.

The canonical consumer contract is
[review-verdict.schema.json](../../schemas/review-verdict.schema.json): `verdict`
from `pass | review | fail | unknown`, `confidence` in [0, 1], nonempty `rationale`
and optional `findings` containing complete sensor-reading findings. The judge
and the campaign review use the shared extractor exposed by the model bridge;
neither parses reply text independently. The sibling
[triage-breaker.schema.json](../../schemas/triage-breaker.schema.json) belongs to
the Article 23 tie-breaker; neither consumer accepts the other's document.

A provider JSON document must validate. Otherwise, text must contain exactly one
unambiguous document, fenced or unfenced. Invalid provider JSON never falls back
to an apparently valid text result. Conflicting candidates, an echoed example
beside a different verdict, malformed fields and missing documents are refused.
`unknown` is the model's explicit Article 39 uncertainty, never a parse fallback.
A malformed or incomplete observation is an `error`, never a model verdict or
readiness evidence. Diagnostics retain only a redacted excerpt of at most 1024
characters and the SHA-256 of the exact full extractor reply bytes defined below.

### Completion and isolation

The bridge admits `finish_reason: stop` only with positive terminal completion
and a valid consumer document. Exit status zero, a parseable object, an absent
stop reason, an `item.completed` event or a read-only sandbox proves none of
those conditions on its own. Error, refusal, truncation, timeout, missing
completion, conflicting terminal results or actual tool/MCP requests refuse the
observation. Failure dominates a later success marker; no retry hides a failed
attempt. A `length` finish remains `reply_truncated`; other incomplete provider
outcomes remain `reply_provider_error`.

For a Claude host envelope, successful terminal completion (`type: result`,
`subtype: success`, `is_error: false`) must be established, and truncation or an
actual tool/MCP event must be absent from the complete transcript. A terminal
`stop_reason: tool_use` is admissible only as the structured-output transport
marker with a present, valid `structured_output`, positive completion and zero
actual tool/MCP events. It is not general permission to accept `tool_use`.
Without that evidence it is refused, including when a valid-looking `result`
string accompanies it. Ordinary text completion requires an affirmative normal
completion reason. An internal structured formatter is identified by the host's
verified transport contract; an arbitrary tool request cannot be reclassified
as a formatter. An unknown envelope/event variant is not inferred complete.

For Codex, `turn.completed` establishes completion only when a unique final
`agent_message` supplies the reply and no `turn.failed`, error, refusal,
truncation, tool/MCP request or contradictory terminal event occurs anywhere in
the stream. A tool item that starts but never completes still refuses the turn.
Multiple incompatible final messages are ambiguous; the adapter never selects
whichever message appeared last. These completion requirements also govern the
API transports: actual tool calls and missing finish evidence remain refusals,
and the Claude host marker exception is not applied to an API tool request.

Both review processes must expose an explicitly empty built-in-tool and MCP
inventory before use. Inherited user/project settings, plugins, hooks, skills,
agent definitions and host integrations must not reintroduce tools, MCP servers
or context. Help-confirmed controls, isolated empty configuration identities and
an inventory/transcript establish that boundary. An unsupported control,
unobserved inventory or configuration that can override the empty set blocks
live admission. `--tools ""` addresses Claude built-ins only; Codex `--sandbox
read-only` controls writes, not tool availability. Neither proves MCP isolation.
The [offline preflight](../../../docs/dev/operations/open-issue-closure-campaign/live-review-preflight.md)
records what the installed hosts actually support and what remains unproved.

### Byte and digest provenance

Every host fixture identifies the bounded sanitized envelope/event-stream file
and the separate reply bytes delivered to the extractor. The envelope digest is
SHA-256 of the stored file bytes, including actual whitespace, line endings and
any final newline. Metadata states whether those are synthetic, sanitized or
unchanged captured bytes; sanitization never receives the label of an original
unredacted digest. Both byte streams use UTF-8 and lowercase hexadecimal SHA-256.

When Claude `structured_output` supplies the document, extractor reply bytes
are exactly UTF-8 `JSON.stringify(structured_output)`, with no appended newline.
The envelope's `result` text is not that reply. For an ordinary Claude text
result or Codex final `agent_message.text`, reply bytes are UTF-8 of that string,
without trimming, fencing changes or an added newline. JSONL separators belong
to the host stream, not automatically to the extracted message. API transports
likewise identify the exact content/structured value selected as their reply.

`reply_sha256` hashes those bytes before normalization, excerpt redaction or
canonical validation. A provider's structured object and `text` must describe
the same selected reply; disagreement is refused. The normalized canonical
document may have its own separately labeled digest, but it never replaces the
reply digest. A fixture's sanitized reply digest proves only those sanitized
bytes; a full original reply digest is recorded only when actually computed
before transformation. Full replies are not stored in sensor findings.
Redaction may remove sensitive metadata from a retained host transcript but
must preserve completion, schema and tool/MCP evidence. If it obscures those
facts, or changes the verdict, admission is blocked. Output-limit truncation
cannot be cured by labeling it diagnostic sanitization.

### Provider projection and canonical validation

The canonical schemas remain byte-exact. Each request carries its consumer's
schema where supported: Claude API `output_config.format`, Claude host
`--json-schema`, Codex host `--output-schema` and OpenAI API schema
`response_format`. No transport uses an assistant prefill. Project from a copy,
remove only provider-inapplicable identity/documentation annotations, and retain
closed objects, required fields, types, enums, numeric/string bounds and array
item validation, including the local finding reference. An unsupported schema
shape fails closed; the bridge never silently weakens it to generic JSON mode.

For a provider requiring every object property in `required`, a strict transport
projection may make a canonically optional property required and nullable. The
review schema has exactly three such positions: `/findings`,
`/findings/*/file` and `/findings/*/line`. `*` means an array element; normalization
uses schema structure, not an unchecked wildcard deletion. Only explicit nulls
at those positions are removed before canonical validation. An absent optional
field is valid on the canonical/text path; a strict provider reply must also
satisfy its declared projection before normalization. The triage schema has no
optional positions and receives no null-removal rule.

Required `verdict`, `confidence`, `rationale`, and required finding `severity`,
`code`, `message` never become nullable. Null array elements, unknown keys,
missing projected fields, missing canonical required fields, unsupported nested
shapes and invalid non-null values are refusals. A normalization pass never
fills a required field, supplies a default verdict, fabricates a finding or
changes a non-null value. Every resulting document validates again through the
canonical `getValidator` path; transport acceptance alone is insufficient.
Record the canonical file digest, exact projected-schema byte digest, projection
version and normalization positions separately from reply provenance.

### Review and acceptance boundary

Inspector acceptance retains ADR-MDL-0003 IA-001 through IA-008, including both
host completion forms, API strict projection, invalid/ambiguous replies and
independently computed envelope/reply digests. Offline fixtures and captured
argv prove deterministic behavior, not provider acceptance. Engineer TASK-0663
implements the contract after the separately authorized Inspector checkpoint.

Live use requires OE-04 human initiation, exact hosts/models, safe input scope,
credential handling and resource caps. A distinct review instance must produce
a canonical verdict with a complete no-tool/no-MCP transcript for each declared
host separately. The campaign review mode remains human under ADR-GOV-0023:
model evaluation never ratifies a gate, dispatches a task, merges or authorizes
an external effect. Neither this note nor offline acceptance grants that use.

## Separate scored soft gate (ADR-MDL-0004)

The optional explicit scored consumer mode uses `soft-gate-score.schema.json`, never a
widened generic review-verdict or triage schema. All existing identity, standing, tier,
command/emitter and completion/extraction/projection/isolation rules remain. Every
Article18 dimension is integer0..4 with structured source citations, and each must
reach3 independently against the exact effective rubric/threshold/source context. PASS additionally requires verdict=pass and complete valid observations; review/fail blocks despite high scores, while unknown or invalid evidence is an evidence error.
Missing observations yield error; zero requires a demonstrated contradiction. A generic
verdict, confidence, average or mutation score cannot replace dimension evidence.

The trusted custodian explicitly invokes the registered scored mode through the
reviewed integrated bridge in a fresh supported native process, with the exact bounded
invocation envelope and actual effective empty tool/MCP/config/context controls. Retain
complete bounded host envelope and unchanged selected reply bytes with separate digests
from canonical score projection. Unsupported/unknown/inherited controls, real tool/MCP
events, absent positive completion, ambiguity, refusal/error/truncation or lost bytes
refuse. Scored replies cannot substitute for generic review or triage, and no transport
projection or normalization silently fills required scored fields or changes legacy
canonical schemas. No provider is invoked automatically in CI.

Independent actual observations, externally selected immutable candidate/control/input
identity and Ed25519 custody together support admission. A signature/self-declared
verified/completed/isolated field alone cannot establish execution or independence.
Exact external trust selection, freshness and all candidate/base/context/citation/
member identities are reverified on the same actual immutable bytes before consumption.
