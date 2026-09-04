#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const [packageRootInput, archivePath, mode = 'all'] = process.argv.slice(2);
if (packageRootInput === undefined || archivePath === undefined) {
  throw new Error('INSTALLED_RELEASE_HOST_BOOTSTRAP_USAGE');
}

const packageRoot = resolve(packageRootInput);
const archive = readFileSync(resolve(archivePath));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value);
const census = (root, prefix = '') =>
  readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) return census(path, `${relative}/`);
      return [
        {
          path: relative,
          mode: lstatSync(path).mode & 0o7777,
          size: lstatSync(path).size,
          sha256: sha256(readFileSync(path)),
        },
      ];
    })
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
const expectedFor = (root, sourceArchive = archive) => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return {
    name: packageJson.name,
    version: packageJson.version,
    archive_sha256: sha256(sourceArchive),
    content_manifest_sha256: sha256(canonical(census(root))),
  };
};
const controlsFor = (root, sourceArchive = archive) => ({
  package_root: root,
  expected: expectedFor(root, sourceArchive),
  archive: sourceArchive,
  maximum_archive_bytes: 64 * 1024 * 1024,
  maximum_unpacked_bytes: 128 * 1024 * 1024,
  maximum_entries: 20_000,
  maximum_depth: 32,
});
const bootstrapUrl = pathToFileURL(
  join(packageRoot, 'dist/runtime/index/release-host-bootstrap.js'),
).href;

async function bootstrap() {
  return import(bootstrapUrl);
}

function copiedPackage(name) {
  const root = mkdtempSync(join(tmpdir(), `devai-bootstrap-${name}-`));
  const copy = join(root, 'package');
  cpSync(packageRoot, copy, { recursive: true, dereference: true });
  return { root, copy };
}

async function expectRefusal(operation) {
  await assert.rejects(operation, { message: 'rpl-package-identity-mismatch' });
}

async function positive() {
  const { bootstrapReleaseHost } = await bootstrap();
  const host = await bootstrapReleaseHost(controlsFor(packageRoot));
  assert.equal(host.installed_package.identity.name, '@aarusso-nyx/devai');
  const returned = host.installed_package.read('package.json');
  returned.fill(0);
  assert.equal(JSON.parse(host.installed_package.read('package.json')).name, '@aarusso-nyx/devai');
  const result = await host.runtime.invokeDevaiCli(['--version']);
  assert.equal(result.exit_code, 0);
}

async function capturedImmutability() {
  const { root, copy } = copiedPackage('captured');
  try {
    const { bootstrapReleaseHost } = await bootstrap();
    const host = await bootstrapReleaseHost(controlsFor(copy));
    writeFileSync(
      join(copy, 'dist/runtime/index/release-host.js'),
      'throw Error("disk mutation");\n',
    );
    writeFileSync(join(copy, 'package.json'), '{"name":"changed"}\n');
    const result = await host.runtime.invokeDevaiCli(['--version']);
    assert.equal(result.exit_code, 0);
    assert.equal(
      JSON.parse(host.installed_package.read('package.json')).name,
      '@aarusso-nyx/devai',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function cached(kind, altered = false) {
  const { root, copy } = copiedPackage(`cached-${kind}-${String(altered)}`);
  try {
    const entry = join(copy, 'dist/runtime/index/release-host.js');
    const original = readFileSync(entry);
    if (altered) {
      writeFileSync(
        entry,
        'globalThis.__devaiBootstrapCachedSentinel = { evaluated: true, used: false }; export const cached = true;\n',
      );
    }
    if (kind === 'require') createRequire(import.meta.url)(entry);
    else await import(pathToFileURL(entry).href);
    if (altered) writeFileSync(entry, original);
    const { bootstrapReleaseHost } = await bootstrap();
    await expectRefusal(() => bootstrapReleaseHost(controlsFor(copy)));
    if (altered) {
      assert.deepEqual(globalThis.__devaiBootstrapCachedSentinel, {
        evaluated: true,
        used: false,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assetInequality() {
  const { root, copy } = copiedPackage('asset-inequality');
  try {
    const altered = join(
      copy,
      'dist/runtime/index/schemas/mutation-evidence-policy-v2.schema.json',
    );
    writeFileSync(altered, `${readFileSync(altered, 'utf8')}\n`);
    const changedArchive = join(root, 'changed.tgz');
    execFileSync('tar', ['--format=ustar', '-czf', changedArchive, '-C', root, 'package']);
    const changed = readFileSync(changedArchive);
    const { bootstrapReleaseHost } = await bootstrap();
    await expectRefusal(() => bootstrapReleaseHost(controlsFor(copy, changed)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function failedStartup() {
  const { root, copy } = copiedPackage('failed-startup');
  try {
    const entry = join(copy, 'dist/runtime/index/release-host.js');
    await import(pathToFileURL(entry).href);
    const { bootstrapReleaseHost } = await bootstrap();
    await expectRefusal(() => bootstrapReleaseHost(controlsFor(copy)));
    await expectRefusal(() => bootstrapReleaseHost(controlsFor(copy)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const cases = {
  positive,
  'captured-immutability': capturedImmutability,
  'cache-import': () => cached('import'),
  'cache-require': () => cached('require'),
  'cache-altered-import': () => cached('import', true),
  'cache-altered-require': () => cached('require', true),
  'asset-inequality': assetInequality,
  'failed-startup': failedStartup,
};

if (mode === 'all') {
  for (const name of Object.keys(cases)) {
    execFileSync(
      process.execPath,
      [import.meta.filename, packageRoot, resolve(archivePath), name],
      {
        stdio: 'inherit',
      },
    );
  }
  process.stdout.write(JSON.stringify({ bootstrap_modes: Object.keys(cases) }) + '\n');
} else {
  const run = cases[mode];
  if (run === undefined) throw new Error('INSTALLED_RELEASE_HOST_BOOTSTRAP_MODE_INVALID');
  await run();
  process.stdout.write(JSON.stringify({ bootstrap_mode: mode, accepted: true }) + '\n');
}
