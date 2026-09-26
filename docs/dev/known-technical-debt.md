# Known technical debt

This page records current limitations, not completed migrations.

## Inventory parser coverage

The sensor registry declares exactly which stack-pack parameters are consumed at runtime.
Several inventory paths remain framework-specific; a pack name alone is not parser support.
Add a parser only with representative fixtures, conservative unknown/incomplete semantics, and
an adopter that needs it. Generic regular-expression approximations must not be labelled as full
support.

## Local-attestation trust

The immutable package-owned verifier proves receipt integrity, signer identity, candidate binding,
policy binding, and required-node completeness. It cannot prove local execution. Stronger proof
would require a separately designed trusted-execution or remote-execution substrate. Until then,
documentation and UI must preserve the honest trusted-signer boundary.

## Documentation-rule provenance

`ADR-DOCS-GOVERNANCE`, `ADR-DOCS-IA`, `ADR-LOCAL-PUBLISH-WORKFLOW`, and
`ADR-CI-ECONOMY` predate this repository, and their records were not carried forward.
The inherited rules are documented in
[documentation layout](../adopters/docs-layout.md) and
[CI economy](../adopters/ci-economy.md), with enforcement owned by the current
package checks. The historical ADRs must not be treated as present product contracts.

## Toolchain manifest follow-ups

Round R-0101 of campaign CMP-0001 bound the manifest into the runner's
toolchain digest but not into per-task keys, because the vendored evidence
verifier rebuilds task keys without a manifest field and ledger verification
compares the two byte for byte. Folding the manifest into task keys needs a
verifier release. Until then a manifest edit re-keys only tasks whose input
selectors cover `.devai/config/toolchain.json`.

Inline versions still exist outside the manifest in
`scripts/release-host/install-toolchain.mjs`,
`scripts/release-host/provision-dependencies.mjs`, and the node version the
CI scaffold emits from `packages/cli/src/services/ci-scaffold`. The preflight
workflow echoes verifier version 1.5.1 for the in-repo vendored verifier
while the trusted provider is 1.5.4; the checker deliberately does not compare
that literal.

## Class selectors in DEVAI's own descriptor

The check runner evaluates `class` input selectors, but the vendored evidence
verifier under `packages/cli/vendor/evidence-verification` accepts only
exact, prefix, and glob selectors and rebuilds the RC policy from
`test-tasks.json` as written. DEVAI's own `plan:validate`, `law:validate`,
and `docs:validate` nodes therefore carry the prefix and exact selectors
equivalent to the plan, law, and docs bindings until the vendored verifier
learns the `class` kind. Adopters whose verifier is that same package have
the same limit. `scripts/classify-paths.mjs` prints `DEVAI_CHANGE_TAXONOMY_*`
codes while the runtime service uses `CHANGE_TAXONOMY_*`; the script is a
transitional tool.
