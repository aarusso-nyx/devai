import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { rootCertificates } from 'node:tls';

// This provisioning program is never a release task or a candidate-selected adapter. Its
// fixed external build context contains no candidate source, host mounts or credentials.
if (
  process.platform !== 'linux' ||
  process.arch !== 'arm64' ||
  process.version !== 'v24.20.0' ||
  import.meta.url !== 'file:///opt/devai-build/install-toolchain.mjs'
) {
  throw new Error('DEVAI_TOOLCHAIN_BUILD_CONTEXT_REQUIRED');
}
const snapshot = '20260824T000000Z';
const distribution = { id: 'debian', version_id: '13', codename: 'trixie' };
const packagePins = {
  git: { version: '1:2.47.3-0+deb13u1', architecture: 'arm64' },
  'git-man': { version: '1:2.47.3-0+deb13u1', architecture: 'all' },
  procps: { version: '2:4.0.4-9', architecture: 'arm64' },
  'libproc2-0': { version: '2:4.0.4-9', architecture: 'arm64' },
};
const pnpmIntegrity =
  '76e2379760a4328ec4415815bcd6628dee727af3779aaa4c914e3944156c4299921a89f976381ee107d41f12cfa4b66681ca9c718f0668fa0831ed4c6d8ba56c';
const environment = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'C',
  LC_ALL: 'C',
  DEBIAN_FRONTEND: 'noninteractive',
};
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    env: environment,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error(`DEVAI_TOOLCHAIN_PROVISION_FAILED:${command}:${result.stderr ?? ''}`);
  }
  return capture ? result.stdout.trim() : undefined;
}
const osRelease = Object.fromEntries(
  readFileSync('/etc/os-release', 'utf8')
    .split('\n')
    .filter((line) => /^(ID|VERSION_ID|VERSION_CODENAME)=/u.test(line))
    .map((line) => {
      const [key, value] = line.split('=');
      return [key, value.replace(/^"|"$/gu, '')];
    }),
);
if (
  osRelease.ID !== distribution.id ||
  osRelease.VERSION_ID !== distribution.version_id ||
  osRelease.VERSION_CODENAME !== distribution.codename ||
  JSON.stringify(readdirSync('/etc/apt/sources.list.d').sort()) !== '["debian.sources"]' ||
  (existsSync('/etc/apt/sources.list') && readFileSync('/etc/apt/sources.list', 'utf8').trim())
)
  throw new Error('DEVAI_TOOLCHAIN_DISTRIBUTION_MISMATCH');
mkdirSync('/opt/devai-toolchain', { recursive: true });
mkdirSync('/etc/ssl/certs', { recursive: true });
writeFileSync('/etc/ssl/certs/devai-node-roots.pem', rootCertificates.join('\n'));
const aptSources = ['debian', 'debian-security']
  .map(
    (archive) =>
      `Types: deb\nURIs: https://snapshot.debian.org/archive/${archive}/${snapshot}\nSuites: ${archive === 'debian' ? 'trixie trixie-updates' : 'trixie-security'}\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n`,
  )
  .join('\n');
writeFileSync('/etc/apt/sources.list.d/debian.sources', aptSources);
const aptTransport = ['-o', 'Acquire::https::CaInfo=/etc/ssl/certs/devai-node-roots.pem'];
run('/usr/bin/apt-get', [...aptTransport, '-o', 'APT::Update::Error-Mode=any', 'update']);
run('/usr/bin/apt-get', [
  ...aptTransport,
  '--yes',
  '--no-install-recommends',
  'install',
  ...Object.entries(packagePins).map(([name, pin]) => `${name}=${pin.version}`),
]);
for (const [name, pin] of Object.entries(packagePins)) {
  if (
    run('/usr/bin/dpkg-query', ['-W', '-f=${Version}\t${Architecture}', name], true) !==
    `${pin.version}\t${pin.architecture}`
  )
    throw new Error('DEVAI_TOOLCHAIN_PACKAGE_VERSION_MISMATCH');
}
const response = await fetch('https://registry.npmjs.org/pnpm/-/pnpm-9.15.0.tgz');
if (!response.ok) throw new Error(`DEVAI_TOOLCHAIN_PNPM_FETCH_FAILED:${response.status}`);
const pnpm = Buffer.from(await response.arrayBuffer());
if (createHash('sha512').update(pnpm).digest('hex') !== pnpmIntegrity)
  throw new Error('DEVAI_TOOLCHAIN_PNPM_INTEGRITY_MISMATCH');
