# Versioning policy

The v1.0 line publishes one package, `@aarusso-nyx/devai`, and documents its current
44-action surface.

Pin adopter installations to an exact version. Any change to action identity, effect,
authority, schema, configuration, receipt, or task-policy semantics requires explicit review and
a version decision before publication. Human maintainers alone authorize package, tag, release,
or deployment effects.

Use `devai release status`, `devai release drift`, `devai release check`, and
`devai release verify` to inspect the candidate. Those results are inputs to the release decision,
not the decision itself.

The first public lineage begins at annotated tag `v1.0.0-rc.2` in
[`aarusso-nyx/devai`](https://github.com/aarusso-nyx/devai). Published bytes, SBOM,
documentation archive, ledger identity, commit, and tree are joined by the release manifest.

## Prerelease channel ladder

Prerelease identifiers follow the ladder declared by ADR-REL-0028 in
`law/policy/release-lifecycle.json` under `plan_determination.prerelease_ladder`. A
prerelease version takes the SemVer 2.0 dot form `<rung>.<n>`, for example
`1.6.0-alpha.1`. Any other prerelease identifier, such as `1.6.0-nightly.1`, blocks as
`invalid-semver` and is never defaulted to a rung.

| Rung    | Dist-tag | Required capabilities                                                 |
| ------- | -------- | --------------------------------------------------------------------- |
| `alpha` | `alpha`  | the unconditional floor plus `affected-checks` and `dependent-checks` |
| `beta`  | `beta`   | the alpha set plus `unit` and `integration`                           |
| `rc`    | `next`   | the beta set plus the complete RC coverage closure                    |

The RC coverage closure is the capability set a major transition already requires:
`e2e`, `consumer`, `api-compatibility`, `migration`, `rollback`,
`adopter-materialization`, `security`, `database`, `tenancy`, `provenance`, and
`reproducibility`.

Stable versions publish to `latest` only. Each rung publishes to its own dist-tag only, and
no prerelease ever resolves to `latest`.

Within one version core, promotion moves forward one rung at a time or increments the
suffix within a rung. Anything else, including skipping a rung or moving backward, is a
`downgrade` block. Only `rc` promotes to the stable version of that core.

The release intent may declare an optional `channel` (`alpha`, `beta`, `rc`, or `stable`)
derived from the target version. The kernel blocks when the declared channel disagrees with
the version string. The plan kernel identifier stays
`devai.kernel.release-plan-determination.v3`: the ladder adds a rung table and a dist-tag
map without changing any existing transition, block condition, or receipt semantics, so
stable transitions and the existing `v1.5.0-rc.1` lineage resolve exactly as before.
