# Live review preflight — offline TASK-0661 checkpoint

Current execution authority is the [standing Owner decision](execution-discipline.md).
It supersedes earlier preparation-only and repeated routine authorization text;
exact evidence, role boundaries, substantive unresolved contracts and actual
performance gates remain. The task-entry narrative below is historical checkpoint evidence. Its old
permission stops are superseded; inspections, contracts, failures, actual models
and original approvals remain preserved. It does not describe a fresh human
review of later candidates.

This is the Architect's offline contract and installed-host inspection for
CTG-0661 under [ADR-MDL-0003](../../../../law/adr/ADR-MDL-0003-live-review-envelope-contract.md)
and [ADR-GOV-0023](../../../../law/adr/ADR-GOV-0023-review-boundaries.md).
No provider call, paid review, credential change or runtime review record was
produced. OE-04 initiation, exact safe inputs and numerical resource caps remain
pending. The campaign review mode is human. Offline fixtures do not establish
live readiness, and an accepted verdict never ratifies a gate or effect.

## Exact source and assignment

The inspected source is TASK-0661 on
`codex/R-0606-TASK-0661-review-transport`, entry HEAD
`970514e90ebbdb0d2f6d7de6722619585715c973`, tree
`98fc52ce988c3ce679276e9ed3e13d0d26bf93fb`. The last-fetched and remotely
rechecked main is `180a122787193f9bdfce9b7f4cd5600e85ae7854`. R-0606 depends
only on the human-ratified R-0601 source checkpoint; CTG-0661 has no wave
predecessor. Later inherited TASK-0621/TASK-0622 source checkpoints are preserved,
including all dependency RED-test bytes. No uncommitted TASK-0623 source is used.
A source checkpoint does not close a round or set `merged_as`.

The default model map is pinned at policy version `1.0.0`, file SHA-256
`98831e71e465dd6c6cf950890ab1235204555fb7eca9b31d67278a614fa13e7f`.
The campaign has no model override. The declared assignment is Architect,
`architect/high`, resolving to `codex-cli:gpt-6-astra` on Codex and
`claude-cli:fable` on Claude. This design chat's actual host turn context reports
`gpt-6.1-sol`, effort `high`, with no creation override. That model mismatch is
recorded for human disposition; it is not reported as execution under the
resolved tier. No numerical allowance or resource exception is inferred.

The exact task prompt SHA-256 is
`23b6d1449cb0f6150ead68f2c0e8fb6ef7afe488627adf9fd6ba2438f0e2de4e`.
The entry verified all 77 manifest file hashes, policy pins, accepted records,
predecessor receipts and the complete disjoint wave reservation. Entry and raw
inspection logs remain in the task-local source coordination directory, outside
the repository artifact population; they are not runtime proofs. The entry
manifest covers the original draft bytes. Editing this owned preflight makes its
manifest entry stale; only an authorized planning refresh can repin it. The
checkpoint proposal records the candidate's new owned-file digests separately.

## Installed hosts observed on 2026-10-02 UTC

Only local version, help and configuration-location inspection ran. No `claude
--print`, `codex exec` review or model invocation ran. Help hashes identify the
full captured UTF-8 stdout, including its final newline.

| Host        | Installed version | Help command        | Help stdout SHA-256                                                |
| ----------- | ----------------- | ------------------- | ------------------------------------------------------------------ |
| Claude Code | 2.1.277           | `claude --help`     | `ae85d661e9c086f05637ebcd868f5702b477ff6e55e2e65b8ada7807cd51a4b6` |
| Codex       | codex-cli 0.157.1 | `codex --help`      | `4a7f0188d4d6e6d812c5cfbcf82468336b899acd5e437de7450421a403c0071e` |
| Codex exec  | codex-cli 0.157.1 | `codex exec --help` | `0e82cfde0122715250e93dc65866caa956b2ac5b9d0b20ec4ad4f9e81486509e` |

Claude resolves through the Homebrew Cask installation for 2.1.277; Codex through
the Node 24.15.0 global package launcher. Exact local paths, hashes and raw help
are in `host-preflight.json` and the associated task-local logs. The Codex
launcher hash identifies the JavaScript launcher, not independently the native
binary it launches; live preflight must also pin that binary and its version.
These observations do not verify model alias availability through a provider.
Refresh them if the installed executable, help, schema or candidate changes.

## Configuration isolation to prove before live use

