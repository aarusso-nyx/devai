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

## Current CI and ordinary ledger transport

CI verifies the ordinary signed ledger using transport schema `1.0.0`, which
contains the existing envelope, results, artifacts, task policy and execution
identity maps. Existing protected base64 secrets remain the default transport.
An explicitly configured ordinary bundle remains supported. A private evidence
repository, installed-control carrier and installed release export are not
prerequisites for delivery.

The workflows no longer materialize or verify the installed export ceremony
introduced for mutation testing. Release manifests no longer require its control
or offline-receipt digests. Ordinary ledger signatures, candidate identity,
artifact hashes, exact rehearsal and publication controls remain mandatory.

The standalone export readers and transport versions 2 and 3 remain available
for explicit historical or optional operations. They are isolated from the
current CI and release readiness paths; absent or invalid optional exports
cannot block publication.

Retain separately approved process-control identities and protected signing/trust
inputs. Before dispatching the new release workflow, pin the reviewed ordinary
process-control commit and update ordinary ledger evidence for the exact
candidate. No private signing material or protected configuration belongs in
public logs.

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
