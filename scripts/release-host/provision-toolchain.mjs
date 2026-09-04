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
const expectedIdentity = {
  protocol: 'devai.protected-linux-toolchain.v1',
  platform: 'linux/arm64',
  snapshot: '20260824T000000Z',
  distribution: { id: 'debian', version_id: '13', codename: 'trixie' },
  packages: {
    git: { version: '1:2.47.3-0+deb13u1', architecture: 'arm64' },
    'git-man': { version: '1:2.47.3-0+deb13u1', architecture: 'all' },
    procps: { version: '2:4.0.4-9', architecture: 'arm64' },
    'libproc2-0': { version: '2:4.0.4-9', architecture: 'arm64' },
  },
  versions: {
    node: 'v24.20.0',
    pnpm: '9.15.0',
    git: 'git version 2.47.3',
    ps: 'ps from procps-ng 4.0.4',
  },
};
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
    `devai-release-toolchain:trixie-reproducible-${attempt}`,
    '--file',
    join(context, 'Dockerfile.tools'),
    context,
  ]);
  const id = readFileSync(iid, 'utf8').trim();
  if (!/^sha256:[0-9a-f]{64}$/u.test(id)) throw new Error('DEVAI_TOOLCHAIN_IMAGE_ID_INVALID');
  ids.push(id);
  const image = JSON.parse(docker(['image', 'inspect', id]))[0];
  if (
    image.Id !== id ||
    image.Os !== 'linux' ||
    image.Architecture !== 'arm64' ||
    image.RootFS?.Type !== 'layers'
  )
    throw new Error('DEVAI_TOOLCHAIN_IMAGE_ID_INVALID');
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
// Fixed image-local verifier: no host path, candidate input, network, signal to
// another process, or timestamp/PID enters the resulting identity/provenance.
const runtimeProbe = `
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');
const expected=${JSON.stringify(expectedIdentity)};
const identity=JSON.parse(fs.readFileSync('/opt/devai-toolchain/identity.json','utf8'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
for(const [key,value]of Object.entries(expected))assert.deepEqual(identity[key],value);
assert.equal(process.platform,'linux');assert.equal(process.arch,'arm64');assert.equal(process.version,expected.versions.node);
const os=Object.fromEntries(fs.readFileSync('/etc/os-release','utf8').split('\\n').filter(x=>/^(ID|VERSION_ID|VERSION_CODENAME)=/.test(x)).map(x=>{const [k,v]=x.split('=');return[k,v.replace(/^"|"$/g,'')]}));
assert.equal(os.ID,expected.distribution.id);assert.equal(os.VERSION_ID,expected.distribution.version_id);assert.equal(os.VERSION_CODENAME,expected.distribution.codename);
assert.deepEqual(fs.readdirSync('/etc/apt/sources.list.d').sort(),['debian.sources']);
assert(!fs.existsSync('/etc/apt/sources.list')||fs.readFileSync('/etc/apt/sources.list','utf8').trim()==='');
const aptSources=['debian','debian-security'].map(archive=>'Types: deb\\nURIs: https://snapshot.debian.org/archive/'+archive+'/'+expected.snapshot+'\\nSuites: '+(archive==='debian'?'trixie trixie-updates':'trixie-security')+'\\nComponents: main\\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\\nCheck-Valid-Until: no\\n').join('\\n');
assert.equal(fs.readFileSync('/etc/apt/sources.list.d/debian.sources','utf8'),aptSources);assert.equal(identity.apt_sources_sha256,hash(aptSources));
const environment={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',LANG:'C',LC_ALL:'C'};
const executablePaths={node:'/usr/local/bin/node',pnpm:'/usr/local/bin/pnpm',git:'/usr/bin/git',ps:'/usr/bin/ps'};
assert.deepEqual(Object.keys(identity.executables).sort(),Object.keys(executablePaths).sort());
for(const [name,path]of Object.entries(executablePaths)){
 const entry=identity.executables[name],stat=fs.lstatSync(path);assert.equal(entry.path,path);assert(stat.isFile()&&(stat.mode&0o111)!==0);assert.match(entry.sha256,/^[a-f0-9]{64}$/);assert.equal(hash(fs.readFileSync(path)),entry.sha256);
 assert.equal(cp.execFileSync(path,['--version'],{env:environment,encoding:'utf8',timeout:10000}).trim(),expected.versions[name]);
}
for(const [name,pin]of Object.entries(expected.packages))assert.equal(cp.execFileSync('/usr/bin/dpkg-query',['-W','-f=\${Version}\\t\${Architecture}',name],{env:environment,encoding:'utf8',timeout:10000}).trim(),pin.version+'\\t'+pin.architecture);
const ps=cp.spawnSync('/usr/bin/ps',['-o','pid','--no-headers','--ppid',String(process.pid)],{env:environment,encoding:'utf8',timeout:10000});
assert.equal(ps.status,0);assert(!ps.error&&!ps.signal);assert(ps.stdout.trim().split(/\\s+/).includes(String(ps.pid)));
process.stdout.write(JSON.stringify(identity));
`;
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
  '--user',
  '10001:10001',
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
  runtimeProbe,
]);
const identity = JSON.parse(observed);
if (
  Object.entries(expectedIdentity).some(
    ([key, value]) => JSON.stringify(identity[key]) !== JSON.stringify(value),
  )
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
      runtime_verification: {
        distribution_and_snapshot: true,
        package_versions: true,
        executable_versions_and_hashes: true,
        ps_parent_pid_flags: true,
      },
      identity,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx', mode: 0o600 },
);
console.log(JSON.stringify({ image: ids[0], output_directory: c.output_directory }));
