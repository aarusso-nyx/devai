# Install and adopt

DEVAI v1.0rc is distributed through GitHub Packages as one package:
`@aarusso-nyx/devai`. Pin the exact RC version selected by your maintainers; do
not rely on a moving dist-tag.

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
pnpm add --save-dev --save-exact @aarusso-nyx/devai@1.0.0-rc.2
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

## 2. Apply role-owned segments

Run only the segments your reviewed plan calls for. Each mutation requires its
declared role and `--write`.

```bash
pnpm exec devai init apply architect --target . --tier tier1 --as-role architect --write
pnpm exec devai init apply owner --target . --tier tier1 --as-role owner --write
pnpm exec devai init apply harness --target . --tier tier1 --as-role architect --write
```

Use `--force` only after reviewing the exact replacement described by a fresh plan.
Optional hook material is selected explicitly with `--include hooks` and the
corresponding hook/command options shown by `--help`.

## 3. Diagnose and inventory

```bash
pnpm exec devai doctor --repo-root . --format json
pnpm exec devai sense inventory --slice pack --repo-root . --adopter-root . --format json
pnpm exec devai check --affected --task-plan --base <exact-base-commit> --format json
```

Diagnosis and inventory are observations. A PASS applies only to the exact inputs
and freshness bound represented by its result.

## 4. Bind the selected adoption

Inspect the installed candidate's binding contract before use:

```bash
pnpm exec devai init bind --help
```

Binding is explicit. Use only options reported by the installed CLI.
Keep the package version, committed configuration, and recorded evidence under ordinary review.
