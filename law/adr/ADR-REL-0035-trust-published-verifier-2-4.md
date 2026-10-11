---
id: ADR-REL-0035
title: Trust the independently verified published 2.4.0 verifier
type: adr
status: accepted
date: 2026-10-10
authority: Architect
supersedes:
  - ADR-CHK-0006
  - ADR-CHK-0002
provenance:
  - ADR-REL-0002
  - ADR-MUT-0014
  - ADR-SCR-0017
  - law/policy/trusted-local-rc-verifier-package.json
affected_rules:
  - law/policy/trusted-local-rc-verifier-package.json
  - law/policy/adopter-defaults/toolchain.json
  - .devai/config/toolchain.json
  - law/schemas/toolchain-manifest.schema.json
  - law/policy/adopter-migrations.json
  - docs/dev/operations/release-discipline.md
inspector_acceptance:
  - IA-001 -- Materialize only the exact published 2.4.0 package and verify registry identity, SHA1, SRI, source commit/tree, trusted tag signature, raw provenance and all 26 runtime file digests plus exact population and binary map.
  - IA-002 -- The independently pinned 2.4.0 policy builder accepts correctly annotated sensorKinds tasks and reproduces the exact task policy; unknown keys, unsupported output contracts, wrong populations and probe annotations remain refused.
  - IA-003 -- Registered toolchain and generated verifier workflows name the same trusted package and provenance; stale 1.9.0 copies or protected-variable identities remain a visible migration mismatch.
  - IA-004 -- Preserve historical 1.9.0 evidence and immutable published 2.4.0 bytes; no current candidate, vendored edit or annotation stripping can substitute for the trusted published archive.
---

# Trust published verifier 2.4.0

## Status

Accepted for the Owner-authorized audit interface campaign. This advances one
complete trusted pin after publication, following the existing staggered order.
It changes no signer, credential, permission, lifecycle or approval boundary.
All other requirements of ADR-CHK-0002 and ADR-CHK-0006 remain in force, including
one manifest identity, toolchain mismatch refusal, cache identity and the closed
trusted selector-kind set.

## Context

The trusted 1.9.0 package rejects `sensorKinds` while the canonical compatibility
change shipped in 2.4.0 under that earlier pin. DEVAI 2.4.0 has now been published
and independently audited. Embedded support alone was never sufficient to
change the protected verifier executable; a full supported repin is now possible
without another canonical source or immutable package change.

## Decision

Advance `law/policy/trusted-local-rc-verifier-package.json` and the canonical
toolchain source together to `@aarusso-nyx/devai@2.4.0` from the GitHub Packages
registry. Exact verified identity is:

- Package SHA-1: `d650e1cf753720569ec826d8e2b93ead23671140`.
- Package SRI: `sha512-WgiBcsUeSECohocQTnFmsycJRtyjHCHVF0KQ0//sHHb1zT7bHgMW248VmcRQNoaSRpXSOo2BRqIpOtnj2HsgWg==`.
- Package SHA-256: `2965fbb35957aa33378315d558bd1c7034a8e53e1b8a147e2c417a1dbf19c2c5`.
- Release source commit: `9fda759a131c7b7ff43635ad6fa5e4e878f5f836`.
- Release source tree: `5de4bab35aafdaec115ac03cc54a05630204b677`.
- Signed tag object: `1769ab9866dd0077586467fdd4bedec00897d53e` (`v2.4.0`).
- Verifier canonical source: `ad790aea6f200412da79a3a1bfbaa03cbdb47a2d`.
- Raw published verifier provenance SHA-256: `fc79da07d4d4dfa466548337a4944ae1b7e0bfdcf2f1c334b341bb1ad477cd4d`.
- Exact runtime payload: 26 regular files plus the provenance manifest, with the
  unchanged five verifier binary paths. No extra, missing, linked or drifted
  member is admitted. The selector kinds remain `exact`, `prefix`, `glob`.

The Architect independently checked live registry dist metadata, the archived
tarball hashes, each runtime file against the manifest, exact regular-file
population, binary map, local tag commit/tree and its SSH signature against the
approved public signer allowlist. The separately audited publication record
confirms immutable release and published asset equality. No private signing
material is an input to these checks.

The toolchain manifest is adopter-owned under ADR-CHK-0002 and its registered
schema, not a byte-identical operational-law materialization. Current init bind,
init apply and init upgrade do not carry a toolchain-only rewrite;
`interactive-config` explicitly reports this limitation. The Owner-authorized
source change updates only its verifier version to 2.4.0, validated against
`toolchain-manifest.schema.json` and the trusted-policy loader, while preserving
all repository-specific action pins, runtimes and constants. The canonical
default and adopter manifest move together; no new CLI flag is introduced.

Generated adopter attested-RC workflows move through supported host-adapter
binding/upgrade. DEVAI's own protected workflow/checker source changes retain
their governed Engineer authoring and independent review. The root-coordinated protected
repository and environment provenance duplicates must be inspected separately:
an environment-level value can override a historical repository value. Their
new exact value is the provenance digest above. Updating one scope alone does
not establish effective agreement. Record those external changes independently;
this source commit does not claim they have happened.

Canonical sensor task annotations and output contracts retain their full
identity. No stripping, permissive unknown-key handling or changed verifier
bytes are allowed. Subsequent verifier changes still require canonical source,
exact vendoring, publication under the prior trusted verifier and only then a
complete law repin. A currently developing package cannot verify itself.

## Consequences

Supported adopters can migrate to a trusted published verifier that admits
sensor annotations. Existing 1.9.0 receipts and historical packages remain
unchanged. A generated workflow or effective protected variable still naming
the old verifier blocks integration until separately migrated and verified.
Neither the law pin nor publication of 2.4.0 certifies the developing 2.5.0
candidate or closes its other audit interfaces.

## Alternatives Considered

Leaving the trusted executable at 1.9.0 while using annotations would retain the
known schema refusal. Stripping annotations changes task identity. Editing the
trusted archive, partially repinning provenance, trusting the current candidate
or weakening the immutable verifier bypasses the approved order.

## Affected Rules

The trusted package policy moves all identity fields coherently. The toolchain
source and migration guidance expose the required registered generated updates.
Existing selector, materialization, authentication and release discipline remain
mandatory. No historical ADR or artifact is rewritten.

## Inspector Adversarial Acceptance

Discharge IA-001 through IA-004 with exact archive and hostile identity fixtures,
supported annotation admission and wrong-output refusal, registered workflow
generation and independent effective protected-scope verification. Stop on any
unexplained identity mismatch; a merely successful download is insufficient.
