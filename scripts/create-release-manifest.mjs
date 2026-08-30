#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { releaseChannel } from './release-channel.mjs';

const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value === '')
    throw new Error(`RELEASE_MANIFEST_INPUT_MISSING:${name}`);
  return value;
};

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const artifact = (path) => ({ file: basename(path), sha256: digest(path) });

const packageFile = resolve(required('PACKAGE_TARBALL'));
const siteFile = resolve(required('SITE_ARCHIVE'));
const sbomFile = resolve(required('SBOM_FILE'));
const outputFile = resolve(required('OUTPUT_FILE'));
const packageManifest = JSON.parse(readFileSync('packages/cli/package.json', 'utf8'));
const releaseTag = required('RELEASE_TAG');
const packageName = required('PACKAGE_NAME');
const channel = releaseChannel(packageManifest.version);

const manifest = {
  schemaVersion: '1.0.0',
  release: {
    repository: 'aarusso-nyx/devai',
    tag: releaseTag,
    package: packageManifest.name,
    version: packageManifest.version,
    registry: 'https://npm.pkg.github.com',
    release_type: channel.release_type,
    prerelease: channel.prerelease,
    dist_tag: channel.dist_tag,
    pages: 'https://aarusso-nyx.github.io/devai/',
  },
  source: {
    commit: required('COMMIT_SHA'),
    tree: required('TREE_SHA'),
  },
  ledger: {
    verifier_package: '@aarusso-nyx/devai',
    verifier_package_version: required('LEDGER_VERIFIER_PACKAGE_VERSION'),
    verifier_provenance_sha256: required('LEDGER_VERIFIER_PROVENANCE_SHA256'),
    verifier_source_commit: '93b03f4924f15d4946f9b3f7e5fba820aefb7c4a',
    policy_digest: required('LEDGER_POLICY_DIGEST'),
    envelope_sha256: required('LEDGER_ENVELOPE_SHA256'),
    results_archive_sha256: required('LEDGER_RESULTS_SHA256'),
    artifacts_archive_sha256: required('LEDGER_ARTIFACTS_SHA256'),
    task_policy_sha256: required('LEDGER_TASK_POLICY_SHA256'),
    trust_store_sha256: required('LEDGER_TRUST_STORE_SHA256'),
    toolchain_sha256: required('LEDGER_TOOLCHAIN_SHA256'),
    environment_sha256: required('LEDGER_ENVIRONMENT_SHA256'),
    release_signers_sha256: required('LEDGER_RELEASE_SIGNERS_SHA256'),
  },
  artifacts: {
    package: artifact(packageFile),
    sbom: artifact(sbomFile),
    site: artifact(siteFile),
  },
};

if (manifest.release.package !== packageName || releaseTag !== `v${packageManifest.version}`) {
  throw new Error('RELEASE_MANIFEST_PACKAGE_IDENTITY_INVALID');
}
writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`);
