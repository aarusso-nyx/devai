---
id: ADR-MDL-0008
title: The provider's own sandbox enforces the experimental attempt write boundary
type: adr
status: accepted
date: 2026-10-05
authority: Architect
supersedes: []
provenance:
  - law/adr/ADR-MDL-0005-opt-in-experimental-agent-execution.md
  - law/adr/ADR-MDL-0007-experimental-completion-recovery-and-capacity.md
  - law/constitution.md
affected_rules:
  - law/policy/experimental-execution.json
  - law/schemas/experimental-execution.schema.json
  - law/schemas/task-execution-evidence.schema.json
  - packages/skills/src/agent-cli/index.ts
  - packages/cli/src/services/experimental-dispatch/authority-process.ts
  - packages/cli/src/services/experimental-dispatch/index.ts
  - packages/evidence/src/task-execution/index.ts
inspector_acceptance:
  - IA-001 -- The broker admits a provider process only when its argv carries that runtime's whole confinement sequence rooted at the spawn cwd; dropping or weakening any confinement flag, or rooting the codex sandbox elsewhere, refuses the spawn.
  - IA-002 -- A runtime with no workspace-confined write mode, or a platform its provider cannot sandbox, refuses with EXPERIMENTAL_SANDBOX_UNAVAILABLE before any lock, worktree or provider is touched.
  - IA-003 -- Every experimental attempt's evidence records the enforced sandbox mode and its flags; the schema refuses a sandbox on evidence not labelled experimental, and the evidence binding refuses a mode its runtime does not enforce.
---

# The provider's own sandbox enforces the experimental attempt write boundary

## Status

Accepted on 2026-10-05. The Owner decided that experimental attempts enforce their write
boundary through the provider CLIs' own sandboxing (issue #290). This record amends
ADR-MDL-0005 D-3, which recorded the provider's containment as requested and never verified.

## Context

ADR-MDL-0005 D-3 asks the provider for its own containment and checks every changed path
against the discipline's Article 6 write scope after the attempt. The check compares
worktree snapshots taken before and after the provider runs. A provider can create a
symbolic link that escapes the worktree, write through it, and remove it before the final
snapshot, so snapshots cannot prove the boundary. Only a filesystem sandbox that is active
while the provider runs can.

Both admitted runtimes ship one. Codex runs model commands under Seatbelt on macOS and
Landlock on Linux; its `workspace-write` mode admits writes only under the working root and
its temporary directories. Claude Code's restricted mode confines its file tools to the
working directory and ignores user, project and local settings; its sandbox setting runs
shell commands under Seatbelt or bubblewrap, and can refuse to start without a backend.

## Decision

1. **Strongest workspace-confined mode.** Each adapter passes the strongest
   workspace-confined write mode its CLI offers, rooted at the attempt worktree:
   - codex: `--sandbox workspace-write --cd <worktree> --ignore-rules`, with no extra
     writable roots and no sandboxed network (`sandbox_workspace_write.writable_roots=[]`,
     `sandbox_workspace_write.network_access=false`). `--ignore-rules` keeps execpolicy
     rules from running a command outside the sandbox.
   - claude: `--restricted --tools Bash,Read,Edit,Write,Glob,Grep`, its sandbox setting
     (`enabled`, `failIfUnavailable`, no unsandboxed commands), `--permission-mode
acceptEdits` and `--permission-prompts none`.
2. **Asserted at the broker.** The broker's exact-argv matcher for `round dispatch` rebuilds
   the adapter argv with the spawn cwd as the worktree and also asserts that the argv carries
   the runtime's whole confinement sequence. Any argv without it is refused.
3. **Refuse what cannot be confined.** A runtime with no workspace-confined mode, or a host
   platform other than macOS or Linux, refuses with `EXPERIMENTAL_SANDBOX_UNAVAILABLE` before
   any lock, worktree or provider is touched. The adapter throws
   `AGENT_CLI_SANDBOX_UNAVAILABLE` for the same cases.
4. **Recorded in evidence.** Every experimental attempt's task-execution evidence carries a
   `sandbox` object: the mode (`codex-workspace-write` or `claude-restricted-sandbox`),
   `enforced_by: provider`, `write_root: attempt-worktree`, and the exact confinement flags
   with the worktree path written as `{attempt-worktree}`. The policy's
   `containment.provider_sandbox` becomes `provider-enforced-asserted-by-broker`.
5. **The snapshot check stays.** The Article 6 write-scope check and the symbolic-link
   check still run after every attempt. They catch writes inside the worktree that fall
   outside the discipline's paths, which no sandbox rooted at the worktree can see.

## Consequences

- An escaping write while the provider runs is refused by the provider's sandbox instead of
  going unseen by the snapshots.
- Claude attempts lose web tools, subagents and MCP servers; they keep sandboxed shell
  commands and the file tools.
- DEVAI asserts the flags it passes; it does not observe the provider's kernel sandbox.
  A provider defect in its own sandbox stays outside DEVAI's proof. Both providers also
  leave their temporary directories writable, outside the repository.
- Experimental evidence written before this decision has no `sandbox` object and stays
  valid.

## Alternatives Considered

- **Runtime enforcement in DEVAI.** Rejected for now: a portable filesystem sandbox around
  an arbitrary provider process is a host-specific mechanism that each provider already
  ships.
- **Keep the containment as requested.** Rejected: the snapshot check cannot prove the
  boundary, and the Owner chose enforcement.

## Affected Rules

As listed in the frontmatter.

## Inspector Adversarial Acceptance

The three counterexamples in the frontmatter must fail against an implementation that omits
the corresponding rule and pass against the candidate. They run against the scripted fake
provider and constructed argv. No live provider call is part of this acceptance.
