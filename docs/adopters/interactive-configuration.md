# Interactive configuration

`devai init plan --interactive` authors an adoption plan through prompts driven by the same JSON
schemas that validate every file under `.devai/config`. It is an alternative to assembling flags by
hand, not a new action: the flow adds nothing to the action registry, adds no runtime dependency,
and performs every write through the existing `init bind` and `init apply` actions with an
explicit role declaration and write consent. The non-interactive path described in
[Install and adopt](install.md) remains primary. Everything the interactive flow can produce is
expressible as plan input plus flags, and the flow proves that by printing that command when it
ends. Decision record: ADR-CFG-0001.

## Two modes that never mix

The flow runs in exactly one of two modes, chosen at the first prompt. A session never crosses
from one to the other; changing a bind input and an adopter-owned key are two sessions and two
replayable commands.

### Bind or re-bind

Bind mode materializes from the installed package. It is the interactive equivalent of the
`init bind` and `init apply` sequence in the install guide, and it takes these inputs:

| Input           | Source of the vocabulary                              | Replayed as                                      |
| --------------- | ----------------------------------------------------- | ------------------------------------------------ |
| Tier            | `profile` enumeration: `tier1`, `tier2`, `tier3`      | `--tier`                                         |
| Project type    | `project_type` enumeration                            | plan input for `project.json`                    |
| Repo kind       | `repo.kind` enumeration: `library`, `application`     | plan input for `project.json`                    |
| Docs builder    | `docs.builder` enumeration: `docusaurus`, `jekyll`    | plan input for `project.json`                    |
| Includes        | the `--include` components each apply segment accepts | `--include` on the `init apply` segment          |
| Tracking opt-in | `governance_tracking` binding, off by default         | `--tracking-adapter` and `--tracking-repository` |

A fresh repository binds with `--full`; a bound repository re-binds the segments the installed
package changed, exactly as the upgrade section of the install guide describes. Re-bind is the
only way a materialized policy file changes. Bind mode never edits an adopter-owned key that the
bind inputs above do not cover; it reports such a key as out of scope and names edit mode.

### Edit

Edit mode changes adopter-owned keys only, through their schemas, and refuses everything else.
It never reads the installed package's policy sources and never re-materializes a file. Its writes
are performed by the same `init bind` or `init apply` invocation that owns the touched path, so the
write boundary stays where it already is.

#### Adopter-owned keys in `.devai/config/project.json`

Taken from `law/schemas/project-config.schema.json`:

