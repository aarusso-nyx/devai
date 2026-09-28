---
id: ADR-GOV-0020
title: AGENTS.md is the canonical instruction contract and hosts receive generated projections
type: adr
status: proposed
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-GOV-0002
  - ADR-CFG-0001
  - docs/dev/operations/harness-convergence-proposals.md
  - packages/skills/src/bootstrap/index.ts
  - packages/skills/src/recipes/adapters.ts
affected_rules:
  - AGENTS.md
  - CLAUDE.md
  - packages/skills/src/bootstrap/index.ts
  - packages/skills/src/recipes/adapters.ts
  - packages/cli/src/commands/init/apply.ts
  - packages/cli/src/commands/doctor-environment-checks.ts
  - packages/skills/tests/unit/bootstrap.test.ts
  - packages/skills/tests/unit/adopter-bootstrap-contract.test.ts
inspector_acceptance:
  - IA-001 -- Edit AGENTS.md on an adopter checkout, run init apply architect --force, and confirm the guidance is byte-identical afterwards and the execution report names it as preserved.
  - IA-002 -- Plan a bootstrap over an existing AGENTS.md and confirm the plan reports replace for that path and never create or skip-exists when the file would be overwritten.
  - IA-003 -- Replace CLAUDE.md with a full copy of AGENTS.md and confirm the agents-claude-sync doctor check fails until the file is the single @AGENTS.md line.
  - IA-004 -- Run devai init apply harness --include skills and confirm the .claude/skills and .agents/skills projections of every recipe have identical bodies and identical core front matter, with no invocation glyph in any body.
  - IA-005 -- Place a symlink where a recipe projection would be written and confirm the installer refuses with RECIPE_INSTALL_SYMLINK_REFUSED and writes nothing.
---

# Canonical instructions and host projections

## Status

Proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Binds nothing until the Architect sets it to accepted
before the round that implements it opens. Changes the bootstrap's
instruction pair, the `--force` overwrite rule, the `agents-claude-sync`
doctor check, and the recipe front matter; the recipe installer's symlink
refusal is kept.

## Context

`AGENTS.md` is the single development contract for every host, yet the
adopter bootstrap in `packages/skills/src/bootstrap/index.ts` writes `CLAUDE.md`
as a byte-equal copy of it, so every guidance edit must be made twice or the
two files drift. The `agents-claude-sync` check in
`doctor-environment-checks.ts` requires both files to carry the Article 6
reference, the five roles, and the reading-order sources, which DEVAI's own
`CLAUDE.md` does not carry, so the check cannot run against the framework.
`init apply --force` overwrites `AGENTS.md` and `CLAUDE.md` even though the
plan reports them as `skip-exists`, and the execution reports the overwritten
paths separately from the plan, so an adopter who edited the guidance loses it
without warning (#70). The seven recipes under
`packages/skills/resources/recipes` are projected as duplicate trees into
`.claude/skills` and `.agents/skills`, and the installer in
`packages/skills/src/recipes/adapters.ts` refuses symlinks by design
(`RECIPE_INSTALL_SYMLINK_REFUSED`). The maintainer weighed symlinks and set
them aside for Windows checkouts and that guard; projections stay generated.

## Decision

`AGENTS.md` is the only instruction contract. `CLAUDE.md` contains exactly one
line, `@AGENTS.md`, the import form that the Claude Code documentation states
never loads a file twice. A later record removes `CLAUDE.md` once every
maintainer host reads `AGENTS.md` natively, a capability documented from
Claude Code 2.1.277, verified against the published documentation on
2026-09-28 and re-verified when the implementing round opens; that removal is
not decided here.

The adopter bootstrap writes that pair: the full contract into `AGENTS.md`
and the one-line import into `CLAUDE.md`. `init apply --force` never
overwrites `AGENTS.md`, `CLAUDE.md`, or a `README.md` under `law/` once the
file differs from the template the bootstrap would write; the plan reports
`replace` for any existing file the execution will overwrite and never
`create` or `skip-exists` for such a file, so the plan and the execution
report agree before the first byte is written. A preserved file is named in
the execution report as preserved.

The `agents-claude-sync` doctor check verifies that `CLAUDE.md` is the import
line and that `AGENTS.md` carries the required content, and the check runs
against DEVAI's own checkout in the round-close checks, so the framework
satisfies its own rule.

Recipes keep one canonical source under `packages/skills/resources/recipes`
and are projected by generation into `.claude/skills` and `.agents/skills`;
the symlink refusal in `adapters.ts` stands. Recipe front matter converges on
the Agent Skills core set: `name` equal to the directory name, `description`,
`license`, `compatibility`, and `metadata`, and a recipe body never mentions a
host invocation glyph, so the two projections differ in nothing but their
root. Hook convergence is out of scope because DEVAI ships no hooks.

## Consequences

Guidance is edited in one place, and an adopter's edits survive a forced
re-application of the templates. The bootstrap plan becomes truthful about
overwrites, which changes its summary counts and the fixtures that pin them.
`doctor` passes on the framework checkout, so the check can join the round
close. Every recipe gains the five core front-matter keys, which the recipe
validator must require and the projection tests must compare. Hosts that
already read `AGENTS.md` natively load the contract once; hosts that read
`CLAUDE.md` load it through the import.

## Alternatives Considered

Symlinking `CLAUDE.md` to `AGENTS.md` and `.agents/skills` to `.claude/skills`
is rejected for Windows checkouts and for the installer's symlink guard, which
exists so a projection can never point outside the checkout. Deleting
`CLAUDE.md` now is rejected because not every maintainer host has reached the
release that reads `AGENTS.md` natively; that is a separate Owner effect and a
later record. Keeping the byte-equal copy and adding a sync check is rejected
because it preserves the double edit the record exists to remove.

## Affected Rules

- `AGENTS.md` and `CLAUDE.md` at the repository root, the latter reduced to
  the import line.
- `packages/skills/src/bootstrap/index.ts` for the instruction pair, the
  `replace` plan action, and the preservation rule under `--force`.
- `packages/cli/src/commands/init/apply.ts` for the execution report.
- `packages/cli/src/commands/doctor-environment-checks.ts` for the revised
  `agents-claude-sync` check.
- `packages/skills/src/recipes/adapters.ts` and the recipe sources for the
  core front matter and the projection comparison.
- The bootstrap unit and contract suites.

## Inspector Adversarial Acceptance

Edit `AGENTS.md` on an adopter checkout, run `init apply architect --force`,
and confirm the guidance is byte-identical and reported as preserved. Plan a
bootstrap over an existing `AGENTS.md` and confirm the plan says `replace`,
never `create` or `skip-exists`, for a file the execution would overwrite.
Replace `CLAUDE.md` with a full copy and confirm `agents-claude-sync` fails
until it is the single `@AGENTS.md` line. Run
`devai init apply harness --include skills` and confirm both projections of
every recipe have identical bodies and core front matter with no invocation
glyph. Place a symlink at a projection path and confirm
`RECIPE_INSTALL_SYMLINK_REFUSED` with nothing written.
