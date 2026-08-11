# Adopter-owned test task DAG

DEVAI selects and caches only commands declared by the adopter. It never synthesizes
build, test, migration, or deployment commands. Place `test-tasks.json` at the
repository root before using `check --affected`, `check --local`, or `check --rc`.

The descriptor schema is version `1.0.0`. Each node declares its exact argv, working
directory, dependencies, input selectors, toolchain identity, allowlisted environment,
and output contract. The affected profile must be dependency-closed. The RC profile is
fixed and should name the adopter's complete release gate.

Minimal example:

```json
{
  "schemaVersion": "1.0.0",
  "descriptorVersion": "project-v1",
  "repositoryId": "owner/repository",
  "fallbackNodeId": "test:project",
  "dynamicFallbackSelectors": [],
  "tasks": [
    {
      "nodeId": "test:project",
      "dependencies": [],
      "argv": ["pnpm", "test"],
      "cwd": ".",
      "runner": "project-test-v1",
      "inputSelectors": [{ "kind": "glob", "pattern": "**" }],
      "toolchainKeys": ["node", "pnpm"],
      "allowlistedEnv": [],
      "outputContract": { "kind": "command", "requiredResult": "pass" }
    }
  ],
  "profiles": [
    {
      "profileId": "affected",
      "mode": "affected",
      "requiredNodes": ["test:project"],
      "eligibleNodes": ["test:project"]
    },
    {
      "profileId": "rc",
      "mode": "fixed",
      "requiredNodes": ["test:project"]
    }
  ]
}
```

Use `devai check --affected --task-plan --base <exact-commit> --format json` to
inspect selection before execution. Environment variables affect a task key only when
the node explicitly names them in `allowlistedEnv`; absence and an empty value are
different identities.