writeFileSync('/tmp/devai-pnpm-9.15.0.tgz', pnpm);
mkdirSync('/opt/pnpm');
run('/usr/bin/tar', [
  '--no-same-owner',
  '--no-same-permissions',
  '--strip-components=1',
  '-xzf',
  '/tmp/devai-pnpm-9.15.0.tgz',
  '-C',
  '/opt/pnpm',
]);
writeFileSync(
  '/usr/local/bin/pnpm',
  '#!/bin/sh\nexec /usr/local/bin/node /opt/pnpm/bin/pnpm.cjs "$@"\n',
  { mode: 0o755 },
);
const versions = {
  node: process.version,
  pnpm: run('/usr/local/bin/pnpm', ['--version'], true),
  git: run('/usr/bin/git', ['--version'], true),
  ps: run('/usr/bin/ps', ['--version'], true),
};
if (
  versions.pnpm !== '9.15.0' ||
  versions.git !== 'git version 2.47.3' ||
  versions.ps !== 'ps from procps-ng 4.0.4'
)
  throw new Error('DEVAI_TOOLCHAIN_VERSION_MISMATCH');
// Exercise tree-kill's actual Linux interface, not merely ps --version. This
// child is selected by its own parent PID; no unrelated process is signalled.
const ps = spawnSync('/usr/bin/ps', ['-o', 'pid', '--no-headers', '--ppid', String(process.pid)], {
  env: environment,
  encoding: 'utf8',
  timeout: 10000,
});
if (
  ps.status !== 0 ||
  ps.error ||
  ps.signal ||
  !ps.stdout.trim().split(/\s+/u).includes(String(ps.pid))
)
  throw new Error('DEVAI_TOOLCHAIN_PS_INTERFACE_MISMATCH');
writeFileSync(
  '/opt/devai-toolchain/identity.json',
  JSON.stringify(
    {
      protocol: 'devai.protected-linux-toolchain.v1',
      platform: 'linux/arm64',
      snapshot,
      distribution,
      packages: packagePins,
      apt_sources_sha256: createHash('sha256').update(aptSources).digest('hex'),
      pnpm_integrity_sha512: pnpmIntegrity,
      versions,
      executables: Object.fromEntries(
        [
          ['node', '/usr/local/bin/node'],
          ['pnpm', '/usr/local/bin/pnpm'],
          ['git', '/usr/bin/git'],
          ['ps', '/usr/bin/ps'],
        ].map(([name, path]) => {
          const stat = lstatSync(path);
          if (!stat.isFile() || (stat.mode & 0o111) === 0)
            throw new Error('DEVAI_TOOLCHAIN_EXECUTABLE_INVALID');
          return [
            name,
            { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') },
          ];
        }),
      ),
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  '/opt/devai-toolchain/dpkg-packages.txt',
  run('/usr/bin/dpkg-query', ['-W', '-f=${Package}\t${Version}\t${Architecture}\n'], true) + '\n',
);
// Only disposable files created by this isolated image-provisioning step are removed.
for (const path of [
  '/tmp/devai-pnpm-9.15.0.tgz',
  '/var/lib/apt/lists',
  '/var/log/apt',
  '/var/log/dpkg.log',
  '/var/cache/ldconfig/aux-cache',
]) {
  rmSync(path, { recursive: true, force: true });
}
