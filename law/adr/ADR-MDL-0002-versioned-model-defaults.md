---
id: ADR-MDL-0002
title: A versioned repository default for model tiers, overridden by reference and pinned at task start
type: adr
status: proposed
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 19 (bump-model escalation)
  - law/constitution.md Article 23 (tie-breaking ladder)
  - law/policy/model-runtime-registry.json
  - law/schemas/campaign.schema.json
  - product/campaigns/CMP-0001-workflow-economy/campaign.json
  - product/campaigns/CMP-0002-self-scorecard/campaign.json
  - ADR-GOV-0023
  - docs/dev/operations/harness-convergence-proposals.md
affected_rules:
  - law/policy/model-tiers.json
  - law/schemas/model-tiers.schema.json
  - law/schemas/campaign.schema.json
  - law/policy/campaign-execution.json
  - scripts/check-campaign.mjs
  - law/policy/model-runtime-registry.json
  - docs/reference/cli/model-runtime.md
  - docs/reference/cli/round-task-executors.md
inspector_acceptance:
  - IA-001 -- Both closed campaigns validate with their `models` blocks byte-for-byte unchanged after the default and the schema change land.
  - IA-002 -- A campaign that declares only a `worker` override validates, and the resolved map for every other tier equals the repository default.
  - IA-003 -- A campaign that names an unknown tier, an effort outside the tier grammar, or a host the default does not declare fails closed at the campaign check.
  - IA-004 -- A task started before a default change keeps its pinned map and `policy_version`; only a task started after the change resolves the new default.
  - IA-005 -- Every host alias the default names resolves through the runtime registry, and a default naming a model the registry cannot resolve fails the law check.
---

# Versioned model defaults

## Status

Proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Binds nothing until the Architect sets it to accepted
before the round that implements it opens. Moves the model tier map from a
required block copied into every campaign to a versioned repository default
under `law/policy`, with campaign overrides by tier name and resolution
pinned on each task when it starts.

## Context

The `models` block of `law/schemas/campaign.schema.json` is required on every
campaign and defines the four tiers `architect`, `worker-high`, `worker`, and
`clerk`, each with a rank, one model per host, a default effort, and a
`use_for` text, plus the escalation rule of Article 19. CMP-0001 and CMP-0002
carry the same host assignments with different `use_for` texts, there is no
default under `law/policy`, and the block names a Codex model that does not
exist. Runtime identity is enforced by `law/policy/model-runtime-registry.json`
in the `runtime:model` form, but `docs/reference/cli/model-runtime.md` and
the round-task-executors page describe an older form. Nothing pins which map
a running task resolved, so a later edit to the campaign's block would
reinterpret a task already in progress. The maintainer decided on 2026-09-28
that defaults freeze at task start, that closed campaigns keep their blocks
byte-for-byte, and that tiers are not renamed.

## Decision

`law/policy/model-tiers.json`, validated by
`law/schemas/model-tiers.schema.json`, holds the repository default of the
`models` block: the tiers with their rank, one entry per declared host as an
object keyed by host id, the default effort per tier, the escalation rule, and
a `policy_version`. The default is law and changes only through a law commit.

In `law/schemas/campaign.schema.json` the `models` block becomes optional. A
campaign that declares it overrides the default by tier name only; a tier it
does not name resolves to the default. An unknown tier name, an effort outside
the tier grammar, or a host the default does not declare fails closed in
`scripts/check-campaign.mjs`. A campaign cannot introduce a host.

The resolved map is pinned on each task at `task_start`, together with the
default's `policy_version`, and the campaign policy records that rule. A
later change to the default or to the campaign override never reinterprets a
started task; escalation under Article 19 climbs the pinned map. Closed
campaigns keep their own `models` block byte-for-byte, since a closed ledger
is evidence, and they validate unchanged because the block remains admitted.

Tier names are unchanged, including `architect`. The collision between the
tier name and the discipline name is documented in the default's description,
not fixed, because the closed campaigns reference the tier and its ceiling.

Runtime ids and effort support resolve through
`law/policy/model-runtime-registry.json`. The default names the host aliases
the hosts publish, `fable`, `opus`, `sonnet`, and `haiku` for Claude and
`gpt-6-astra`, `gpt-6-sol`, and `gpt-6-luna` for Codex, verified against the
host documentation on 2026-09-28 and re-verified at round open. The
non-existent Codex model is corrected once, in the default.
`docs/reference/cli/model-runtime.md` and
`docs/reference/cli/round-task-executors.md` are corrected to the
`runtime:model` registry id form the code enforces.

## Consequences

A new campaign declares nothing about models unless it needs a different
model for one tier, and the host assignments live in one place with a
version. Each task record carries the map it ran under, so an auditor can
read which model a verdict or a change came from without consulting the
campaign at that date. The campaign check gains the override grammar and the
registry resolution, and the law check validates the default against its
schema. Changing a host alias becomes a law change with a version bump, which
is the intended friction.

## Alternatives Considered

Renaming the tiers to a size scale, or renaming `architect` away from the
discipline name, is rejected because both closed campaigns reference the
tier and its escalation ceiling and their ledgers are not edited. Keeping
the block required and copying it forward is rejected because the copies had
already diverged in text while carrying the same assignments. Resolving the
map at each task step rather than at `task_start` is rejected because an
escalation would then climb a map the task never started under. Letting a
campaign declare a new host is rejected because host admission is a registry
and credential decision, not a campaign decision.

## Affected Rules

- `law/policy/model-tiers.json` and `law/schemas/model-tiers.schema.json`:
  the new default and its schema.
- `law/schemas/campaign.schema.json`: the optional `models` block and the
  override-by-tier grammar.
- `law/policy/campaign-execution.json` and `scripts/check-campaign.mjs`: the
  `task_start` pinning rule and the fail-closed override checks.
- `law/policy/model-runtime-registry.json`: the alias resolution the default
  depends on.
- `docs/reference/cli/model-runtime.md` and
  `docs/reference/cli/round-task-executors.md`: the corrected id form.

## Inspector Adversarial Acceptance

Run the campaign check on CMP-0001 and CMP-0002 after the change and confirm
both pass with their `models` blocks unchanged by digest. Validate a fixture
campaign that overrides only `worker` and confirm the resolved map equals the
default elsewhere. Declare a tier `reviewer`, an effort `extreme`, and a host
`gemini` in three fixtures and confirm each fails closed with its own
finding. Start a fixture task, bump the default's `policy_version` and change
one alias, and confirm the started task's pinned map and version are
unchanged while a newly started task resolves the new default. Replace one
alias in the default with a name the registry cannot resolve and confirm the
law check fails.
