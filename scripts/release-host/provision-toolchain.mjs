import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// Explicit protected host setup, not a release lifecycle action. No candidate files, bind
// mounts, secrets, default Docker context or image publication participate in this build.
const path = process.argv[2];
if (process.argv.length !== 3 || !isAbsolute(path ?? ''))
  throw new Error('DEVAI_TOOLCHAIN_CONTROLS_REQUIRED');
const c = JSON.parse(readFileSync(path));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const value of [c.docker_binary, c.docker_config_directory, c.output_directory])
  if (!isAbsolute(value) || realpathSync(value) !== value)
    throw new Error('DEVAI_TOOLCHAIN_CONTROL_PATH_INVALID');
if (
  (lstatSync(c.output_directory).mode & 0o777) !== 0o700 ||
  hash(readFileSync(c.docker_binary)) !== c.docker_binary_sha256 ||
  !/^unix:\/\/\/[^\0\r\n]+$/u.test(c.engine_socket) ||
  JSON.stringify(JSON.parse(readFileSync(join(c.docker_config_directory, 'config.json')))) !==
    '{"auths":{}}'
)
  throw new Error('DEVAI_TOOLCHAIN_CONTROLS_INVALID');
const environment = { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C', LC_ALL: 'C' };
function docker(args) {
  const r = spawnSync(
    c.docker_binary,
    ['--config', c.docker_config_directory, '--host', c.engine_socket, ...args],
    { env: environment, maxBuffer: 32 * 1024 * 1024, timeout: 600000 },
  );
  const log = Buffer.concat([r.stdout ?? Buffer.alloc(0), r.stderr ?? Buffer.alloc(0)]);
  writeFileSync(join(c.output_directory, `command-${randomUUID()}.log`), log, {
    flag: 'wx',
    mode: 0o600,
  });
  if (r.status !== 0 || r.error || r.signal) throw new Error('DEVAI_TOOLCHAIN_COMMAND_FAILED');
  return r.stdout;
}
const engine = JSON.parse(docker(['version', '--format', '{{json .Server}}']));
if (engine.Version !== c.engine_version || engine.Os !== 'linux' || engine.Arch !== 'arm64')
  throw new Error('DEVAI_TOOLCHAIN_ENGINE_MISMATCH');
const context = join(c.output_directory, 'build-context');
mkdirSync(context, { mode: 0o700 });
const sources = {};
for (const name of ['Dockerfile.tools', 'install-toolchain.mjs']) {
  const bytes = readFileSync(new URL(name, import.meta.url));
  writeFileSync(join(context, name), bytes, { flag: 'wx', mode: 0o600 });
  sources[name] = hash(bytes);
}
const ids = [];
const images = [];
for (const attempt of [1, 2]) {
  const iid = join(c.output_directory, `image-${attempt}.txt`);
  docker([
    'build',
    '--progress',
    'plain',
    '--pull=false',
    '--no-cache',
    '--output',
    'type=image,rewrite-timestamp=true,unpack=false',
    '--build-arg',
    'SOURCE_DATE_EPOCH=1787529600',
    '--iidfile',
    iid,
    '--tag',
    `devai-release-toolchain:reproducible-${attempt}`,
    '--file',
    join(context, 'Dockerfile.tools'),
    context,
  ]);
  const id = readFileSync(iid, 'utf8').trim();
  if (!/^sha256:[0-9a-f]{64}$/u.test(id)) throw new Error('DEVAI_TOOLCHAIN_IMAGE_ID_INVALID');
  ids.push(id);
  const image = JSON.parse(docker(['image', 'inspect', id]))[0];
  images.push(image);
  writeFileSync(
    join(c.output_directory, `image-${attempt}.json`),
    JSON.stringify(image, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
}
if (ids[0] !== ids[1] || JSON.stringify(images[0].RootFS) !== JSON.stringify(images[1].RootFS))
  throw new Error('DEVAI_TOOLCHAIN_NONREPRODUCIBLE');
docker(['image', 'save', '--output', join(c.output_directory, 'toolchain-image.tar'), ids[0]]);
const observed = docker([
  'run',
  '--name',
  `devai-toolchain-${randomUUID()}`,
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--network',
  'none',
  '--ipc',
  'none',
  '--pids-limit',
  '64',
  '--memory',
  '268435456',
  '--cpus',
  '0.5',
  '--restart',
  'no',
  '--entrypoint',
  '/usr/local/bin/node',
  ids[0],
  '-e',
  'process.stdout.write(require("node:fs").readFileSync("/opt/devai-toolchain/identity.json"))',
]);
const identity = JSON.parse(observed);
if (
  identity.versions?.node !== 'v24.20.0' ||
  identity.versions.pnpm !== '9.15.0' ||
  identity.versions.git !== 'git version 2.39.5'
)
  throw new Error('DEVAI_TOOLCHAIN_RUNTIME_IDENTITY_MISMATCH');
writeFileSync(
  join(c.output_directory, 'provenance.json'),
  JSON.stringify(
    {
      protocol: 'devai.reproducible-toolchain-build.v1',
      image: ids[0],
      engine_version: c.engine_version,
      docker_binary_sha256: c.docker_binary_sha256,
      build_sources: sources,
      uncached_builds: 2,
      identical: true,
      identity,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx', mode: 0o600 },
);
console.log(JSON.stringify({ image: ids[0], output_directory: c.output_directory }));
