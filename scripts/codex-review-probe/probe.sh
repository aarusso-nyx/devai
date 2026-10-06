#!/bin/zsh
# Codex review probe (#321): records the exact tools `codex exec` would offer the model under
# the DEVAI review argv (packages/skills/src/model-bridge/index.ts, codexReviewArgv), without
# reaching a provider. Maintainer-run and offline: it spends no tokens.
#
#   probe.sh capture [extra codex args]   the review argv
#   probe.sh control                      the same run without the review's isolation flags
#
# The only change to what codex sends is the destination,
#   -c openai_base_url="http://127.0.0.1:<port>/backend-api/codex",
# where capture-server.mjs records the request and answers it with HTTP 400.
# Results go to $PROBE_OUT (default $TMPDIR/devai-codex-review-probe)/<mode>-<timestamp>/.
set -u
setopt pipefail
mode="${1:-capture}"
shift $(( $# > 0 ? 1 : 0 ))
extra=("$@")
here="${0:A:h}"
case "$mode" in
  capture) ;;
  control) [[ ${#extra} -eq 0 ]] || { echo "control takes no extra arguments" >&2; exit 2; } ;;
  *) echo "usage: probe.sh capture [extra codex args] | probe.sh control" >&2; exit 2 ;;
esac
# Extra arguments may never redirect the request away from the loopback listener.
for arg in $extra; do
  if [[ "$arg" == (-p|--profile|--profile=*|--oss|--local-provider|--local-provider=*) ]] ||
    [[ "$arg" == *base_url* || "$arg" == *model_provider* ]]; then
    echo "REFUSED: extra argument '$arg' could send the request to a provider" >&2
    exit 2
  fi
done
out="${PROBE_OUT:-${TMPDIR:-/tmp}/devai-codex-review-probe}/$mode-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"
# CODEX_BIN selects a specific binary to probe; by default the codex on PATH.
codex_bin="${CODEX_BIN:-$(command -v codex)}" || { echo "codex is not on PATH" >&2; exit 4; }
"$codex_bin" --version > "$out/codex-version.txt"

# The bridge's private review layout: an empty workspace, the schema file beside it.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/devai-codex-review-probe-XXXXXX")"
workspace="$scratch/workspace"
mkdir "$workspace"
node "$here/gen-schema.mjs" "$scratch/review-verdict.schema.json" ||
  { echo "build the workspace first (pnpm run build)" >&2; exit 5; }

node "$here/capture-server.mjs" "$out" &
server=$!
trap 'kill $server 2>/dev/null; rm -rf "$scratch"' EXIT
for _ in {1..50}; do [[ -s "$out/port" ]] && break; sleep 0.1; done
[[ -s "$out/port" ]] || { echo "capture server did not start" >&2; exit 6; }
port="$(cat "$out/port")"

prompt=$'[SYSTEM]\nReview the diff for correctness. Reply only with the review verdict document.\n\n[USER]\ndiff --git a/src/sum.ts b/src/sum.ts\n-  return values.reduce((total, value) => total + value);\n+  return values.reduce((total, value) => total + value, 0);'

# Keep in step with CODEX_REVIEW_DISABLED_FEATURES and codexReviewArgv.
features=(shell_tool apps browser_use computer_use in_app_browser multi_agent plugins
  image_generation view_image sleep_tool tool_suggest skill_search)
disables=()
for feature in $features; do disables+=(--disable "$feature"); done
isolation=(--config 'mcp_servers={}' --config 'tools={}' --config 'web_search="disabled"'
  --config 'skills.include_instructions=false' --config 'agents.enabled=false' $disables)
[[ "$mode" == control ]] && isolation=()

# The agent-cli environment allowlist the bridge passes (agentCliEnvironment, codex-cli).
envs=()
for name in PATH HOME USER LOGNAME SHELL TMPDIR LANG TERM HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY \
  http_proxy https_proxy no_proxy all_proxy SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS CODEX_HOME; do
  [[ -n "${(P)name-}" ]] && envs+=("$name=${(P)name}")
done
for name in ${(k)parameters[(I)LC_*]}; do envs+=("$name=${(P)name}"); done

argv=(exec --model gpt-6-sol --json --ephemeral --ignore-user-config --ignore-rules
  --skip-git-repo-check --cd "$workspace" --sandbox read-only $isolation
  --output-schema "$scratch/review-verdict.schema.json" $extra
  --config "openai_base_url=\"http://127.0.0.1:$port/backend-api/codex\""
  "$prompt")
print -r -- "${(j: :)${(q)argv}}" > "$out/argv.txt"

# Raw codex output stays in the scratch directory (removed on exit); only redacted copies
# reach $out.
( cd "$workspace" && env -i "${envs[@]}" "$codex_bin" "${argv[@]}" ) \
  > "$scratch/transcript.raw.jsonl" 2> "$scratch/stderr.raw.txt" < /dev/null
echo $? > "$out/exit-status.txt"
sleep 0.5
kill $server 2>/dev/null
wait $server 2>/dev/null

# Scrub credential-shaped strings from what codex printed.
for pair in transcript:jsonl stderr:txt; do
  file="${pair%%:*}"; ext="${pair##*:}"
  sed -E -e 's/sk-[A-Za-z0-9_-]{16,}/[REDACTED api-key]/g' \
    -e 's/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/[REDACTED jwt]/g' \
    -e 's/[Bb]earer [A-Za-z0-9._~+\/-]{16,}=*/Bearer [REDACTED]/g' \
    "$scratch/$file.raw.$ext" > "$out/$file.$ext"
done

# Self-check: a model request that never reached the listener went somewhere else.
if ! grep -q '"model_request":true' "$out/requests.jsonl" 2>/dev/null; then
  echo "FAILED: the request did not reach the local listener; see $out/stderr.txt" >&2
  exit 7
fi

node "$here/summarize.mjs" "$out" | tee "$out/summary.txt" || exit 8
echo "results: $out"
