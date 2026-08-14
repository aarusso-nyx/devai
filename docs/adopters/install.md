# Install and adopt

DEVAI 1.1 is distributed through GitHub Packages as one package:
`@aarusso-nyx/devai`. Pin the exact version selected by your maintainers; do
not rely on a moving dist-tag.

Prerequisites are Node.js 24 or newer, Git, and a project-local package manager.
The GitHub token needs the `read:packages` scope only for installation.

GitHub Packages requires npm authentication even when the package is public. Create
a GitHub token with read-only package access, expose it to the shell, and keep only
the variable reference in the project `.npmrc`:

```bash
export NODE_AUTH_TOKEN=<github-token-with-read-packages>
printf '%s\n' '@aarusso-nyx:registry=https://npm.pkg.github.com' \
  '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' > .npmrc
```

Do not commit the token or replace `${NODE_AUTH_TOKEN}` with its value.

```bash
pnpm add --save-dev --save-exact @aarusso-nyx/devai@1.1.4
pnpm exec devai catalog actions --format json
```

## 1. Preview

`init plan` is read-only. It describes the files and role-owned segments that an
adoption would create or update.

```bash
pnpm exec devai init plan \
  --target . \
  --tier tier1 \
  --introspect \
  --format json
```

Review the target, tier, existing-file decisions, and every projected operation.
Planning does not authorize an apply.

`doctor` is also safe before binding. Its missing-binding findings are a structured
`review` result, not a transport failure.

## 2. Bind the selected adoption

Bind the installed package contracts before applying the projection. These commands
resolve canonical sources from the installed package, persist `profile` and
`devai_version`, and materialize the runtime authority policy explicitly.

```bash
pnpm exec devai init bind --target . --tier tier1 --constitution --as-role architect --write
pnpm exec devai init bind --target . --operational-law --as-role architect --write
pnpm exec devai init bind --target . --subprocess-effects --as-role architect --write
pnpm exec devai init bind --target . --as-role architect --write
```

An adopter may own one validated policy source under `law/policy`. The source can add client
domains, partially override thresholds, and declare exact scorecard N/A cells and glob guards;
it cannot replace core or framework domains. Binding records the source path and digest and
updates the resolved configuration atomically:

```bash
pnpm exec devai init bind \
  --target . \
  --adopter-policy law/policy/devai-adoption.json \
  --as-role architect \
  --write
```

Invalid schemas, source paths outside `law/policy`, immutable-domain collisions, or incomplete
writes leave the prior resolved configuration unchanged.

## 3. Apply role-owned segments

Run only the segments your reviewed plan calls for. Each mutation requires its
declared role and `--write`.

```bash
pnpm exec devai init apply architect --target . --tier tier1 --as-role architect --write
pnpm exec devai init apply owner --target . --tier tier1 --as-role owner --write
pnpm exec devai init apply harness --target . --tier tier1 --as-role architect --write
```

Use `--force` only after reviewing the exact replacement described by a fresh plan.
Optional hook material is selected explicitly with `--include hooks` and the
corresponding hook/command options shown by `--help`. The default hook invokes the
project-local `./node_modules/.bin/devai`, never a presumed global executable.

After the package and policy are bound, install each selected host adapter through the binding
facade. Bind GitHub Actions before the local post-merge adapter when both are required so the
selected host-policy identity is the local adapter while `doctor` continues to verify both:

```bash
pnpm exec devai init bind --target . --host-adapter github-actions --as-role architect --write
pnpm exec devai init bind --target . --host-adapter post-merge --as-role architect --write
```

The GitHub adapter authenticates exact-main observations with GitHub OIDC. Its workflow may write
only `refs/devai/post-merge/<sha>`, and only after both the dispatch input and repository consent
variable authorize publication. Neither adapter claims control over arbitrary editors or shell
commands.

Core files and requested includes are preflighted before the first write and applied
as one rollback-capable transaction. A preflight conflict writes nothing. If the
process is forcibly terminated, inspect the fresh `init plan`, remove only files that
match that plan and were created by the interrupted attempt, then rerun the segment.

## 4. Diagnose and inventory

```bash
pnpm exec devai doctor --repo-root . --format json
pnpm exec devai sense inventory --slice pack --repo-root . --adopter-root . --format json
```

Diagnosis and inventory are observations. A PASS applies only to the exact inputs
and freshness bound represented by its result.

For one exact commit, the Auditor facade regenerates the complete non-promoting observation in
one operation. Deterministic triage accepts one schema-valid SensorReading and records its route;
an inconclusive reading always escalates to a human.

```bash
pnpm exec devai audit observe --repo-root . --at <full-sha> --as-role auditor --write --format json
pnpm exec devai triage classify --repo-root . --input <reading.json> --as-role inspector --write --format json
```

## 5. Declare the adopter test DAG

DEVAI does not guess a project's build or test commands. Create and review the
adopter-owned `test-tasks.json` first; see [Task DAG configuration](test-tasks.md).
Then affected planning is available:

```bash
pnpm exec devai check --affected --task-plan --base <exact-base-commit> --format json
```

Without the descriptor, `check --affected`, `--local`, and `--rc` return the dedicated
`CHECK_TASK_DESCRIPTOR_MISSING` precondition diagnostic and never invent commands.

## Remove DEVAI

First remove hook marker blocks (or the whole DEVAI-created hook if it contains no
other project logic). Then remove `.agents/skills/devai-*`, `.claude/skills/devai-*`,
the reviewed DEVAI-owned `.devai/` materialization, and empty generated
`record/proofs`, `record/derived/inventory`, and `scratch/worktrees` directories.
Preserve non-empty evidence, inventory, project configuration, and shared hook content
until a maintainer has archived or deliberately disposed of it. Finally remove the
package dependency and the GitHub Packages `.npmrc` entry if nothing else uses it.
