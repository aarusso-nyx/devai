# Adopter-owned test task DAG

DEVAI selects and caches only commands declared by the adopter. It never synthesizes
build, test, migration, or deployment commands. Place `test-tasks.json` at the
repository root before using `check --affected`, `check --local`, or `check --rc`.

The descriptor contract is `law/schemas/test-task-descriptor.schema.json`, schema
version `1.0.0`. Each node declares its exact argv, working directory, dependencies,
input selectors, toolchain identity, allowlisted environment, and output contract. The
affected profile must be dependency-closed. The RC profile is fixed and should name the
adopter's complete release gate.

RC planning and execution fail closed unless database cases are explicitly enabled with
`DEVAI_DB_TESTS=1` and `DEVAI_DB_URL` names a reachable disposable PostgreSQL database.
The RC environment hashes these allowlisted values into the task identity; never point the
gate at production data. Local and affected targets do not impose this RC-only prerequisite.

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
      "inputSelectors": [
        { "kind": "prefix", "pattern": "src/" },
        { "kind": "exact", "pattern": "package.json" }
      ],
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

The input universe is the repository snapshot seen by Git. DEVAI always excludes
`.devai/state/`, `record/`, and `scratch/` before applying selectors because those
paths contain cache state, harness-written evidence, and declared ephemeral work.
Configuration under `.devai/config/` remains eligible and can invalidate a task.
For cache economy, prefer scoped `prefix` and `exact` selectors; `glob` pattern `**`
means the whole repository except the harness's own writes.

## Local closure root

`--local` selects the dependency closure of a required node named
`test:local-full`. A descriptor that offers the local target must declare that
reserved node id, typically as a cheap aggregate depending on every local suite:

```json
{
  "nodeId": "test:local-full",
  "dependencies": ["test:project"],
  "argv": ["node", "-e", "process.stdout.write('local closure complete\\n')"],
  "cwd": ".",
  "runner": "local-closure-v1",
  "inputSelectors": [{ "kind": "exact", "pattern": "package.json" }],
  "toolchainKeys": ["node"],
  "allowlistedEnv": [],
  "outputContract": { "kind": "marker", "value": "local" }
}
```

Add this object to `tasks`. It does not need to belong to the `affected` or `rc`
profiles; `--local` selects it by its reserved name and includes its dependencies.
Descriptors that do not need `--local` may omit it and continue to use `--rc` and
`--affected`.

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

## Toolchain manifest

The `toolchainKeys` a node declares (`node`, `pnpm`, `git`, and the others the
runner resolves) are compared against one adopter-owned manifest,
`.devai/config/toolchain.json`, whose contract is
`law/schemas/toolchain-manifest.schema.json`, schema version `1.0.0`. DEVAI
materializes it from `law/policy/adopter-defaults/toolchain.json` through the
scaffold; after that the adopter owns the values, because a toolchain is host
truth, not contract. It is therefore not part of the policy materialization
drift check that binds `law/policy` sources to `.devai/config` copies.

The manifest declares four sections:

- `runtimes`: exact versions of `node`, `pnpm`, and `git` without a leading `v`.
  `pnpm` must agree with the `packageManager` field of `package.json`. A workflow
  may pin only the node major; the checker compares the major there and the full
  version where a workflow states one.
- `actions`: a map from GitHub Action repository (`owner/name`) to an object with
  `ref`, `digest`, and optionally `peeled_commit`. `digest` is the immutable
  object every `uses:` reference must carry; `ref` records the tag it was pinned
  from for human review. When the pin is an annotated tag object, `peeled_commit`
  names the commit it peels to so a checker recognizes both identities without
  demanding a repin.
- `verifier`: the trusted release-candidate verifier package by `package` name
  and exact `version`, plus `policy`, the path of
  `law/policy/trusted-local-rc-verifier-package.json`. Tarball digests, the
  source commit, and materialization rules stay in that policy; the manifest
  references it and never copies it.