Location inspection found user Claude `settings.json`, skills and plugins, and
user Codex `config.toml`, `AGENTS.md`, rules, skills, plugins and `auth.json`.
Neither `.claude/` nor `.codex/` exists in the assigned checkout. The user roots
are the conventional home directories `.claude/` and `.codex/`; exact locations
are retained locally. File contents and credentials were not copied into this
preflight. Absence of project directories does not prove absence of ancestor,
managed, system, connector or plugin configuration.

Empty offline templates were prepared only under the task's own source-pending
`isolated-config/` directory. They have not been loaded by a reviewer and contain
no credential, model override, server or plugin:

| Template               | Exact UTF-8 bytes                                | SHA-256                                                            |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| `claude-settings.json` | `{}` plus LF                                     | `ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356` |
| `claude-mcp.json`      | `{"mcpServers":{}}` plus LF                      | `e93fc8db2b1bd77107fe6c758bca9545fa864cf7cce8ab93a7b2b93a1d566a7b` |
| `codex-config.toml`    | Empty-policy comment plus LF; see local template | `1db27e3863e4a53b1eda9bb7c94d5bcdf1899f4f693db4c66b0d3e4b08a5bb05` |

A blank file is not an isolation guarantee. Before OE-04, the implemented adapter
must identify the exact process working directory, every loaded configuration
source and its precedence, and the effective empty tool/MCP inventory. An
isolated working directory contains only the explicitly scoped input bundle,
with no project/ancestor configuration or automatic repository context. Any
required process-private host root is prepared separately without changing the
user's host root or copying credentials. Empty templates above are artifacts of
offline preparation, not a new grant to configure a live process.

### Claude controls confirmed by installed help

- `--tools ""` disables the built-in tool set. It does not disable MCP.
- `--strict-mcp-config` ignores other MCP configurations; combine it with
  `--mcp-config` naming the exact empty-server file.
- `--setting-sources` selects user/project/local sources, and `--settings`
  names explicit settings. An empty selection must be demonstrated to exclude
  those sources, not presumed from the file being empty.
- `--restricted` ignores user/project/local settings; managed settings and
  `--settings` still apply. It removes some tools, not the whole tool set.
- `--safe-mode` disables customizations including MCP, hooks, skills, plugins
  and auto-discovered instructions; managed policy still applies and built-in
  tools remain available unless separately disabled.
- `--bare` skips hooks, LSP, plugin sync, auto-memory, prefetch and instruction
  discovery. Skills can still resolve. It changes authentication behavior to
  explicit supported credentials/helpers; this task does not enable it or
  configure an authentication helper.
- `--disable-slash-commands`, `--no-chrome` and `--no-session-persistence` are
  additional supported controls. They do not replace empty inventories.
- `--json-schema` and JSON/stream-JSON output modes are advertised. The live
  evidence must include the full event transcript, not just the final envelope.

These are inspected controls, not a tested launch recipe. The Inspector/Engineer
must capture the exact argv and configuration precedence offline. Managed policy
that reintroduces a tool, server, hook or context blocks admission. A structured
formatter marker is permitted only under the exact completion exception below;
an actual tool request is never whitelisted as a formatter by name alone.

### Codex controls confirmed by installed help

`codex exec` advertises `--ignore-user-config`, `--ignore-rules`, `--strict-config`,
`--ephemeral`, `--json`, `--output-schema`, `--sandbox read-only`, `--cd` and
feature enable/disable controls. `--ignore-user-config` skips the user
`config.toml` but still uses the host root for authentication. It does not claim
to skip all project/system configuration. `--ignore-rules` addresses execpolicy
rules; it does not disable tools. `--strict-config` rejects unknown config
fields; it does not prove a recognized field has the desired isolation effect.

The local `codex features list` inspection reports available tool-bearing
features, including shell, apps, browser/computer use, plugins and multi-agent
facilities. That listing describes the ambient host, not an isolated reviewer.
Neither the inspected help nor the feature list establishes a universal
no-tools/no-MCP mode. Do not invent `--tools`, a wildcard MCP disabling key or an
unverified configuration override. Disabling the shell feature alone leaves
other possible tools. A read-only sandbox can still read or invoke tools.

Codex live admission stays blocked until supported installed configuration or a
verified adapter can prove the effective tool list and MCP-server list are both
empty, including plugin/app integration and automatically discovered context.
An unsupported control or inadequate isolation must be reported to the human;
there is no fallback to a prompt asking the model not to use tools. These gaps
do not prevent review of the offline Architect contract.

## Completion, schema and byte admission

