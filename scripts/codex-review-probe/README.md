# Codex review probe

Shows exactly which tools `codex exec` would offer the model under the DEVAI review argv (`codexReviewArgv` in `packages/skills/src/model-bridge/index.ts`). No provider is reached and no tokens are spent. Maintainers run it after a codex upgrade or a model-catalog change. See #321.

```sh
pnpm run build                                   # gen-schema.mjs reads packages/schemas/dist
zsh scripts/codex-review-probe/probe.sh capture  # the review argv
zsh scripts/codex-review-probe/probe.sh control  # the same run without the isolation flags
```

**How it works.** codex is pointed at a local endpoint with `-c openai_base_url="http://127.0.0.1:<port>/backend-api/codex"`. That changes where the request goes, not what it contains. `capture-server.mjs` handles each request:

- **WebSocket upgrade:** declines it (426), so codex falls back to HTTP POST.
- **Model catalog read:** forwards it upstream. This costs no tokens and means the request is built from the live catalog. Set `PROBE_LOCAL_CATALOG=1` to skip the forward.
- **Model request:** records it and answers HTTP 400.

`Authorization` is reduced to its kind, other credential headers become `[REDACTED]`, and credential-shaped strings are scrubbed.

**Reading the result.** Results go to `$PROBE_OUT`, by default `$TMPDIR/devai-codex-review-probe/<mode>-<timestamp>/`. Read `summary.txt`:

- `directly offered tools` lists what the model can call. Responses-lite models such as gpt-6-sol carry these in an `additional_tools` input item.
- `nested tools callable from code mode` lists what code mode's `exec` can call.
- The `RESULT` line says whether any command, shell, file-read or web tool is offered.

`tools.json` holds the raw tool items and `requests.jsonl` every recorded request. In capture mode, exit status 1 and a `devai_probe_capture` error are expected.

**Safety.** Extra arguments that could redirect the request are refused: `--profile`/`-p`, `--oss`, `--local-provider`, and anything mentioning `base_url` or `model_provider`. The loopback setting comes last, so it wins. A run whose model request never reached the listener fails with `FAILED: the request did not reach the local listener`. Raw codex output stays in a temporary directory, and only redacted copies are saved. A model request body that cannot be decoded gives no conclusion; it never reads as "no tools". Set `CODEX_BIN` to probe a specific binary.

**Keep in step.** The feature and config lists in `probe.sh` must match `CODEX_REVIEW_DISABLED_FEATURES` and `codexReviewArgv`.
