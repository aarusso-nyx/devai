# Repository scripts

The current root maintenance scripts are:

| Script                                 | Purpose                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| `scripts/check-changesets.mjs`         | validate release metadata for publishable packages       |
| `scripts/check-workflows.mjs`          | validate the current receipt-verification workflow shape |
| `scripts/generate-action-registry.mjs` | regenerate CLI registry projections from policy          |

Treat `package.json` as the canonical command catalog. Run a generator only when its owned
source changed, inspect the diff, and run its matching check mode where available. Generated
output is never hand-edited to make a gate pass.
