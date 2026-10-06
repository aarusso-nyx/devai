# Review reply fixtures

Fixtures retain declared reply bytes and host transcripts for shared-extractor
acceptance. The historical captured reply below is unchanged. CMP-0006 adds
explicitly synthetic offline fixtures; none is a live provider transcript or
proof of provider/schema acceptance or effective host isolation.

| Fixture                      | Origin                                                                                                                                                                                                 | Expected outcome through the shared extractor                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `cmp-0003-rejected-pass.txt` | OE-05: the PASS reply (confidence 0.83) that the `claude-cli:opus` evaluator returned for commit `90d5fc7d` through `claude -p --json-schema` on 2026-09-29, and that the Owner rejected on 2026-09-30 | a `pass` verdict document that validates against `law/schemas/review-verdict.schema.json` |

`cmp-0003-rejected-pass.txt` holds the bytes of the envelope's `result` string exactly
as `claude --print --output-format json --json-schema` returned them (SHA-256
`0d25caada4fafdeeb180faa7d86aaf3a636f53b46bb830bad9476b75d8e5cc2b`); the
`structured_output` field of the same envelope is not byte-identical to it. The
reply the CMP-0002 orchestrator session rejected by parsing it by hand was not
preserved, so the first fixture comes from this campaign's own evaluator run. Nothing
was redacted: the reply names only repository paths.

## Declared reply bytes (ADR-MDL-0003, #249)

A fixture's reply file stores exactly the bytes the bridge hands to the shared
extractor, and its digest is `replySha256` of those bytes, the one function the
judge, the extractor and these tests use for recording and replay:

- Claude with `structured_output` present: UTF-8 `JSON.stringify(structured_output)`,
  no appended newline. The envelope `result` string is not the reply.
- Claude without `structured_output`: the envelope `result` string exactly.
- Codex: the unique final `agent_message.text` exactly, without trimming or JSONL framing.

The ADR-MDL-0001 fixture predates that rule: it stores the `result` string of an
envelope whose `structured_output` was not preserved, so it cannot be re-derived as
structured bytes. It is declared as what it is and replayed on the text path (no
provider `json`), where its bytes are the declared reply bytes.

Codex review isolation is post-hoc. The bridge turns off before launch every
tool-bearing feature that `codex features list --disable` (codex-cli 0.157.1)
reports as off, `shell_tool` included. `unified_exec` still reports enabled, though,
and no offline observation shows the effective tool list. A tool or MCP item in a
Codex transcript refuses the reply, but that cannot undo what the model already read
inside the read-only sandbox. Claude reviews start with no tools and no MCP servers,
and a reply that reports any server-side tool use (`usage.server_tool_use`) is
refused.

<!-- adr-mdl-0001-provenance:start -->

```json
[
  {
    "origin": "captured-live",
    "sanitization": "none; the reply names only repository paths",
    "reply": {
      "file": "cmp-0003-rejected-pass.txt",
      "encoding": "UTF-8",
      "transformation": "UTF-8 envelope result string as returned; structured_output not preserved; replayed as a text reply",
      "bytes": 2813,
      "sha256": "0d25caada4fafdeeb180faa7d86aaf3a636f53b46bb830bad9476b75d8e5cc2b"
    }
  }
]
```

<!-- adr-mdl-0001-provenance:end -->

Adding a fixture:

- Store the reply as the host returned it, including any prose around the verdict
  object and any code fence; do not reformat, trim, or pretty-print it.
- Redact anything that is not the reply itself (credentials, tokens, environment
  values, paths outside the repository) before committing, and say so in this table.
- Name the file `<campaign>-<what>.txt` and add one row here with its origin and the
  outcome the extractor must produce.

## CMP-0006 synthetic transport fixtures

These fixtures exercise ADR-MDL-0003 and the TASK-0661 completion/byte contract.
The two host files and two reply files have separate identities below. SHA-256
covers each stored UTF-8 file exactly, including actual host whitespace, JSONL
separators and final newlines. Each reply file is recomputed independently from
its host file in the operation tests and is hashed before optional-null
normalization. No normalized verdict digest replaces a reply digest.

- Claude: a successful terminal result carries the structured formatter
  `tool_use` marker and `terminal_reason: completed`. `result` deliberately differs
  from the selected `structured_output`; the reply is its exact JavaScript
  `JSON.stringify` serialization with no newline. The completed synthetic stream
  tests add an empty inventory and text event before this terminal.
- Codex: one final agent message precedes `turn.completed`. Its selected reply
  retains leading/trailing whitespace; JSONL framing belongs only to the host
  file. Its strict projected `findings: null` normalizes to an absent canonical
  property. The stored reply keeps that null exactly.

No credentials, original live responses or unredacted originals were used.
The provenance identifies generated synthetic bytes, not a digest of a captured
or sanitized live original. Negative transcripts are constructed in the tests
from these fixtures; their failures and tooling/inventory evidence are retained.
The failure excerpt is diagnostic only, capped at 1024 characters, and the full
selected reply is hashed before redaction. These offline tests require explicit
SDK mocks and fetch/http/https/socket/tls guards; mocked success grants no live
provider call or readiness claim. Codex live isolation remains separately gated
on supported verified empty inventories; no tool-disable flag is invented here.

<!-- cmp0006-provenance:start -->

```json
[
  {
    "origin": "synthetic-offline",
    "sanitization": "none; generated from non-sensitive synthetic values; no captured original exists",
    "host": {
      "file": "cmp0006-claude-envelope.json",
      "encoding": "UTF-8",
      "bytes": 492,
      "sha256": "2c6408cb45b64c83e52c454097337cac87eb50d28d6bf5911b48003505867fba"
    },
    "reply": {
      "file": "cmp0006-claude-reply.txt",
      "encoding": "UTF-8",
      "transformation": "UTF-8 JSON.stringify(structured_output); no appended newline; before normalization",
      "bytes": 121,
      "sha256": "c434de2d250850fd45f51c825c8e66fabb103eb524379f93c04c00c160dfe226"
    }
  },
  {
    "origin": "synthetic-offline",
    "sanitization": "none; generated from non-sensitive synthetic values; no captured original exists",
    "host": {
      "file": "cmp0006-codex-events.jsonl",
      "encoding": "UTF-8",
      "bytes": 397,
      "sha256": "22481883b8c983114456a15f446738be5b8908b06eb255ef84afe09d8f9f82a1"
    },
    "reply": {
      "file": "cmp0006-codex-reply.txt",
      "encoding": "UTF-8",
      "transformation": "UTF-8 unique final agent_message.text; no trimming or added newline; before normalization",
      "bytes": 108,
      "sha256": "bdfd2da04ad8a8e9c987095f668c92f95f5b307eb47cafe74c9aac306ea30c83"
    }
  }
]
```

<!-- cmp0006-provenance:end -->