| Key                                    | Prompt shape                                                                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_type`                         | selection: `runtime-host`, `platform-package`, `docs-archive`, `framework`                                                                                                                           |
| `name`                                 | text, minimum length 1                                                                                                                                                                               |
| `profile`                              | selection: `tier1`, `tier2`, `tier3`                                                                                                                                                                 |
| `adopted_at`                           | text, `date-time` format                                                                                                                                                                             |
| `invariant_filters.include_tags`       | list of text                                                                                                                                                                                         |
| `invariant_filters.exclude_tags`       | list of text                                                                                                                                                                                         |
| `feature_flags.<name>`                 | boolean per flag                                                                                                                                                                                     |
| `authority_enforcement.mode`           | selection: `cli-only`, `host-integrated`                                                                                                                                                             |
| `authority_enforcement.adapter_config` | text, required when the mode is `host-integrated`                                                                                                                                                    |
| `repo.kind`                            | selection: `library`, `application`                                                                                                                                                                  |
| `docs.builder`                         | selection: `docusaurus`, `jekyll`                                                                                                                                                                    |
| `docs.build_command`                   | text, minimum length 1                                                                                                                                                                               |
| `docs.output_dir`                      | text, minimum length 1                                                                                                                                                                               |
| `docs.publish_target`                  | selection: `gh-pages`                                                                                                                                                                                |
| `docs.gh_pages_branch`                 | text, minimum length 1                                                                                                                                                                               |
| `docs.custom_domain`                   | text or empty for none                                                                                                                                                                               |
| `docs.ia.collapsed_sections`           | multiple selection: `theory`, `framework`, `roles`, `adopters`, `reference`, `meta`                                                                                                                  |
| `docs.ia.path_overrides.<key>`         | text per canonical key, minimum length 1                                                                                                                                                             |
| `ci_economy.profile`                   | selection: `full`, `gate-staged`                                                                                                                                                                     |
| `ci_economy.local_evidence.*`          | `manifest_path` text; `max_age_hours` integer 1 to 168; `required_jobs` list; `allowed_platforms` list matching `^(linux\|darwin)/(amd64\|arm64)$`; `forbidden_paths` list; `require_docker` boolean |
| `ci_economy.attested_rc.*`             | `tag_prefix` text matching `^devai-local-evidence/`; `local_only_nodes` list; the remaining keys are constants the schema fixes                                                                      |

The remaining keys of `project.json` are not adopter-owned and edit mode refuses them:
`schemaVersion` is a constant; `devai_version` is machine-managed and stamped by initialization;
`constitution.version` and `constitution.sha256` are refreshed only by
`init bind --constitution`; `governance_tracking` is bound only by `init bind --tracking-adapter`.
Each of those is a bind-mode concern.

#### Adopter-owned binding files under `.devai/config`

Each file is seeded from its law default under `law/policy/adopter-defaults` at bind time and is
thereafter owned by the adopter. Edit mode drives its prompts from the named schema.

| File                                   | Schema                                        | What it declares                                                                                                                                   |
| -------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `change-taxonomy-binding.json`         | `law/schemas/change-taxonomy.schema.json`     | Ordered path selectors that assign every tracked path to one declared change class. It may only use classes the law taxonomy declares.             |
| `toolchain.json`                       | `law/schemas/toolchain-manifest.schema.json`  | Exact runtime versions, pinned action digests with their refs, the trusted verifier, and repository constants workflows must agree with.           |
| `preflight-probes.json`                | `law/schemas/preflight-probe.schema.json`     | The preflight probe list run as task DAG nodes locally and in the pull-request lane.                                                               |
| `credential-requirements-binding.json` | credential requirements schema (ADR-SEC-0001) | Which declared credentials this repository binds. Present only once that binding has been materialized; absent files are not created by edit mode. |

#### Materialized files edit mode refuses

These files must stay byte-identical to their `law/policy` source; `scripts/check-policy-materialization.mjs`
enforces it. Edit mode refuses to touch them and offers a re-bind instead:

- `.devai/config/domains.json`
- `.devai/config/forbidden-actions.json`
- `.devai/config/glob-guards.json`
- `.devai/config/scorecard-na.json`
- `.devai/config/thresholds.json`
- `.devai/config/subprocess-effects.json`
- `.devai/config/release-verification.json`
- `.devai/config/change-taxonomy.json`

The refusal is a structured error, not a prompt to override. Bind records such as
`adopter-policy-binding.json` and the tracking adapter configuration are likewise written only by
`init bind` and are refused in edit mode.

## Prompts come from the schemas

There are no hand-written forms. A field's schema decides its prompt:

- An `enum` (or a `const` with one value) becomes a numbered selection. An answer outside the
  enumeration is rejected at the prompt with the schema's message; it never reaches apply time.
- A `pattern`, `format`, `minLength`, `minimum`, or `maximum` becomes validated text. The answer
  is checked against the schema before the next prompt; the rejection shows the constraint.
- A `description` becomes the help text shown with the prompt, so the vocabulary in the prompt is
  the vocabulary in the schema and cannot drift from it.
- Arrays with `uniqueItems` reject duplicates at the prompt. Booleans are yes or no.

Prompts use the platform readline. No terminal user-interface dependency is added.

## Replay guarantee

The flow ends in this order:

1. It shows the plan diff produced by the non-interactive `init plan` for the answers given.
2. It asks for the role declaration and the write consent that the selected actions require.
3. It runs the existing `init bind` or `init apply` actions; those actions perform every write.
4. It prints the exact non-interactive argv it executed, one command per line.

The printed argv is the record. Running it again without `--interactive` produces the same plan
and the same writes, so evidence records a command, not keystrokes. Every filesystem write during
an interactive session traces to one of the printed `init bind` or `init apply` invocations; a
write that does not is a defect. Declining consent at step 2 ends the session with the plan diff,
the argv it would have run, and no write.

## No terminal attached

The flow needs an interactive standard input and output. When either is not a terminal, or
standard input is closed, `init plan --interactive` exits with the structured error envelope every
action uses (`law/schemas/error.schema.json` on stderr) and performs no write. It never falls back
to defaults, never reads answers from the environment, and never leaves a partial plan behind.
Agents and CI therefore never see a prompt; they use the non-interactive argv the flow prints for
humans.
