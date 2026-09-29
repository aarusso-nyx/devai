# Review reply fixtures

Replies from review evaluators that the shared extractor of ADR-MDL-0001 must read
exactly as they were returned. Each fixture holds the full reply text, bytes
unchanged, so its SHA-256 is the digest a task's `review.reply_sha256` carries and
the excerpt an `error` outcome keeps can be checked against it.

| Fixture                      | Origin                                                                                      | Expected outcome through the shared extractor                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `cmp-0002-rejected-pass.txt` | OE-05: the PASS reply that the CMP-0002 orchestrator session rejected by parsing it by hand | a `pass` verdict document that validates against `law/schemas/review-verdict.schema.json` |

`cmp-0002-rejected-pass.txt` is not in this directory yet. The maintainer supplies
it with owner event OE-05 of campaign CMP-0003 (required before R-0305 closes); the
Inspector tests of wave CTG-0352 read it from this path and must report the missing
file as a diagnostic, never as a pass, until it arrives.

Adding a fixture:

- Store the reply as the host returned it, including any prose around the verdict
  object and any code fence; do not reformat, trim, or pretty-print it.
- Redact anything that is not the reply itself (credentials, tokens, environment
  values, paths outside the repository) before committing, and say so in this table.
- Name the file `<campaign>-<what>.txt` and add one row here with its origin and the
  outcome the extractor must produce.
