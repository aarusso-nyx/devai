#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

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

const manifest = {
  schemaVersion: '1.0.0',
  release: {
    repository: 'aarusso-nyx/devai',
    tag: 'v1.0.0-rc.2',
    package: packageManifest.name,
    version: packageManifest.version,
    registry: 'https://npm.pkg.github.com',
    dist_tag: 'next',
    pages: 'https://aarusso-nyx.github.io/devai/',
  },
  source: {
    commit: required('COMMIT_SHA'),
    tree: required('TREE_SHA'),
  },
  ledger: {
    verifier_repository: 'devai-nyx/devai-verifier',
    verifier_commit: required('VERIFIER_COMMIT'),
    policy_digest: required('LEDGER_POLICY_DIGEST'),
    envelope_sha256: required('LEDGER_ENVELOPE_SHA256'),
    results_archive_sha256: required('LEDGER_RESULTS_SHA256'),
    task_policy_sha256: required('LEDGER_TASK_POLICY_SHA256'),
    trust_store_sha256: required('LEDGER_TRUST_STORE_SHA256'),
  },
  artifacts: {
    package: artifact(packageFile),
    sbom: artifact(sbomFile),
    site: artifact(siteFile),
  },
};

if (
  manifest.release.package !== '@aarusso-nyx/devai' ||
  manifest.release.version !== '1.0.0-rc.2'
) {
  throw new Error('RELEASE_MANIFEST_PACKAGE_IDENTITY_INVALID');
}
writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`);
