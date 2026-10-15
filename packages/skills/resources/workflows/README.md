# Workflow skills — canonical source and host adapters

A workflow skill is a prose procedure for a DEVAI-governed repository that has no deterministic operation behind it (unlike `../recipes/`). This directory is the **canonical source**; it is never read by a host directly. `devai init` (adapter install) materializes it per host:

| Source file                                                                                                                                | Claude Code output (`.claude/skills/<name>/`)                         | Codex output (`.agents/skills/<name>/`) |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------- |
| `SKILL.md` (spec-only frontmatter: name, description, license, compatibility, metadata)                                                    | `SKILL.md` = body + frontmatter **merged with `claude.overlay.yaml`** | `SKILL.md` verbatim                     |
| `claude.overlay.yaml` (Claude-only fields: `disable-model-invocation`, `argument-hint`, `when_to_use`, `effort`, `allowed-tools`, `paths`) | merged into frontmatter                                               | ignored                                 |
| `agents/openai.yaml` (Codex invocation policy and UI)                                                                                      | ignored                                                               | copied                                  |

Rules the generator must enforce:

- Shared bodies contain no host preprocessing syntax (no `` !`cmd` ``, `$ARGUMENTS`, `${CLAUDE_*}`). A body that needs live facts tells the agent which command to run (e.g. `devai sense --preset governed --format json`) and what to do if it fails.
- `allow_implicit_invocation: false` in `openai.yaml` ⇔ `disable-model-invocation: true` in the Claude overlay. The generator fails if they disagree.
- Validate `openai.yaml` before copying: a malformed sidecar makes Codex fall back to implicit invocation silently.
- Refuse to install when a skill of the same name already exists in another discovery location of the target repo (no duplicate catalog entries).
- The adopter's pinned DEVAI version must support the workflow schema version in `metadata`; otherwise install nothing and say so.

Host execution intent that is not expressible in a skill (hooks for `--no-verify`, push/publish without consent, role-path writes; subagent caps) is compiled into the host's native config (`.claude/settings.json` hooks / `.codex` hooks and rules) by the same adapter, from `law/policy/forbidden-actions.json`.
