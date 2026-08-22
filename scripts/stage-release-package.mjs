#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(repositoryRoot, 'packages/cli');
const argument = process.argv.indexOf('--output');
const outputRoot = resolve(
  argument >= 0 && process.argv[argument + 1] ? process.argv[argument + 1] : 'scratch/release',
);
const temporaryRoot = mkdtempSync(join(tmpdir(), 'devai-public-package-'));
const secondaryBins = {
  'devai-evidence-policy': './dist/runtime/evidence-verification/src/build-policy-cli.js',
  'devai-evidence-verify': './dist/runtime/evidence-verification/src/cli.js',
  'devai-evidence-bundle-verify': './dist/runtime/evidence-verification/src/bundle-cli.js',
  'devai-evidence-export': './dist/runtime/evidence-verification/src/export-cli.js',
  'devai-evidence-publish': './dist/runtime/evidence-verification/src/publish-cli.js',
};

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function normalizedManifest() {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  for (const [name, path] of Object.entries(secondaryBins)) {
    if (manifest.bin?.[name] !== path || !existsSync(join(packageRoot, path))) {
      throw new Error(`RELEASE_PACKAGE_BIN_MISSING:${name}`);
    }
  }
  delete manifest.devDependencies;
  const privateReferences = JSON.stringify({
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
  });
  if (/workspace:|@devai-nyx\//u.test(privateReferences)) {
    throw new Error('RELEASE_PUBLIC_MANIFEST_PRIVATE_DEPENDENCY');
  }
  return manifest;
}

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function validateAssembledDist() {
  const dist = join(packageRoot, 'dist');
  const unexpected = filesUnder(dist)
    .map((path) => relative(dist, path).replaceAll('\\', '/'))
    .filter(
      (path) =>
        !path.startsWith('runtime/') && !path.startsWith('law/') && !path.startsWith('resources/'),
    );
  if (unexpected.length > 0) {
    throw new Error(`RELEASE_PACKAGE_DIST_CONTAMINATED:${unexpected.slice(0, 10).join(',')}`);
  }
}

function packOnce(ordinal, manifest) {
  const stage = join(temporaryRoot, `stage-${String(ordinal)}`);
  const packed = join(temporaryRoot, `pack-${String(ordinal)}`);
  mkdirSync(stage, { recursive: true });
  mkdirSync(packed, { recursive: true });
  cpSync(join(packageRoot, 'dist'), join(stage, 'dist'), { recursive: true });
  copyFileSync(join(repositoryRoot, 'LICENSE'), join(stage, 'LICENSE'));
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packed], {
      cwd: stage,
      encoding: 'utf8',
    }),
  );
  const filename = result[0]?.filename;
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('RELEASE_PACK_OUTPUT_MISSING');
  }
  const tarball = join(packed, basename(filename));
  if (!existsSync(tarball)) throw new Error('RELEASE_PACK_TARBALL_MISSING');
  return {
    tarball,
    sha256: digest(tarball),
    files: (result[0]?.files ?? []).map((file) => file.path).sort(),
  };
}

try {
  if (!existsSync(join(packageRoot, 'dist/runtime/index/bin.js'))) {
    throw new Error('RELEASE_PACKAGE_BUILD_MISSING');
  }
  validateAssembledDist();
  const manifest = normalizedManifest();
  const first = packOnce(1, manifest);
  const second = packOnce(2, manifest);
  if (first.sha256 !== second.sha256) {
    throw new Error(`RELEASE_PACK_NONDETERMINISTIC:${first.sha256}:${second.sha256}`);
  }
  if (JSON.stringify(first.files) !== JSON.stringify(second.files)) {
    throw new Error('RELEASE_PACK_POPULATION_NONDETERMINISTIC');
  }
  mkdirSync(outputRoot, { recursive: true });
  const output = join(outputRoot, basename(first.tarball));
  copyFileSync(first.tarball, output);
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      package: manifest.name,
      version: manifest.version,
      tarball: output,
      sha256: first.sha256,
      files: first.files.length,
      secondary_bins: Object.keys(secondaryBins).sort(),
      reproductions: 2,
      public_manifest: { ...manifest, devDependencies: undefined },
    })}\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
