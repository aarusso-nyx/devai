# Versioning policy

The v1.0 release candidate publishes one package, `@aarusso-nyx/devai`, and documents its current
41-action surface.

Pin adopter installations to an exact RC version. Any change to action identity, effect,
authority, schema, configuration, receipt, or task-policy semantics requires explicit review and
a version decision before publication. Human maintainers alone authorize package, tag, release,
or deployment effects.

Use `devai release status`, `devai release drift`, `devai release check`, and
`devai release verify` to inspect the candidate. Those results are inputs to the release decision,
not the decision itself.

The first public lineage begins at annotated tag `v1.0.0-rc.2` in
[`aarusso-nyx/devai`](https://github.com/aarusso-nyx/devai). Published bytes, SBOM,
documentation archive, ledger identity, commit, and tree are joined by the release manifest.
