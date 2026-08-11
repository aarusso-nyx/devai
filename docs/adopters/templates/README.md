# Adopter templates

These snippets help an adopter preserve evidence files from automatic formatters and integrate
its own commit/lint policy. They are examples, not implicit installation defaults.

- [`lint-staged-snippet.md`](./lint-staged-snippet.md) excludes `record/proofs/**` from formatters.
- `.gitattributes` can disable line-ending normalization for hash-chained evidence.
- `commitlint.config.cjs` can be merged with the adopter's existing commit policy.

Review and merge the relevant lines; do not overwrite established tool configuration. Verify the
result with the adopter's own hooks and `devai evidence verify --scope chain`.
