#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const [packageRootInput, archivePath, mode = 'all'] = process.argv.slice(2);
if (packageRootInput === undefined || archivePath === undefined) {
  throw new Error('INSTALLED_RELEASE_HOST_BOOTSTRAP_USAGE');
}

const packageRoot = resolve(packageRootInput);
const archivePathAbsolute = resolve(archivePath);
const archive = readFileSync(archivePathAbsolute);
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

function headerField(header, offset, length) {
  const end = header.indexOf(0, offset);
  return header
    .subarray(offset, end === -1 || end > offset + length ? offset + length : end)
    .toString('utf8');
}

/** Independent USTAR oracle: expected identity comes from raw archive headers, never pnpm. */
function archiveManifest(bytes) {
  const tar = gunzipSync(bytes);
  const manifest = [];
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = headerField(header, 0, 100);
    const prefix = headerField(header, 345, 155);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const type = header[156] ?? 0;
    const size = Number.parseInt(headerField(header, 124, 12).trim() || '0', 8);
    const mode = Number.parseInt(headerField(header, 100, 8).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(mode)) {
      throw new Error('INSTALLED_RELEASE_HOST_ARCHIVE_HEADER_INVALID');
    }
    const content = tar.subarray(offset + 512, offset + 512 + size);
    if (content.byteLength !== size) throw new Error('INSTALLED_RELEASE_HOST_ARCHIVE_TRUNCATED');
    if (type === 0 || type === 0x30) {
      if (!path.startsWith('package/'))
        throw new Error('INSTALLED_RELEASE_HOST_ARCHIVE_ROOT_INVALID');
      manifest.push({
        path: path.slice('package/'.length),
        mode,
        size,
        sha256: sha256(content),
        bytes: Buffer.from(content),
      });
    } else if (type !== 0x35) {
      throw new Error('INSTALLED_RELEASE_HOST_ARCHIVE_TYPE_INVALID');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return manifest.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
}

function expectedFor(bytes) {
  const manifest = archiveManifest(bytes);
  const packageJson = manifest.find((entry) => entry.path === 'package.json');
  if (packageJson === undefined)
    throw new Error('INSTALLED_RELEASE_HOST_ARCHIVE_PACKAGE_JSON_MISSING');
  const metadata = JSON.parse(packageJson.bytes.toString('utf8'));
  return {
    name: metadata.name,
    version: metadata.version,
    archive_sha256: sha256(bytes),
    content_manifest_sha256: sha256(
      canonical(
        manifest.map(({ path, mode, size, sha256: digest }) => ({
          path,
          mode,
          size,
          sha256: digest,
        })),
      ),
    ),
  };
}

const expected = expectedFor(archive);
const bootstrapUrl = pathToFileURL(
  join(packageRoot, 'dist/runtime/index/release-host-bootstrap.js'),
).href;
const provisionerUrl = pathToFileURL(
  join(packageRoot, 'dist/runtime/host/provision-package.mjs'),
).href;

function tarControl() {
  const executable = realpathSync(execFileSync('which', ['tar'], { encoding: 'utf8' }).trim());
  return {
    executable,
    sha256: sha256(readFileSync(executable)),
    maximum_executable_bytes: 64 * 1024 * 1024,
  };
}

function privateParent(name) {
  return mkdtempSync(join(tmpdir(), `devai-bootstrap-${name}-`));
}

function provisionControls(destinationParent, overrides = {}) {
  return {
    archive_path: archivePathAbsolute,
    expected,
    destination_parent: destinationParent,
    tar: tarControl(),
    limits: {
      maximum_archive_bytes: 64 * 1024 * 1024,
      maximum_unpacked_bytes: 128 * 1024 * 1024,
      maximum_entries: 20_000,
      maximum_depth: 32,
      timeout_ms: 30_000,
    },
    ...overrides,
  };
}

async function provision(name, overrides = {}) {
  const parent = privateParent(name);
  const { provisionReleaseHostPackage } = await import(provisionerUrl);
  return {
    parent,
    provisioned: await provisionReleaseHostPackage(provisionControls(parent, overrides)),
  };
}

async function expectProvisionRefusal(parent, controls) {
  const { provisionReleaseHostPackage } = await import(provisionerUrl);
  await assert.rejects(() => provisionReleaseHostPackage(controls), {
    message: 'release-host-provisioning-invalid',
  });
  assert.deepEqual(readdirSync(parent), []);
}

function exactCopy(root, name) {
  const parent = privateParent(name);
  const copy = join(parent, 'package');
  cpSync(root, copy, { recursive: true, dereference: true });
  return { parent, copy };
}

function gitControl() {
  const selected =
    process.platform === 'darwin'
      ? execFileSync('xcrun', ['--find', 'git'], { encoding: 'utf8' }).trim()
      : execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const executable = realpathSync(selected);
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8' });
  const match = /^git version ([0-9]+)\.([0-9]+)(?:\.[0-9]+)?/u.exec(version);
  assert.notEqual(match, null, 'collector requires a real host Git executable');
  const major = Number(match[1]);
  const minor = Number(match[2]);
  assert.ok(major > 2 || (major === 2 && minor >= 45), 'collector requires Git >= 2.45');
  return {
    executable,
    sha256: sha256(readFileSync(executable)),
    maximum_executable_bytes: 64 * 1024 * 1024,
  };
}

async function pnpmNegative() {
  const original = readFileSync(join(packageRoot, 'package.json'));
  const { bootstrapReleaseHost } = await import(bootstrapUrl);
  await assert.rejects(
    () =>
      bootstrapReleaseHost({
        package_root: packageRoot,
        expected,
        archive,
        maximum_archive_bytes: 64 * 1024 * 1024,
        maximum_unpacked_bytes: 128 * 1024 * 1024,
        maximum_entries: 20_000,
        maximum_depth: 32,
      }),
    { message: 'rpl-package-identity-mismatch' },
  );
  assert.deepEqual(readFileSync(join(packageRoot, 'package.json')), original);

  const { parent, copy } = exactCopy(packageRoot, 'pnpm-explicit-negative');
  try {
    writeFileSync(join(copy, 'unapproved-package-manager-metadata'), 'must refuse\n');
    await assert.rejects(
      () =>
        bootstrapReleaseHost({
          package_root: copy,
          expected,
          archive,
          maximum_archive_bytes: 64 * 1024 * 1024,
          maximum_unpacked_bytes: 128 * 1024 * 1024,
          maximum_entries: 20_000,
          maximum_depth: 32,
        }),
      { message: 'rpl-package-identity-mismatch' },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

async function positiveAndCandidate() {
  const { parent, provisioned } = await provision('positive');
  try {
    assert.equal(provisioned.host.installed_package.identity.name, '@aarusso-nyx/devai');
    const returned = provisioned.host.installed_package.read('package.json');
    returned.fill(0);
    assert.equal(
      JSON.parse(provisioned.host.installed_package.read('package.json')).name,
      '@aarusso-nyx/devai',
    );
    const version = await provisioned.host.runtime.invokeDevaiCli(['--version']);
    assert.equal(version.exit_code, 0);

    const repositoryRoot = mkdtempSync(join(parent, 'candidate-'));
    const git = gitControl();
    const gitRun = (args, input) =>
      execFileSync(git.executable, ['-C', repositoryRoot, ...args], {
        encoding: 'utf8',
        input,
      }).trim();
    execFileSync(git.executable, ['init', '-q', repositoryRoot]);
    gitRun(['config', 'user.name', 'Bootstrap fixture']);
    gitRun(['config', 'user.email', 'bootstrap@example.invalid']);
    writeFileSync(join(repositoryRoot, 'README.md'), 'captured Git candidate\n');
    gitRun(['add', 'README.md']);
    gitRun(['commit', '-qm', 'candidate']);
    const commit = gitRun(['rev-parse', 'HEAD']);
    const tree = gitRun(['rev-parse', 'HEAD^{tree}']);
    const candidate = provisioned.host.collectCandidate({
      repository_root: repositoryRoot,
      repository: { id: 'fixture/bootstrap-candidate', commit, tree },
      git,
      maximum_bytes: 1024 * 1024,
      maximum_entries: 100,
      timeout_ms: 30_000,
    });
    assert.equal(candidate.read('README.md').toString('utf8'), 'captured Git candidate\n');

    assert.throws(
      () =>
        provisioned.host.collectCandidate({
          repository_root: repositoryRoot,
          repository: {
            id: 'fixture/bootstrap-candidate',
            commit,
            tree: '0'.repeat(tree.length),
          },
          git,
          maximum_bytes: 1024 * 1024,
          maximum_entries: 100,
          timeout_ms: 30_000,
        }),
      { message: 'rpl-policy-resolution-mismatch' },
    );

    const remote = join(parent, 'candidate-promisor.git');
    execFileSync(git.executable, ['clone', '--bare', '-q', repositoryRoot, remote]);
    gitRun(['remote', 'add', 'origin', `file://${remote}`]);
    gitRun(['config', 'remote.origin.promisor', 'true']);
    gitRun(['config', 'remote.origin.partialclonefilter', 'blob:none']);
    // A protocol-specific local setting makes the counterfactual fetch possible.
    // The collector still supplies both no-lazy-fetch controls and must not use it.
    gitRun(['config', 'protocol.file.allow', 'always']);
    const blob = gitRun(['rev-parse', 'HEAD:README.md']);
    const localBlob = join(repositoryRoot, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    const objectCensus = () =>
      Object.fromEntries(
        gitRun(['count-objects', '-v'])
          .split('\n')
          .map((line) => line.split(': ', 2)),
      );
    assert.equal(existsSync(localBlob), true);
    rmSync(localBlob);
    assert.equal(existsSync(localBlob), false);
    const beforeMissingCollection = objectCensus();
    assert.throws(
      () =>
        provisioned.host.collectCandidate({
          repository_root: repositoryRoot,
          repository: { id: 'fixture/bootstrap-candidate', commit, tree },
          git,
          maximum_bytes: 1024 * 1024,
          maximum_entries: 100,
          timeout_ms: 30_000,
        }),
      { message: 'rpl-policy-resolution-mismatch' },
    );
    assert.equal(existsSync(localBlob), false, 'collector must not lazily fetch a missing object');
    assert.equal(
      JSON.stringify(objectCensus()),
      JSON.stringify(beforeMissingCollection),
      'collector must not retrieve a remote promisor object',
    );
    assert.equal(
      gitRun(['cat-file', '-p', `${blob}^{blob}`]),
      'captured Git candidate',
      'fixture promisor must prove the missing object was remotely fetchable',
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

async function capturedImmutability() {
  const { parent, provisioned } = await provision('captured');
  try {
    writeFileSync(
      join(provisioned.package_root, 'dist/runtime/index/release-host.js'),
      'throw Error("disk mutation");\n',
    );
    writeFileSync(join(provisioned.package_root, 'package.json'), '{"name":"changed"}\n');
    const result = await provisioned.host.runtime.invokeDevaiCli(['--version']);
    assert.equal(result.exit_code, 0);
    assert.equal(
      JSON.parse(provisioned.host.installed_package.read('package.json')).name,
      '@aarusso-nyx/devai',
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

async function cached(kind, altered = false) {
  const { parent: provisionParent, provisioned } = await provision(
    `seed-${kind}-${String(altered)}`,
  );
  const { parent, copy } = exactCopy(provisioned.package_root, `cached-${kind}-${String(altered)}`);
  try {
    const entry = join(copy, 'dist/runtime/index/release-host.js');
    const original = readFileSync(entry);
    if (altered) {
      writeFileSync(
        entry,
        'globalThis.__devaiBootstrapCachedSentinel = { evaluated: true, used: false }; export const cached = true;\n',
      );
    }
    if (kind === 'require') (await import('node:module')).createRequire(import.meta.url)(entry);
    else await import(pathToFileURL(entry).href);
    if (altered) writeFileSync(entry, original);
    const { bootstrapReleaseHost } = await import(bootstrapUrl);
    await assert.rejects(
      () =>
        bootstrapReleaseHost({
          package_root: copy,
          expected,
          archive,
          maximum_archive_bytes: 64 * 1024 * 1024,
          maximum_unpacked_bytes: 128 * 1024 * 1024,
          maximum_entries: 20_000,
          maximum_depth: 32,
        }),
      { message: 'rpl-package-identity-mismatch' },
    );
    if (altered) {
      assert.deepEqual(globalThis.__devaiBootstrapCachedSentinel, {
        evaluated: true,
        used: false,
      });
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(provisionParent, { recursive: true, force: true });
  }
}

async function assetInequality() {
  const { parent: provisionParent, provisioned } = await provision('asset-seed');
  const { parent, copy } = exactCopy(provisioned.package_root, 'asset-inequality');
  try {
    const schema = join(copy, 'dist/runtime/index/schemas/mutation-evidence-policy-v2.schema.json');
    writeFileSync(schema, `${readFileSync(schema, 'utf8')}\n`);
    const archiveParent = join(parent, 'archive');
    mkdirSync(archiveParent);
    cpSync(copy, join(archiveParent, 'package'), { recursive: true, dereference: true });
    const changedArchivePath = join(parent, 'changed.tgz');
    execFileSync('tar', [
      '--format=ustar',
      '-czf',
      changedArchivePath,
      '-C',
      archiveParent,
      'package',
    ]);
    const destination = privateParent('asset-inequality-provision');
    try {
      const { provisionReleaseHostPackage } = await import(provisionerUrl);
      await assert.rejects(
        () =>
          provisionReleaseHostPackage({
            ...provisionControls(destination),
            archive_path: changedArchivePath,
          }),
        { message: 'release-host-provisioning-invalid' },
      );
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(provisionParent, { recursive: true, force: true });
  }
}

async function provisioningRefusals() {
  const parent = privateParent('provisioning-refusals');
  const inputs = privateParent('provisioning-inputs');
  try {
    const wrongArchive = join(inputs, 'wrong.tgz');
    writeFileSync(wrongArchive, Buffer.from(`${archive}corrupt`));
    await expectProvisionRefusal(parent, {
      ...provisionControls(parent),
      archive_path: wrongArchive,
    });
    await expectProvisionRefusal(parent, {
      ...provisionControls(parent),
      tar: { ...tarControl(), sha256: '0'.repeat(64) },
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(inputs, { recursive: true, force: true });
  }

  const unsafe = privateParent('unsafe-destination');
  chmodSync(unsafe, 0o755);
  try {
    const { provisionReleaseHostPackage } = await import(provisionerUrl);
    await assert.rejects(() => provisionReleaseHostPackage(provisionControls(unsafe)), {
      message: 'release-host-provisioning-invalid',
    });
    assert.deepEqual(readdirSync(unsafe), []);
  } finally {
    rmSync(unsafe, { recursive: true, force: true });
  }
}

async function failedStartup() {
  const { parent: provisionParent, provisioned } = await provision('failed-startup-seed');
  const { parent, copy } = exactCopy(provisioned.package_root, 'failed-startup');
  try {
    const entry = join(copy, 'dist/runtime/index/release-host.js');
    await import(pathToFileURL(entry).href);
    const { bootstrapReleaseHost } = await import(bootstrapUrl);
    const controls = {
      package_root: copy,
      expected,
      archive,
      maximum_archive_bytes: 64 * 1024 * 1024,
      maximum_unpacked_bytes: 128 * 1024 * 1024,
      maximum_entries: 20_000,
      maximum_depth: 32,
    };
    await assert.rejects(() => bootstrapReleaseHost(controls), {
      message: 'rpl-package-identity-mismatch',
    });
    await assert.rejects(() => bootstrapReleaseHost(controls), {
      message: 'rpl-package-identity-mismatch',
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(provisionParent, { recursive: true, force: true });
  }
}

const cases = {
  'pnpm-negative': pnpmNegative,
  'positive-candidate': positiveAndCandidate,
  'captured-immutability': capturedImmutability,
  'cache-import': () => cached('import'),
  'cache-require': () => cached('require'),
  'cache-altered-import': () => cached('import', true),
  'cache-altered-require': () => cached('require', true),
  'asset-inequality': assetInequality,
  'provisioning-refusals': provisioningRefusals,
  'failed-startup': failedStartup,
};

if (mode === 'all') {
  for (const name of Object.keys(cases)) {
    execFileSync(process.execPath, [import.meta.filename, packageRoot, archivePathAbsolute, name], {
      stdio: 'inherit',
    });
  }
  process.stdout.write(JSON.stringify({ bootstrap_modes: Object.keys(cases) }) + '\n');
} else {
  const run = cases[mode];
  if (run === undefined) throw new Error('INSTALLED_RELEASE_HOST_BOOTSTRAP_MODE_INVALID');
  await run();
  process.stdout.write(JSON.stringify({ bootstrap_mode: mode, accepted: true }) + '\n');
}