The [sensor note](../../../../law/policy/sensor-notes/llm_judge.md) is the exact
shared contract. Positive terminal completion, empty inventories and zero actual
tool/MCP events are conjunctive requirements. Exit zero or schema-valid text
alone is insufficient. A failure anywhere dominates a later completion.

| Transport observation                                                                                                                          | Admission                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Claude successful terminal result, valid `structured_output`, transport `tool_use` marker, no error/truncation and zero actual tool/MCP events | Eligible for canonical verdict validation        |
| The same marker without structured output or terminal success, or with an actual tool request                                                  | Refuse; never infer completion                   |
| Codex unique final agent message plus `turn.completed`, with no tool/MCP or failure event                                                      | Eligible for canonical verdict validation        |
| Codex final item without completed turn, multiple incompatible finals or a tool item starting then aborting                                    | Refuse                                           |
| Either host truncated, timed out, refused, errored or not fully observed                                                                       | Observation error; no verdict or readiness claim |

Canonical source file digests at entry:

- `review-verdict.schema.json`:
  `c47b3b45218663d63f23162c73b2cfe010045ba841fcae1ff4d3bd85eb726f35`.
- `triage-breaker.schema.json`:
  `6241a0dab9c590388cf46e177124833816ee96b75ba1e36536bf93db30105856`.

Record a separate digest for the exact provider projection bytes sent with each
request. Strict transport projection may require nullable `findings`, finding
`file` and finding `line`, and no other canonical position. Normalize only those
explicit optional nulls, preserve every non-null value, then validate through the
canonical schema. Unknown keys, required nulls, missing strict projected keys,
unsupported shapes and invalid non-null values are refused. Both CLI forms and
the API projection need offline counterexamples; the API check grants no API
call. Schema-constrained requests have no assistant prefill.

Each fixture identifies two stored byte streams with separate file identity,
UTF-8 encoding, transformation history, byte count and independently recomputed
SHA-256: the bounded sanitized host envelope/JSONL stream and the extractor
reply. For `structured_output`, reply bytes are exactly UTF-8
`JSON.stringify(value)` without an added newline, before optional-null
normalization. For text, use the selected message string without trimming or
adding a newline. Envelope whitespace/JSONL delimiters are hashed only as part
of the envelope file. A normalized verdict digest, if retained, is a third
labeled identity. Never substitute the envelope `result` string, canonical
verdict serialization or a sanitized excerpt for the reply digest.

Sanitization is declared: a stored sanitized transcript digest proves those
bytes, not original unredacted bytes. Sensor diagnostics retain a redacted
excerpt capped at 1024 characters plus the full reply digest actually computed
before redaction. Sensitive metadata can be removed without deleting evidence
of tools or completion. If sanitization changes the verdict or prevents those
facts from being checked, live admission is blocked. Synthetic offline fixtures
are labeled synthetic; no live transcript is fabricated.

## Focused offline validation and later effect boundary

From the exact isolated checkout, install the pinned Node/pnpm toolchain and
frozen dependencies, then run `pnpm run build` and `pnpm run release:bootstrap`.
The registered generators may only materialize their declared build/bootstrap
outputs; tracked nonowned source bytes must remain unchanged. The Architect's
three declared acceptance commands are:

```bash
node .devai/state/pr-bootstrap/cli/bin.js check --only adrs --format json
node .devai/state/pr-bootstrap/cli/bin.js check --only schemas --format json
node .devai/state/pr-bootstrap/cli/bin.js check --only docs-links --format json
```

Run changed-file formatting, applicable lint and whitespace checks. Save raw
outputs, exact uncommitted candidate tree/diff, command identities, all failures
and owned-file digests in the source checkpoint proposal. Separate proposed
`law(sensors)` and `docs(operations)` commits satisfy the current single-family
policy. No commit or checkpoint ratification is authorized by passing checks.
Only a distinct qualified human may review and ratify the concrete candidate.
A later planning/manifest refresh is separate Owner authority; never modify a
campaign prompt or manifest merely to make it agree with this design diff.

Before OE-04, obtain the exact per-host/model initiation, input digest and safe
scope, output/token/cost/time caps and permitted credential channel. There is no
automatic retry, host substitution or spending authority. A distinct qualified
review instance runs with isolated context; both declared hosts pass separately.
Retain supported executable/config/schema identities, an inventory and complete
bounded sanitized transcript, zero tool/MCP events, positive completion, exact
reply digest and canonical verdict validation. A failure is reported and retained.
Until then, no live experiment, downstream role dispatch, source publication,
issue effect, merge, release or deployment is inferred from this checkpoint.
