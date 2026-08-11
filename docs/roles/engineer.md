# Role: Engineer

The Engineer owns application source and workspace tooling. In a configured adopter repository,
that normally means `packages/**`, `apps/**`, infrastructure code, migrations, and build
configuration. The Engineer does not redefine product intent, architecture law, tests, or human
documentation while acting in this role.

## Working loop

1. Inspect the current task and its declared boundary.

   ```bash
   devai task status --round R-1000 --task TASK-1000 --repo-root . --format json
   ```

2. Start the task with explicit Engineer authority.

   ```bash
   devai task start --round R-1000 --task TASK-1000 --repo-root . \
     --as-role engineer --write --format json
   ```

3. Establish the repository baseline with the affected-task planner and the relevant sensors.

   ```bash
   devai check --affected --task-plan --base main --repo-root . --format json
   devai sense run --preset sweep --round R-1000 --repo-root . --dry-run --format json
   ```

4. Implement only the declared source change. When the specification is silent, contradictory,
   or materially ambiguous, pause instead of inventing policy.

   ```bash
   devai task pause --round R-1000 --task TASK-1000 --gap GAP-1000 \
     --repo-root . --as-role engineer --write --format json
   ```

5. Run the affected checks, read every result, and finish only after the task's required evidence
   is current.

   ```bash
   devai check --affected --run --base main --repo-root . \
     --as-role inspector --write --format json
   devai task finish --round R-1000 --task TASK-1000 --repo-root . \
     --as-role engineer --write --format json
   ```

## Success conditions

- Changes stay inside the task's declared source boundary.
- The implementation satisfies the current contract without weakening its checks.
- Every required affected-task result is PASS for the current inputs.
- Ambiguities become explicit governed gaps rather than guessed requirements.
- No publication or deployment is inferred from task completion.

## Hand-offs

- Ask the Owner when user intent is unclear.
- Ask the Architect when a technical contract or boundary must change.
- Ask the Inspector when observation is missing or demonstrably incorrect.
- Preserve the task and evidence state for the Auditor when a claim needs independent review.

## See also

- [Roles](./index.md)
- [Cross-role coordination](./cross-role-coordination.md)
- [Testing operations](../dev/operations/testing.md)
- [Authority enforcement](../dev/security/authority-enforcement.md)
