# Repository scripts

The current root maintenance scripts are:

| Script                                         | Purpose                                                                                                                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/check-campaign.mjs`                   | validate campaign plans under `product/campaigns`                                                                                                                                                        |
| `scripts/check-changesets.mjs`                 | validate release metadata for publishable packages                                                                                                                                                       |
| `scripts/check-workflows.mjs`                  | validate the current receipt-verification workflow shape and check every action digest, node version, and restated constant against `.devai/config/toolchain.json`                                       |
| `scripts/release-host/provision-toolchain.mjs` | build the protected release-host toolchain image; reads runtime versions from the manifest named by `manifest_path` in its controls file and refuses with `DEVAI_TOOLCHAIN_MANIFEST_REQUIRED` without it |
| `scripts/generate-action-registry.mjs`         | regenerate CLI registry projections from policy                                                                                                                                                          |

Treat `package.json` as the canonical command catalog. Run a generator only when its owned
source changed, inspect the diff, and run its matching check mode where available. Generated
output is never hand-edited to make a gate pass.
