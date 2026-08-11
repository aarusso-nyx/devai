# Role: Owner

The Owner defines product intent, acceptance boundaries, and decisions that require human
authority. The Owner does not implement source, author tests, or silently convert an unresolved
choice into technical policy.

## Working loop

1. Read the current round and task state.

   ```bash
   devai round status --round R-1000 --repo-root . --format json
   devai task status --round R-1000 --task TASK-1000 --repo-root . --format json
   ```

2. Clarify the desired behavior, acceptance criteria, exclusions, and any external-effect
   boundary in the Owner-controlled product material.

3. Review the planned work before authorizing execution.

   ```bash
   devai round plan --round R-1000 --repo-root . --format json
   devai catalog actions --format json
   ```

4. Resolve choices that genuinely require Owner authority. Technical implementation details stay
   with the responsible role unless they alter product behavior or risk.

## Success conditions

- Product intent is observable and testable.
- Acceptance criteria describe outcomes, including failure paths and explicit exclusions.
- Material ambiguities remain visible until the Owner decides them.
- Authorization is bounded; task or round completion never implies publication, deployment, or
  release approval.

## Hand-offs

- The Architect translates product intent into technical contracts and boundaries.
- The Inspector designs independent observations of the accepted behavior.
- The Engineer implements against the current contracts.
- The Auditor reviews evidence and claims without inheriting implementation authority.

## See also

- [Roles](./index.md)
- [Cross-role coordination](./cross-role-coordination.md)
- [Action catalog](../reference/cli/index.md)
