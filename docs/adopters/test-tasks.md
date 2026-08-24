# Adopter-owned test task DAG

DEVAI selects and caches only commands declared by the adopter. It never synthesizes
build, test, migration, or deployment commands. Place `test-tasks.json` at the
repository root before using `check --affected`, `check --local`, or `check --rc`.

The descriptor contract is `law/schemas/test-task-descriptor.schema.json`, schema
version `1.0.0`. Each node declares its exact argv, working directory, dependencies,
input selectors, toolchain identity, allowlisted environment, and output contract. The
affected profile must be dependency-closed. The RC profile is fixed and should name the
adopter's complete release gate.

`argv` is an argument vector, never a shell command. It must contain only strings and
its first item must be a bare executable name matching `^[A-Za-z0-9._-]+$`; absolute
paths, path separators, and `..` are rejected. DEVAI resolves that name from the
repository's `node_modules/.bin` first and then `PATH`, records the resolved absolute
path and file digest in the task key, and invokes it with `spawnSync` and `shell: false`.
The declared `cwd` must resolve inside the repository. A changed executable therefore
invalidates cached evidence, while an undeclared argv, a shell request, or an escaping
working directory is refused before execution.

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
different identities. At execution time DEVAI gives each task only its own allowlisted
values, plus the fixed process-bootstrap environment required to launch the command.
An environment variable declared by one selected node is never inherited by a sibling
node merely because both belong to the same affected or RC graph. Dependency task keys
still propagate normally to downstream nodes.

The example above is directly runnable in a repository whose `package.json` defines a
`test` script and whose environment provides `pnpm`: save it as `test-tasks.json`,
replace `owner/repository` with the repository identity, and run the planning command
before authorizing `devai check --affected --run --base <exact-commit> --write`.
