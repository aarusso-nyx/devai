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
