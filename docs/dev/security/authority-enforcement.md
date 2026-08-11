# Authority enforcement

Each action descriptor declares its effect, initiating roles, capabilities, consent, planner,
mutation boundary, and final re-verification. DEVAI resolves that contract before dispatch.

Read-only actions need no `--write`. Local and harness mutations require an allowed role (or a
live repository-bound authority session) plus `--write`. A remote effect also requires the
action's separate publication consent; local write consent never implies it.

```bash
devai catalog actions --format json
devai init plan --target . --tier tier1 --format json
devai init apply architect --target . --tier tier1 --as-role architect --write
```

Host shell and editor writes are outside the CLI boundary unless a verified host adapter enforces
them. Repository instructions alone cannot turn an unrestricted host into a containment proof.
