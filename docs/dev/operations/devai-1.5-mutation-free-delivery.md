# DEVAI 1.5.0: mutation-free delivery and Bedel extraction

The Owner's mutation-testing mandate applies to DEVAI and its adopter governance.
CI, release certification, prepare, export and publication require no mutation
execution or result. Missing, stale, failed or invalid hardening reports cannot
become delivery prerequisites. Ordinary functional, type, lint, schema, package,
authority, signature and artifact-integrity checks remain required.

## Independent workstreams

The common extraction source is commit
`18fc6cf01645648dfe3b6d5c256a926c3c75ef47`, tree
`3f61e156fae024b8828e6c2cb151577485e935d0`. It differs from the public
`v1.5.0-rc.1` candidate in five files (16 additions and four deletions).
The initial source inventory is [bedel-extraction-inventory.json](bedel-extraction-inventory.json).

DEVAI removes mutation execution and delivery contracts. Bedel independently
extracts from the immutable source into `aarusso-nyx/bedel`. DEVAI 1.5.0 does not
wait for Bedel's build, qualification or release. There is no Bedel dependency
in the DEVAI package. The old preview and historical campaign evidence remain
unchanged.

Ordinary regression tests discovered by mutation campaigns stay in DEVAI. Tests
exclusive to mutation execution are transferred with byte hashes and origin
metadata into Bedel's provenance archive; their executable successors belong to
Bedel's ordinary orchestration tests or explicitly invoked engine qualification.
An archived test is not claimed as passing executable coverage.

## Current CI and export transport

The workflows continue to verify the ordinary ledger and the installed release
export. They use transport schema `3.0.0`: the existing envelope, result, artifact,
toolchain and environment population, plus `release-export.tgz`. The release
export still contains signed exported state, policy closure, task policies and
content-addressed objects. Its ordinary integrity and trust validation is retained.

Current transports contain neither `mutation-input-plan.json` nor
`mutation-export.tgz`. Historical transport versions 1 and 2 remain readable only
when explicitly selected for historical operations; current workflows select 3.
The control verifier checks ordinary DAG, canonicalization, path safety and trust
modules without requiring mutation kernels.

Pack the current release transport using the existing private operator tool:

```sh
python3 scripts/process/evidence_transport.py pack \
  --schema-version 3.0.0 --export <ordinary-ledger-export> \
  --release-export <installed-release-export> \
  --toolchain <toolchain.json> --environment <environment.json> \
  --output <evidence.tgz>
```

Retain separately approved control identities and protected signing/trust inputs.
Before dispatching the new workflow, update its approved process-control commit
and protected transport/configuration references to the exact reviewed current
controls and evidence. Old mutation-required controls cannot certify this release.
No private signing material or protected configuration belongs in public logs.

## Adopter migration

The current release profile has an empty compatibility mutation roster and no
execution template. Minor, major, LTS or risk escalation cannot reactivate it.
Use the existing reviewed binding/migration flow to replace old requirements;
inspect adopter-owned task descriptors and nested scripts for mutation execution.
Do not overwrite customized adopter files silently. Historical receipts are read
under their historical schemas and are not rewritten as current passes.

Mutation-only public entry points return a migration/deprecation result naming
Bedel without starting an engine or subprocess. Source-writing authority still
uses the word mutation in its own contracts; those authorization controls are
unrelated and remain enforced.

## Release acceptance

- No mutation engine dependency or host driver in the installed package.
- No direct or transitive mutation invocation in current delivery paths.
- No mandatory mutation receipt, report or protected mutation export.
- Ordinary package installation, commands, policy materialization and signature
  verification pass with Bedel and hardening results absent.
- Publication uses the signed exact version tag, existing protected environments,
  normalized package checksums and package readback.

Real engine qualification is outside CI and owned by Bedel. A full CLI mutation
campaign is not required to publish DEVAI 1.5.0.
