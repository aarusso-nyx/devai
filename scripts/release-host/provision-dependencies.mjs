import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import {
  decodeContainerDependencyArchive,
  encodeContainerArchive,
  encodeContainerDependencyArchive,
} from '../../packages/cli/dist/services/container-archive.js';
import {
  validateProtectedDependencyTransport,
  verifyProtectedDependencyInputs,
} from '../../packages/cli/dist/services/release-dependency-transport.js';

// Host provisioning only, never a candidate task or lifecycle adapter. Before invoking this
// source-only tool run: pnpm exec tsc -b packages/cli/tsconfig.json --force
// (Package assembly intentionally removes intermediate dist/services modules.)
// This accepts an externally approved control file, not candidate .npmrc or scripts.
const controlsPath = process.argv[2];
if (process.argv.length !== 3 || !isAbsolute(controlsPath ?? ''))
  throw new Error('DEVAI_DEPENDENCY_CONTROLS_REQUIRED');
const c = JSON.parse(readFileSync(controlsPath, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const maximumBytes = 1024 * 1024 * 1024;
const inside = (root, path) => {
  const suffix = relative(root, path);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
};
for (const path of [c.repository, c.output_directory, c.docker_binary, c.docker_config_directory])
  if (!isAbsolute(path) || realpathSync(path) !== path)
    throw new Error('DEVAI_DEPENDENCY_CONTROL_PATH_INVALID');
if (
  inside(c.repository, controlsPath) ||
  inside(c.repository, c.output_directory) ||
  (lstatSync(c.output_directory).mode & 0o777) !== 0o700 ||
  !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(c.commit) ||
  !/^sha256:[0-9a-f]{64}$/u.test(c.image) ||
  !/^unix:\/\/\/[^\0\r\n]+$/u.test(c.engine_socket) ||
  hash(readFileSync(c.docker_binary)) !== c.docker_binary_sha256 ||
  JSON.stringify(JSON.parse(readFileSync(join(c.docker_config_directory, 'config.json')))) !==
    '{"auths":{}}'
)
  throw new Error('DEVAI_DEPENDENCY_CONTROLS_INVALID');
const environment = { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C', LC_ALL: 'C' };
function run(binary, args, input) {
  const r = spawnSync(binary, args, {
    env: environment,
    input,
    maxBuffer: maximumBytes,
    timeout: 600_000,
  });
  if (r.status !== 0 || r.error || r.signal) {
    const failure = join(c.output_directory, `failure-${randomUUID()}.log`);
    writeFileSync(
      failure,
      Buffer.concat([r.stdout ?? Buffer.alloc(0), r.stderr ?? Buffer.alloc(0)]),
      { flag: 'wx', mode: 0o600 },
    );
    throw new Error(`DEVAI_DEPENDENCY_COMMAND_FAILED:${args[0]}:${failure}`);
  }
  return r.stdout;
}
const docker = (args, input) =>
  run(
    c.docker_binary,
    ['--config', c.docker_config_directory, '--host', c.engine_socket, ...args],
    input,
  );
const git = (args) => run('/usr/bin/git', ['-C', c.repository, ...args]);
if (
  git(['rev-parse', `${c.commit}^{commit}`])
    .toString()
    .trim() !== c.commit
)
  throw new Error('DEVAI_DEPENDENCY_CANDIDATE_INVALID');
const tree = git(['rev-parse', `${c.commit}^{tree}`])
  .toString()
  .trim();
const image = JSON.parse(docker(['image', 'inspect', c.image]))[0];
const engine = JSON.parse(docker(['version', '--format', '{{json .Server}}']));
if (
  image.Id !== c.image ||
  image.Os !== 'linux' ||
  image.Architecture !== 'arm64' ||
  engine.Version !== c.engine_version ||
  engine.Os !== 'linux' ||
  engine.Arch !== 'arm64'
)
  throw new Error('DEVAI_DEPENDENCY_TOOLCHAIN_INVALID');
const allPaths = git(['ls-tree', '-rz', '--full-tree', c.commit])
  .toString()
  .split('\0')
  .filter(Boolean);
const source = allPaths
  .filter((line) =>
    /\t(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|packages\/[^/]+\/package\.json)$/u.test(
      line,
    ),
  )
  .map((line) => {
    const [metadata, path] = line.split('\t');
    const [mode, type, object] = metadata.split(' ');
    if (type !== 'blob' || mode !== '100644')
      throw new Error('DEVAI_DEPENDENCY_INPUT_TYPE_INVALID');
    return { path, mode, bytes: git(['cat-file', 'blob', object]) };
  });
const byPath = new Map(source.map((entry) => [entry.path, entry.bytes]));
const manifest = JSON.parse(byPath.get('package.json'));
if (
  manifest.packageManager !==
    'pnpm@9.15.0+sha512.76e2379760a4328ec4415815bcd6628dee727af3779aaa4c914e3944156c4299921a89f976381ee107d41f12cfa4b66681ca9c718f0668fa0831ed4c6d8ba56c' ||
  byPath.get('pnpm-workspace.yaml')?.toString().replace(/\s+/gu, '') !== 'packages:-packages/*' ||
  /(?:tarball|directory|repo|patches):|(?:file:|git\+|https?:\/\/).*\.(?:tgz|git)/u.test(
    byPath.get('pnpm-lock.yaml')?.toString() ?? '',
  )
)
  throw new Error('DEVAI_DEPENDENCY_SOURCE_CONTRACT_UNSUPPORTED');
const inputs = {
  files: source.map((entry) => ({ path: entry.path, sha256: hash(entry.bytes) })),
  workspace_packages: source
    .filter((entry) => entry.path.startsWith('packages/'))
    .map((entry) => ({
      path: entry.path.slice(0, -'/package.json'.length),
      name: JSON.parse(entry.bytes).name,
      manifest_sha256: hash(entry.bytes),
    })),
};
const id = `devai-dependencies-${randomUUID()}`;
const store = `${id}-store`;
docker(['volume', 'create', '--label', `devai.provisioning=${id}`, store]);
const outputs = [];
const artifacts = [];
const bootstrap = String.raw`const cp=require('node:child_process'),fs=require('node:fs');if(process.version!=='v24.20.0'||cp.execFileSync('/usr/local/bin/pnpm',['--version']).toString().trim()!=='9.15.0')throw Error('toolchain mismatch');const r=cp.spawnSync('/usr/local/bin/pnpm',JSON.parse(process.argv[1]),{cwd:'/workspace/candidate',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',CI:'1',LANG:'C',LC_ALL:'C',npm_config_userconfig:'/dev/null',npm_config_registry:'https://registry.npmjs.org/'},stdio:'inherit',timeout:540000});if(r.error||r.signal||r.status!==0)process.exit(r.status||125);const p='/workspace/candidate/node_modules/.modules.yaml';const text=fs.readFileSync(p,'utf8');if((text.match(/^prunedAt:/gm)||[]).length!==1)throw Error('pnpm metadata unexpected');fs.writeFileSync(p,text.replace(/^prunedAt:.*$/m,'prunedAt: Thu, 01 Jan 1970 00:00:00 GMT'));process.stdout.write('\nDEVAI_TOOLCHAIN_IDENTITY='+fs.readFileSync('/opt/devai-toolchain/identity.json','utf8'));`;
for (const offline of [false, true]) {
  const suffix = offline ? 'offline' : 'online';
  const name = `${id}-${suffix}`;
  const workspace = `${name}-workspace`;
  docker(['volume', 'create', '--label', `devai.provisioning=${id}`, workspace]);
  const args = [
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--ignore-pnpmfile',
    '--package-import-method=copy',
    '--store-dir',
    '/store',
    ...(offline ? ['--offline'] : []),
  ];
  docker([
    'create',
    '--name',
    name,
    '--label',
    `devai.provisioning=${id}`,
    '--read-only',
    '--user',
    '10001:10001',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--network',
    offline ? 'none' : 'bridge',
    '--ipc',
    'none',
    '--pids-limit',
    '128',
    '--memory',
    '2147483648',
    '--cpus',
    '2',
    '--restart',
    'no',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=134217728',
    '--mount',
    `type=volume,source=${workspace},target=/workspace`,
    '--mount',
    `type=volume,source=${store},target=/store`,
    '--entrypoint',
    '/usr/local/bin/node',
    c.image,
    '-e',
    bootstrap,
    JSON.stringify(args),
  ]);
  docker(
    ['cp', '-a', '-', `${name}:/workspace`],
    encodeContainerArchive(source.map((entry) => ({ ...entry, path: `candidate/${entry.path}` }))),
  );
  if (!offline)
    docker(
      ['cp', '-a', '-', `${name}:/store`],
      encodeContainerArchive([
        {
          path: 'v3/.devai-provisioned',
          mode: '100644',
          bytes: Buffer.from('devai-frozen-dependency-store-v1\n'),
        },
      ]),
    );
  const log = docker(['start', '--attach', name]);
  writeFileSync(join(c.output_directory, `${suffix}.log`), log, { flag: 'wx', mode: 0o600 });
  const state = JSON.parse(docker(['inspect', name]))[0];
  if (
    state.State.Running ||
    state.State.Pid !== 0 ||
    state.State.Restarting ||
    state.State.OOMKilled ||
    state.State.ExitCode !== 0 ||
    state.Mounts.some((m) => m.Type !== 'volume')
  )
    throw new Error('DEVAI_DEPENDENCY_INSTALL_NOT_QUIESCENT');
  const dependencies = [];
  for (const [index, mount_path] of [
    'node_modules',
    ...inputs.workspace_packages.map((pkg) => `${pkg.path}/node_modules`),
  ].entries()) {
    const raw = docker(['cp', `${name}:/workspace/candidate/${mount_path}/.`, '-']);
    const entries = decodeContainerDependencyArchive(raw, maximumBytes);
    const archive = encodeContainerDependencyArchive(entries);
    const dependency = { mount_path, archive, sha256: hash(archive), inputs };
    dependencies.push(dependency);
    if (offline) {
      const filename = `dependency-${String(index).padStart(2, '0')}.tar`;
      writeFileSync(join(c.output_directory, filename), archive, { flag: 'wx', mode: 0o600 });
      artifacts.push({
        mount_path,
        file: filename,
        sha256: dependency.sha256,
        size_bytes: archive.length,
        regular_files: entries.filter((e) => e.mode !== '120000').length,
        links: entries.filter((e) => e.mode === '120000').length,
      });
    }
  }
  const transport = validateProtectedDependencyTransport(dependencies, maximumBytes);
  verifyProtectedDependencyInputs(transport, source);
  outputs.push(transport.identity_sha256);
  // Retain stopped containers and named volumes for independent audit; never broad cleanup.
}
if (outputs[0] !== outputs[1]) throw new Error('DEVAI_DEPENDENCY_OFFLINE_REBUILD_MISMATCH');
writeFileSync(
  join(c.output_directory, 'dependencies.json'),
  JSON.stringify(
    {
      protocol: 'devai.protected-linux-dependencies.v1',
      candidate: { commit: c.commit, tree },
      image: c.image,
      engine_version: c.engine_version,
      inputs,
      identity_sha256: outputs[0],
      offline_rebuild_identical: true,
      artifacts,
      retained_resource_prefix: id,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx', mode: 0o600 },
);
console.log(
  JSON.stringify({
    output_directory: c.output_directory,
    identity_sha256: outputs[0],
    artifacts: artifacts.length,
    retained_resource_prefix: id,
  }),
);
