# Review reply fixtures

Replies from review evaluators that the shared extractor of ADR-MDL-0001 must read
exactly as they were returned. Each fixture holds the full reply text, bytes
unchanged, so its SHA-256 is the digest a task's `review.reply_sha256` carries and
the excerpt an `error` outcome keeps can be checked against it.

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

Adding a fixture:

- Store the reply as the host returned it, including any prose around the verdict
  object and any code fence; do not reformat, trim, or pretty-print it.
- Redact anything that is not the reply itself (credentials, tokens, environment
  values, paths outside the repository) before committing, and say so in this table.
- Name the file `<campaign>-<what>.txt` and add one row here with its origin and the
  outcome the extractor must produce.
