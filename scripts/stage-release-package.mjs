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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(repositoryRoot, 'packages/cli');
const argument = process.argv.indexOf('--output');
const outputRoot = resolve(
  argument >= 0 && process.argv[argument + 1] ? process.argv[argument + 1] : 'scratch/release',
);
const temporaryRoot = mkdtempSync(join(tmpdir(), 'devai-public-package-'));

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function normalizedManifest() {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
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
  return { tarball, sha256: digest(tarball) };
}

try {
  if (!existsSync(join(packageRoot, 'dist/runtime/index/bin.js'))) {
    throw new Error('RELEASE_PACKAGE_BUILD_MISSING');
  }
  const manifest = normalizedManifest();
  const first = packOnce(1, manifest);
  const second = packOnce(2, manifest);
  if (first.sha256 !== second.sha256) {
    throw new Error(`RELEASE_PACK_NONDETERMINISTIC:${first.sha256}:${second.sha256}`);
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
      reproductions: 2,
      public_manifest: { ...manifest, devDependencies: undefined },
    })}\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
