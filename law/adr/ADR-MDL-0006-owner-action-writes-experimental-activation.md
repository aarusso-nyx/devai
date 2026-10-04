---
id: ADR-MDL-0006
title: An Owner-only action writes the experimental activation record into runtime state
type: adr
status: accepted
date: 2026-10-04
authority: Architect
supersedes: []
provenance:
  - law/adr/ADR-MDL-0005-opt-in-experimental-agent-execution.md
  - law/constitution.md
affected_rules:
  - law/policy/experimental-execution.json
  - law/schemas/experimental-execution.schema.json
  - law/policy/action-registry.json
  - law/invariants/INV-AUTH-002.json
  - packages/cli/src/authority/authority-declarations.ts
  - packages/cli/src/commands/round/dispatch-activate.ts
inspector_acceptance:
  - IA-001 -- Only the Owner role with --write and --experimental can write the activation record; any other role, or a missing consent flag, refuses before a byte is written.
  - IA-002 -- An activation that is schema-invalid, already expired, valid for more than the policy's maximum days, or wider than any policy ceiling refuses and leaves any earlier record untouched.
  - IA-003 -- No action, including init bind and init apply, writes an experimental activation under .devai/config, and a record placed there by hand is never read.
---

# An Owner-only action writes the experimental activation record into runtime state

## Status

Accepted. The Owner chose this amendment to ADR-MDL-0005 D-1 on 2026-10-04, before any
code read an activation record.

## Context

ADR-MDL-0005 D-1 placed the Owner's activation record at
`.devai/config/experimental-execution.json`. Constitution Article 6 lets only the registered
`init apply` and `init bind` actions write `.devai/config/`, materializing it from canonical
package or policy sources, so an Owner-authored record there would itself be an authority
violation. Round tracking already solves the same problem: the Owner-only `round tracking
enable` action validates an activation and writes it under `.devai/state/`.

## Decision

The activation record lives at `.devai/state/experimental/activation.json`. Only a new
preview action, `round dispatch activate`, writes it. Its initiator is the Owner alone, and
its consent is `{ write: true, allow_publish: false, experimental: true }`: it needs both
`--write` and `--experimental`. It reads an Owner-authored input file, validates it against
`experimental-activation.schema.json`, checks the expiry and every budget against
`law/policy/experimental-execution.json`, and only then replaces the record. The consent bit
`experimental` is satisfied only by an explicit `--experimental` on the resolved invocation,
and is never implied by `--write`.

Everything else in ADR-MDL-0005 stands. `round dispatch` reads only this record.

## Consequences

- Activation follows the same Owner-only, consent-gated pattern as round tracking, inside
  the Article 6 table.
- The CLI gains a third consent flag, `--experimental`, which no existing action requires.
- The activation is local runtime state: it is not committed and does not travel with a
  clone, so each checkout is activated deliberately.

## Alternatives Considered

- **An `init bind` selector.** Rejected: it would route an Owner decision through the
  materialization path meant for canonical package and policy sources.
- **An Owner file under `product/`.** Rejected: it would be committed and travel with every
  clone, and it would have no validating action between the Owner and the runtime.

## Affected Rules

The policy and schema activation paths, the action registry, the consent declaration, and
the new handler, as listed in the frontmatter.

## Inspector Adversarial Acceptance

The three counterexamples in the frontmatter must fail against an implementation that
omits the corresponding rule and pass against the candidate.
