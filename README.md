# DEVAI

DEVAI is a human-supervised control harness for AI-assisted software development.
It combines declared roles, bounded effects, repository sensors, validation, and
attributable evidence without replacing a project's build, test, or CI tools.

The DEVAI 1.0 product is one publishable package,
`@aarusso-nyx/devai`. Its current machine catalog contains **41 actions**, **59
sensors**, and **7 host-invoked recipes**. The ordinary public CLI is organized
into seven workflow domains: `init`, `doctor`, `check`, `sense`, `round`,
`evidence`, and `release`. `task` and `catalog` are internal plumbing exposed by
`--all` for maintainers and automation.

```bash
export NODE_AUTH_TOKEN=<github-token-with-read-packages>
printf '%s\n' '@aarusso-nyx:registry=https://npm.pkg.github.com' \
  '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' > .npmrc
pnpm add --save-dev --save-exact @aarusso-nyx/devai@1.0.1
pnpm exec devai --help
pnpm exec devai catalog actions --format json
pnpm exec devai init plan --target . --tier tier1 --format json
pnpm exec devai doctor --repo-root . --format json
```

Mutating actions require their declared role and explicit consent. Read the plan
or dry-run output before granting `--write`; remote effects additionally require
their separately declared publication consent.

Each adopter owns its `test-tasks.json` content-addressed task DAG; DEVAI never
invents project commands. During development, run affected nodes and reuse fresh
PASS results for unchanged inputs. The full coverage gate is the required RC node;
the narrower DB, E2E, performance, and containment commands are diagnostic slices.
A signed candidate receipt binds a clean Git
tree and task-policy digest to trusted local attestations; it does **not** prove
that the signer actually executed the tasks. The pinned external verifier validates
that binding cheaply. Organizationally separate signing and verifier custody remain
prerequisites for calling it independent.

- [Start here](docs/start/index.md)
- [Adopter guide](docs/adopters/install.md)
- [CLI reference](docs/reference/cli/index.md)
- [Developer operations](docs/dev/index.md)
- [Published documentation](https://aarusso-nyx.github.io/devai/)

GitHub Packages requires an authenticated read-only package token for npm installs,
including public packages. Keep the token in `NODE_AUTH_TOKEN`; the committed `.npmrc`
contains only the environment-variable reference and never the credential.

Human maintainers choose scope, review changes, and authorize releases. No command
or evidence record substitutes for that decision.
