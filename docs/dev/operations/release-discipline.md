# Release discipline

The release surface evaluates and records evidence; it does not grant publication authority.
Human maintainers authorize package, tag, release, deployment, and rollback effects separately.

## Inspect

```bash
devai release status --repo-root . --format json
```

## Check a candidate

```bash
devai release check \
  --repo-root . \
  --scorecard ./record/proofs/scorecard.json \
  --artifact <immutable-artifact-ref> \
  --environment staging \
  --audit-chain-head <sha256> \
  --strict --as-role auditor --write --format json
```

The check consumes supplied evidence and records its verdict. It does not build, publish, or
deploy the artifact.

## Verify and inspect drift

After a separately authorized deployment, compare the artifact and observed runtime:

```bash
devai release verify --artifact <immutable-artifact-ref> \
  --artifact-chain-head <sha256> --audit-chain-head <sha256> \
  --environment staging --strict --as-role auditor --write --format json

devai release drift --artifact <immutable-artifact-ref> \
  --observation route-set=changed --environment staging \
  --strict --as-role auditor --write --format json
```

`release verify` may instead consume an API runtime charter; `release drift` may consume an API
or auth charter. The operator owns credentials, target selection, deployment, and rollback.
Treat missing, malformed, partial, or unknown evidence as a stop condition.

## Publish a public release

The parameterized `.github/workflows/release.yml` accepts a version tag only when it equals
`v` plus the public package manifest version. The tag must be annotated and its signature
must verify. The workflow uses the authentic immutable `pnpm/action-setup` v4.1.0 annotated
tag object (`7088…`, peeled commit `a748…`) and lets the root `packageManager` field select
the pnpm version.

The protected ledger is checked by a pinned external verifier. Do not call that verifier
independent until signing and verifier custody are organizationally separate. The build job
installs frozen dependencies, builds the package and Docusaurus site, checks publishable
closure, and creates a normalized public manifest with development workspace dependencies
removed. Two clean packs must have identical bytes. The CycloneDX SBOM is generated from
that normalized manifest and is rejected if a private `@devai-nyx/*` package appears.

Release tags use SSH signatures. The public identity is supplied through the protected
`DEVAI_RELEASE_SIGNERS_B64` environment secret and materialized as an OpenSSH allowed-signers
file; candidate source does not choose its own tag signer. The verified signer-file digest is
bound into the Release manifest.

A failed rehearsal tag is never moved or deleted. Remediation advances the prerelease version and
creates a new signed annotated tag so every attempted candidate remains auditable.

The GitHub Release manifest and `SHA256SUMS` are the canonical release identity. Existing
Release assets must match byte-for-byte; recovery is a no-op on a match and a hard refusal on
any mismatch. Assets are never uploaded with `--clobber`. GitHub Packages is a convenience
mirror: the workflow publishes the exact canonical tarball and downloads the registry copy to
verify the same digest. Pages is deployed in GitHub Actions mode from the exact site archive
named by the canonical manifest.

Prerelease versions create a GitHub prerelease and use the `next` package dist-tag. A version
without a SemVer prerelease component creates a normal GitHub Release and uses `latest`. The
manifest records the derived release type, prerelease boolean, and dist-tag; recovery verifies
that the existing Release and registry tag match that identity.

Pushing the signed annotated version tag runs protected-ledger verification, frozen installation,
build, publishable-closure checks, deterministic double-pack, SBOM creation, site creation, and
manifest assembly. The tag-push path verifies the uploaded workflow artifact and stops without
publishing. A manual dispatch with the same exact `release_tag` and `publish: false` repeats that
non-publishing rehearsal.

After a green rehearsal and separate Owner authorization, a manual dispatch for the exact tag with
`publish: true` is the only path that may create or verify the canonical Release, mirror the exact
tarball to GitHub Packages, and deploy the manifest-bound Pages archive. The finalization and Pages
jobs are structurally restricted to that explicit publishing dispatch. Both rehearsal and
publication dispatches are external effects and require the Owner's exact authorization.

The release build also runs `npm --prefix docs/site run security:check`. DEVAI temporarily vendors
the reviewed `image-size` JXL/HEIF and ICNS loop fixes because upstream has no patched npm release;
the provenance is recorded beside the vendored package. Replace the vendor with the first upstream
release containing both fixes, after the docs audit and build remain green.

Repository settings are separate Owner-authorized effects: enable immutable Releases,
prohibit update/deletion of `v*` tags, require signed annotated release tags, protect the
release and Pages environments, and select GitHub Actions as the Pages source. None of those
settings is changed by the source workflow itself.
