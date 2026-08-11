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

## Publish the public RC

The repository workflow `.github/workflows/release-rc2.yml` is triggered only by the
annotated `v1.0.0-rc.2` tag. It first verifies the protected ledger with the independently
pinned verifier. A separately protected release job then installs frozen dependencies,
builds the package and Docusaurus site once, checks the finite publishable closure, runs the
installed-tarball smoke, and creates the tarball, CycloneDX SBOM, site archive, hashes, and
release manifest.

The exact tarball is published to GitHub Packages with dist-tag `next`. Finalization waits
behind the `devai-rc-publication` environment so the Owner can confirm the new package is
public before registry reinstallation, prerelease creation, and Pages deployment. A rerun
skips an existing package version and repairs only missing Release or Pages phases; it never
moves the tag or overwrites the package version.