- `constants`: named repository constants a workflow restates, such as
  `expected_action_count` (the size of the approved action set) and
  `ledger_environment`. A constant that is absent is not checked.

Minimal example:

```json
{
  "schemaVersion": "1.0.0",
  "runtimes": { "node": "24.20.0", "pnpm": "9.15.0", "git": "2.47.3" },
  "actions": {
    "actions/checkout": {
      "ref": "v7.0.1",
      "digest": "3d3c42e5aac5ba805825da76410c181273ba90b1"
    },
    "actions/setup-node": {
      "ref": "v7.0.0",
      "digest": "820762786026740c76f36085b0efc47a31fe5020"
    }
  },
  "verifier": {
    "package": "@aarusso-nyx/devai",
    "version": "1.5.4",
    "policy": "law/policy/trusted-local-rc-verifier-package.json"
  },
  "constants": {}
}
```

One edit to the manifest rolls a pin everywhere: the workflow checker verifies
every pinned value in every workflow against it, the provisioning script reads
it instead of an inline table, and the runner derives the toolchain digest bound
into every task key from it, so editing the manifest invalidates every cached
result. A host whose observed version differs from a declared runtime is reported
as a `BLOCKED` probe naming the observed and required values rather than as a
silent cache miss.

## Preflight probes

A node whose `runner` is `preflight-v1` declares no `argv`. It carries a `probes`
array instead, each item conforming to `law/schemas/preflight-probe.schema.json`,
schema version `1.0.0`, and the runner selects the node unconditionally for every
target so the same probe list executes locally and in the pull-request lane
(ADR-CHK-0001). Each probe names its `class`: an `extrinsic` probe observes the
host, a remote, a credential, or the fetched base, and a mismatch yields the
`BLOCKED` task outcome, marks every dependent node blocked-environment, and is
never written to the cache; an `intrinsic` probe observes the candidate itself and
a mismatch yields `FAIL` like any other node. `BLOCKED` is therefore the fifth task
outcome beside `PASS`, `FAIL`, `SKIPPED`, and `CACHED`. Every probe prints its
`expected` value, its redacted `observed` value, and its `remediation`, so the
report names the fix before any expensive node runs. Probe kinds are
`environment`, `file`, `command`, `git`, `registry`, `toolchain`, and `credential`;
the last two read the toolchain manifest above and the credential manifest.

Example node:

```json
{
  "nodeId": "preflight",
  "dependencies": [],
  "cwd": ".",
  "runner": "preflight-v1",
  "probes": [
    {
      "id": "base-fetched",
      "class": "extrinsic",
      "probe": { "kind": "git", "check": "base-up-to-date", "base": "origin/main" },
      "expected": "candidate contains the fetched origin/main",
      "observed": null,
      "status": "pass",
      "remediation": "Run git fetch origin main and merge or rebase the candidate onto it.",
      "depends_on": []
    },
    {
      "id": "toolchain",
      "class": "extrinsic",
      "probe": { "kind": "toolchain", "manifest_path": ".devai/config/toolchain.json" },
      "expected": "runtimes match .devai/config/toolchain.json",
      "observed": null,
      "status": "pass",
      "remediation": "Install the runtime versions declared in .devai/config/toolchain.json.",
      "depends_on": ["base-fetched"]
    }
  ],
  "inputSelectors": [{ "kind": "exact", "pattern": ".devai/config/toolchain.json" }],
  "toolchainKeys": ["node", "pnpm", "git"],
  "allowlistedEnv": [],
  "outputContract": { "kind": "probes", "requiredStatus": "pass" }
}
```

Make every other node depend on `preflight`, directly or through its dependency
chain, so a blocked environment stops the plan before the first suite starts.
Run `devai check --affected --base <fetched-base-commit>` locally before opening a
pull request; the lane runs the same descriptor against the same base.
