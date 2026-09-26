---
id: ADR-CFG-0001
title: Offer schema-driven interactive configuration that replays as existing actions
type: adr
status: proposed
date: 2026-09-26
authority: Architect
supersedes: []
provenance:
  - law/constitution.md#article-6-substrate-authority-by-path
  - law/schemas/project-config.schema.json
  - packages/cli/src/commands/init/index.ts
  - docs/adopters/install.md
affected_rules:
  - packages/cli/src/commands/init/index.ts
  - packages/cli/src/services/interactive-config.ts
  - docs/adopters/install.md
inspector_acceptance:
  - IA-001 -- Every write the interactive flow performs is an existing init bind or init apply invocation with an explicit role declaration and write consent, and the flow prints that exact argv.
  - IA-002 -- The interactive flow refuses to edit a materialized policy file and offers a re-bind instead.
  - IA-003 -- An answer that violates the field's schema is rejected at the prompt with the schema message, not at apply time.
  - IA-004 -- With no terminal attached the flow exits with a structured error and performs no write.
---

# Schema-driven interactive configuration

## Status

Proposed. Adds no registry action and no runtime dependency.

## Context

Adoption is already a plan, bind, apply sequence, and every file under
`.devai/config` has a JSON schema with enumerations, patterns, and
descriptions. Seven of those files must stay byte-identical to law and are
changed only by a re-bind; the rest are adopter-owned declarations. Humans
adopting DEVAI read the install guide and assemble flags by hand, and
"change one setting" has no obvious entry point.

## Decision

`init plan` gains an interactive mode that drives prompts from the schemas:
enumerations become selections, patterns become validated text, and
descriptions become help. The flow has two modes it never mixes. Bind or
re-bind materializes from the installed package. Edit touches only
adopter-owned keys through their schemas and refuses materialized files. The
flow ends by showing the plan diff, asking for role declaration and write
consent, running the existing bind or apply actions, and printing the exact
non-interactive argv it executed. Prompts use the platform readline; no
terminal user-interface dependency is added. The non-interactive path remains
the primary path and everything the flow can produce is expressible as plan
input plus flags.

## Consequences

Evidence records a replayable command, not keystrokes. The write boundary
stays in the actions that already own it. Agents are unaffected because they
never see a prompt. A full-screen interface remains possible later without
changing this contract.

## Alternatives Considered

A separate wizard action is rejected because it would widen the registry
for no new effect. Hand-written forms per setting are rejected because the
schemas already carry the vocabulary and would drift from the forms. A
terminal user-interface library is rejected for now because the publishable
closure and bill of materials make every dependency a cost.

## Affected Rules

The init command, a new service that maps schemas to prompts, and the
install guide.

## Inspector Adversarial Acceptance

Trace every filesystem write during an interactive session to an init bind
or apply invocation and confirm the printed argv reproduces the same plan.
Ask the flow to edit a materialized policy file and confirm refusal with a
re-bind offer. Enter a profile outside the enumeration and confirm prompt
rejection. Run with standard input closed and confirm a structured error and
an unchanged tree.
