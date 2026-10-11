import Ajv2020 from 'ajv/dist/2020.js';
import {
  assertNativeLinuxIsolation,
  type NativeLinuxIsolationFacts,
} from './native-service-supervisor.js';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validNativeRedisProcessControl } from './native-service-docker-broker.js';
import type {
  NativeDockerBinding,
  NativeDockerImage,
  NativeServiceControlContext,
  NativeServiceFixtureKind,
} from './native-service-docker-broker.js';
import type { PlannedTask, TaskPlan } from './services/check-runner/types.js';

export interface NativeLinuxSnapshot {
  readonly volume: string;
  readonly manifestSha256: string;
}
export interface NativeLinuxPortableInput {
  readonly schemaVersion: '1.0.0';
  readonly nonce: string;
  readonly repository: '/workspace';
  readonly kind: 'unit_test' | 'integration_test' | 'e2e_test';
  readonly inputs: { readonly taskId: string; readonly population: string };
  readonly candidate: string;
  readonly tree: string;
  readonly backendRecordSha256: string;
  readonly snapshotManifestSha256: {
    readonly candidate: string;
    readonly dependencies: string;
    readonly helpers: string;
  };
}
export interface NativeLinuxDerivedTask {
  readonly schemaVersion: '1.0.0';
  readonly nonce: string;
  readonly kind: 'linux-task-plan';
  readonly inputSha256: string;
  readonly plan: TaskPlan;
  readonly task: PlannedTask;
  readonly environment: Readonly<Record<string, string>>;
  readonly command: {
    readonly executable: { readonly path: string; readonly sha256: string };
    readonly argv: readonly string[];
    readonly cwd: string;
  };
  readonly preload: { readonly path: string; readonly sha256: string };
  readonly runtimeRoot: string;
  readonly outputRoot: string | null;
  readonly selectionDigest: string;
  readonly git: { readonly path: string; readonly sha256: string };
  readonly node: { readonly path: string; readonly sha256: string; readonly version: string };
  readonly packageDir: string;
  readonly tracked: readonly string[];
  readonly excludedPrefixes: readonly string[];
  readonly capabilities: readonly string[];
  readonly prerequisiteDigests: Readonly<Record<string, string>>;
  readonly digest: string;
}
/** Host-private immutable transport. The public binder must separately mint its exact process tuple. */
export interface NativeLinuxTaskSupervisorPlan {
  readonly schemaVersion: '1.0.0';
  readonly nonce: string;
  readonly docker: NativeDockerBinding;
  readonly hostAssets: Readonly<
    Record<NativeLinuxHostAssetKey, { readonly path: string; readonly sha256: string }>
  >;
  readonly backend: {
    readonly recordId: string;
    readonly recordSha256: string;
    readonly runtime: {
      readonly id: string;
      readonly architecture: 'amd64' | 'arm64';
      readonly os: 'linux';
      readonly reference?: string;
    };
    readonly seccomp: { readonly path: string; readonly sha256: string };
  };
  readonly identity: {
    readonly profile:
      | 'postgres-http-v1'
      | 'postgres-http-s3-v1'
      | 'postgres-redis-http-s3-kms-v1'
      | 'playwright-chromium-web-v1';
    readonly repository: '/workspace';
    readonly candidate: string;
    readonly tree: string;
    readonly taskId: string;
    readonly population: string;
    readonly taskPolicySha256: string;
    readonly inputSha256: string;
  };
  readonly snapshots: {
    readonly candidate: NativeLinuxSnapshot;
    readonly dependencies: NativeLinuxSnapshot;
    readonly helpers: NativeLinuxSnapshot;
  };
  readonly services: {
    readonly images: {
      readonly postgres?: NativeDockerImage;
      readonly redis?: NativeDockerImage;
      readonly localstack?: NativeDockerImage;
    };
    readonly kinds: readonly NativeServiceFixtureKind[];
    readonly redisProcessControl: NativeServiceControlContext['redisProcessControl'];
    readonly limits: NativeServiceControlContext['limits'];
  };
  readonly portableInput: { readonly json: string; readonly sha256: string };
  readonly limits: {
    readonly taskTimeoutMs: number;
    readonly prepareTimeoutMs: number;
    readonly replayTimeoutMs: number;
    readonly cleanupTimeoutMs: number;
    readonly maxOutputBytes: number;
    readonly memoryBytes: number;
    readonly pids: number;
    readonly shmBytes: number;
  };
}
export interface NativeLinuxBackendRecord {
  readonly id: string;
  readonly kind: 'owned-linux-native-v1';
  readonly status: 'candidate' | 'active';
  readonly platform: { readonly os: 'linux'; readonly architecture: 'amd64' | 'arm64' };
  readonly baseImage: {
    readonly imageId: string;
    readonly runtimeManifestSha256: string;
    readonly reference?: string;
    readonly archive: { readonly kind: 'docker-image-archive-v1'; readonly sha256: string };
  };
  readonly recipe: { readonly id: 'owned-linux-native-v1'; readonly sha256: string };
  readonly containment: { readonly kind: 'docker-none-anchor-v1'; readonly policySha256: string };
  readonly node: { readonly path: string; readonly sha256: string; readonly version: '24.20.0' };
  readonly git: { readonly path: string; readonly sha256: string; readonly version: string };
  readonly browser?: {
    readonly path: string;
    readonly distributionSha256: string;
    readonly playwrightVersion: '1.60.0';
    readonly chromiumRevision: string;
  };
  readonly supportedProfiles: readonly string[];
  readonly redisProcessControl?: Exclude<NativeServiceControlContext['redisProcessControl'], null>;
  readonly limits: {
    readonly executionTimeoutMs: number;
    readonly startupTimeoutMs: number;
    readonly cleanupTimeoutMs: number;
    readonly maxBufferBytes: number;
    readonly memoryBytes: number;
    readonly pids: number;
    readonly maxInstancesPerKind: {
      readonly postgres: number;
      readonly redis: number;
      readonly localstackS3: number;
      readonly localstackS3Kms: number;
    };
  };
}
export interface NativeLinuxTaskSupervisorReceipt {
  readonly schemaVersion: '1.0.0';
  readonly kind: 'native-linux-task-receipt' | 'diagnostic-zero-origin';
  readonly standing: false;
  readonly nonce: string;
  readonly planSha256: string;
  readonly backendRecordSha256: string;
  readonly complete: boolean;
  readonly child: {
    readonly status: number | null;
    readonly stdoutSha256: string;
    readonly stderrSha256: string;
    readonly stdoutBytes: number;
    readonly stderrBytes: number;
  } | null;
  readonly derived: NativeLinuxDerivedTask | null;
  readonly replay: Readonly<Record<string, unknown>> | null;
  readonly lifecycle: readonly Readonly<Record<string, unknown>>[];
  readonly failures: readonly string[];
  readonly cleanupComplete: boolean;
}
const HOST_ASSET_FILES = {
  supervisor: 'native-linux-task-supervisor.js',
  serviceSupervisor: 'native-service-supervisor.js',
  dockerBroker: 'native-service-docker-broker.js',
  linuxPlan: 'native-linux-plan.js',
  linuxReplay: 'native-linux-replay.js',
  inputPreload: 'native-input-provenance.js',
  coverageAdapter: 'native-coverage-adapter.js',
  coverageKernel: 'native-coverage-kernel.js',
  coverageData: 'native-coverage-data.js',
  serviceFixtures: 'native-service-fixtures.js',
  serviceFixturesKernel: 'native-service-fixtures-kernel.js',
  vitestReporter: 'native-test-reporter.js',
  playwrightReporter: 'native-playwright-reporter.js',
  platformProbes: 'native-platform-probes.js',
  playwrightLoader: 'native-playwright-loader.js',
} as const;
export type NativeLinuxHostAssetKey = keyof typeof HOST_ASSET_FILES;
const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const fail = (reason: string): never => {
  throw new Error(`NATIVE_LINUX_${reason}`);
};
type Document = Record<string, unknown>;
const object = (value: unknown): Document => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return fail('OBJECT_INVALID');
  return value as Document;
};
const closed = (value: unknown, keys: readonly string[]): boolean => {
  try {
    return Object.keys(object(value)).sort().join(',') === [...keys].sort().join(',');
  } catch {
    return false;
  }
};
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) && value !== '0'.repeat(64);
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
const canonical = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('CANONICAL_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const row = object(value);
  return (
    '{' +
    Object.keys(row)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(row[key]))
      .join(',') +
    '}'
  );
};
const privateName = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value);
const boundPath = (root: string, value: string): boolean =>
  value === root || value.startsWith(`${root}/`);
function validatePlan(value: unknown): NativeLinuxTaskSupervisorPlan {
  if (
    !closed(value, [
      'schemaVersion',
      'nonce',
      'docker',
      'hostAssets',
      'backend',
      'identity',
      'snapshots',
      'services',
      'portableInput',
      'limits',
    ])
  )
    return fail('PLAN_INVALID');
  const plan = value as NativeLinuxTaskSupervisorPlan;
  if (
    !closed(plan.hostAssets, Object.keys(HOST_ASSET_FILES)) ||
    Object.values(plan.hostAssets).some(
      (asset) =>
        !closed(asset, ['path', 'sha256']) || !isAbsolute(asset.path) || !hex(asset.sha256),
    )
  )
    return fail('HOST_ASSETS_INVALID');
  if (
    plan.schemaVersion !== '1.0.0' ||
    !hex(plan.nonce) ||
    !closed(plan.backend, ['recordId', 'recordSha256', 'runtime', 'seccomp']) ||
    !closed(
      plan.backend.runtime,
      plan.backend.runtime.reference === undefined
        ? ['id', 'architecture', 'os']
        : ['id', 'architecture', 'os', 'reference'],
    ) ||
    !closed(plan.backend.seccomp, ['path', 'sha256']) ||
    !hex(plan.backend.recordSha256) ||
    !hex(plan.backend.seccomp.sha256) ||
    !isAbsolute(plan.backend.seccomp.path) ||
    !/^sha256:[a-f0-9]{64}$/u.test(plan.backend.runtime.id) ||
    plan.backend.runtime.os !== 'linux' ||
    !['amd64', 'arm64'].includes(plan.backend.runtime.architecture) ||
    !['owned-linux-native-v1-linux-amd64', 'owned-linux-native-v1-linux-arm64'].includes(
      plan.backend.recordId,
    )
  )
    return fail('BACKEND_INVALID');
  if (
    !closed(plan.identity, [
      'profile',
      'repository',
      'candidate',
      'tree',
      'taskId',
      'population',
      'taskPolicySha256',
      'inputSha256',
    ]) ||
    ![
      'postgres-http-v1',
      'postgres-http-s3-v1',
      'postgres-redis-http-s3-kms-v1',
      'playwright-chromium-web-v1',
    ].includes(plan.identity.profile) ||
    plan.identity.repository !== '/workspace' ||
    !/^([a-f0-9]{40})$/u.test(plan.identity.candidate) ||
    !/^([a-f0-9]{40})$/u.test(plan.identity.tree) ||
    !plan.identity.taskId ||
    !plan.identity.population ||
    !hex(plan.identity.taskPolicySha256) ||
    !hex(plan.identity.inputSha256)
  )
    return fail('IDENTITY_INVALID');
  if (!closed(plan.snapshots, ['candidate', 'dependencies', 'helpers']))
    return fail('SNAPSHOTS_INVALID');
  for (const snapshot of Object.values(plan.snapshots))
    if (
      !closed(snapshot, ['volume', 'manifestSha256']) ||
      !privateName(snapshot.volume) ||
      !hex(snapshot.manifestSha256)
    )
      return fail('SNAPSHOT_INVALID');
  if (new Set(Object.values(plan.snapshots).map((s) => s.volume)).size !== 3)
    return fail('SNAPSHOT_ALIAS');
  if (
    !closed(plan.portableInput, ['json', 'sha256']) ||
    !hex(plan.portableInput.sha256) ||
    Buffer.byteLength(plan.portableInput.json) > 4 * 1024 * 1024 ||
    hash(plan.portableInput.json) !== plan.portableInput.sha256
  )
    return fail('PORTABLE_INPUT_INVALID');
  const input = JSON.parse(plan.portableInput.json) as NativeLinuxPortableInput;
  if (
    !closed(input, [
      'schemaVersion',
      'nonce',
      'repository',
      'kind',
      'inputs',
      'candidate',
      'tree',
      'backendRecordSha256',
      'snapshotManifestSha256',
    ]) ||
    !closed(input.inputs, ['taskId', 'population']) ||
    !closed(input.snapshotManifestSha256, ['candidate', 'dependencies', 'helpers']) ||
    input.schemaVersion !== '1.0.0' ||
    input.nonce !== plan.nonce ||
    input.repository !== '/workspace' ||
    !['unit_test', 'integration_test', 'e2e_test'].includes(input.kind) ||
    input.candidate !== plan.identity.candidate ||
    input.tree !== plan.identity.tree ||
    input.inputs.taskId !== plan.identity.taskId ||
    input.inputs.population !== plan.identity.population ||
    input.backendRecordSha256 !== plan.backend.recordSha256 ||
    plan.identity.inputSha256 !== plan.portableInput.sha256 ||
    (['candidate', 'dependencies', 'helpers'] as const).some(
      (k) => input.snapshotManifestSha256[k] !== plan.snapshots[k].manifestSha256,
    )
  )
    return fail('PORTABLE_BINDING_INVALID');
  if (
    !closed(plan.limits, [
      'taskTimeoutMs',
      'prepareTimeoutMs',
      'replayTimeoutMs',
      'cleanupTimeoutMs',
      'maxOutputBytes',
      'memoryBytes',
      'pids',
      'shmBytes',
    ]) ||
    !integer(plan.limits.taskTimeoutMs, 1, 3600000) ||
    !integer(plan.limits.prepareTimeoutMs, 1, 300000) ||
    !integer(plan.limits.replayTimeoutMs, 1, 300000) ||
    !integer(plan.limits.cleanupTimeoutMs, 1, 60000) ||
    !integer(plan.limits.maxOutputBytes, 1, 64 * 1024 * 1024) ||
    !integer(plan.limits.memoryBytes, 64 * 1024 * 1024, 16 * 1024 * 1024 * 1024) ||
    !integer(plan.limits.pids, 16, 4096) ||
    !integer(plan.limits.shmBytes, 1024 * 1024, 1024 * 1024 * 1024)
  )
    return fail('LIMITS_INVALID');
  if (
    !closed(plan.services, ['images', 'kinds', 'limits', 'redisProcessControl']) ||
    !validNativeRedisProcessControl(plan.services.redisProcessControl) ||
    (plan.services.redisProcessControl !== null &&
      (!Array.isArray(plan.services.kinds) || !plan.services.kinds.includes('redis'))) ||
    !Array.isArray(plan.services.kinds) ||
    new Set(plan.services.kinds).size !== plan.services.kinds.length ||
    plan.services.kinds.length === 0 ||
    plan.services.kinds.some(
      (k) => !['postgres', 'redis', 'localstack-s3', 'localstack-s3-kms'].includes(k),
    )
  )
    return fail('SERVICES_INVALID');
  const expectedImages = [
    ...(plan.services.kinds.includes('postgres') ? ['postgres'] : []),
    ...(plan.services.kinds.includes('redis') ? ['redis'] : []),
    ...(plan.services.kinds.some((k) => k.startsWith('localstack-')) ? ['localstack'] : []),
  ];
  if (!closed(plan.services.images, expectedImages)) return fail('SERVICE_IMAGES_INVALID');
  for (const image of Object.values(plan.services.images))
    if (
      !closed(image, ['reference', 'id', 'architecture', 'os']) ||
      !/^[-a-zA-Z0-9_./:]+@sha256:[a-f0-9]{64}$/u.test(image.reference) ||
      !/^sha256:[a-f0-9]{64}$/u.test(image.id) ||
      image.os !== 'linux' ||
      image.architecture !== plan.backend.runtime.architecture
    )
      return fail('SERVICE_IMAGE_INVALID');
  const limits = plan.services.limits;
  if (
    !closed(limits, ['maxInstances', 'maxConcurrent', 'requestTimeoutMs', 'perKind']) ||
    !integer(limits.maxInstances, 1, 128) ||
    !integer(limits.maxConcurrent, 1, limits.maxInstances) ||
    !integer(limits.requestTimeoutMs, 100, 120000) ||
    !closed(limits.perKind, plan.services.kinds) ||
    (plan.services.kinds as readonly NativeServiceFixtureKind[]).some(
      (k) =>
        !closed(limits.perKind[k], ['maxInstances']) ||
        !integer(limits.perKind[k]?.maxInstances, 1, limits.maxInstances),
    )
  )
    return fail('SERVICE_LIMITS_INVALID');
  if (
    !closed(plan.docker, ['executable', 'sha256', 'socket', 'engine']) ||
    !isAbsolute(plan.docker.executable) ||
    !hex(plan.docker.sha256) ||
    !closed(plan.docker.socket, ['path', 'realpath', 'dev', 'ino']) ||
    !isAbsolute(plan.docker.socket.path) ||
    !isAbsolute(plan.docker.socket.realpath) ||
    !integer(plan.docker.socket.dev, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(plan.docker.socket.ino, 1, Number.MAX_SAFE_INTEGER) ||
    !closed(plan.docker.engine, ['id', 'serverVersion', 'apiVersion']) ||
    !plan.docker.engine.id ||
    !plan.docker.engine.serverVersion ||
    !/^\d+\.\d+$/u.test(plan.docker.engine.apiVersion)
  )
    return fail('DOCKER_BINDING_INVALID');
  return JSON.parse(JSON.stringify(plan)) as NativeLinuxTaskSupervisorPlan;
}
function cataloguePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packaged = resolve(here, '../../law/policy/native-service-backends.json');
  if (existsSync(packaged)) return packaged;
  return resolve(here, '../../../law/policy/native-service-backends.json');
}
function activeRecord(plan: NativeLinuxTaskSupervisorPlan): NativeLinuxBackendRecord {
  const path = cataloguePath();
  const policy = object(JSON.parse(readFileSync(path, 'utf8')));
  const here = dirname(fileURLToPath(import.meta.url));
  const packagedCatalogue = resolve(here, '../../law/policy/native-service-backends.json');
  const schemaPath =
    path === packagedCatalogue
      ? resolve(here, 'schemas/native-service-backends-policy.schema.json')
      : resolve(dirname(path), '../schemas/native-service-backends-policy.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  if (!validate(policy)) return fail('CATALOGUE_INVALID');
  if (policy['status'] !== 'active' || !Array.isArray(policy['records']))
    return fail('BACKEND_NOT_APPROVED');
  const matches = (policy['records'] as unknown[])
    .map(object)
    .filter((r) => r['id'] === plan.backend.recordId && r['status'] === 'active');
  if (matches.length !== 1) return fail('BACKEND_NOT_APPROVED');
  return matches[0] as unknown as NativeLinuxBackendRecord;
}
function bindRecord(plan: NativeLinuxTaskSupervisorPlan, record: NativeLinuxBackendRecord): void {
  if (!record.supportedProfiles.includes(plan.identity.profile))
    return fail('BACKEND_PROFILE_UNSUPPORTED');
  if (
    hash(canonical(record)) !== plan.backend.recordSha256 ||
    record.id !== plan.backend.recordId ||
    record.kind !== 'owned-linux-native-v1' ||
    record.platform.os !== 'linux' ||
    record.platform.architecture !== plan.backend.runtime.architecture ||
    record.baseImage.imageId !== plan.backend.runtime.id ||
    record.baseImage.reference !== plan.backend.runtime.reference ||
    record.containment.kind !== 'docker-none-anchor-v1' ||
    record.containment.policySha256 !== plan.backend.seccomp.sha256 ||
    record.node.path !== '/usr/local/bin/node' ||
    record.node.version !== '24.20.0' ||
    !hex(record.node.sha256) ||
    !hex(record.git.sha256)
  )
    return fail('BACKEND_RECORD_MISMATCH');
  if (
    plan.limits.taskTimeoutMs > record.limits.executionTimeoutMs ||
    plan.limits.prepareTimeoutMs > record.limits.startupTimeoutMs ||
    plan.limits.cleanupTimeoutMs > record.limits.cleanupTimeoutMs ||
    plan.limits.maxOutputBytes > record.limits.maxBufferBytes ||
    plan.limits.memoryBytes > record.limits.memoryBytes ||
    plan.limits.pids > record.limits.pids
  )
    return fail('BACKEND_LIMIT_EXCEEDED');
  if (
    plan.services.redisProcessControl !== null &&
    canonical(plan.services.redisProcessControl) !== canonical(record.redisProcessControl)
  )
    return fail('BACKEND_REDIS_CONTROL_CHANGED');
  const names = {
    postgres: 'postgres',
    redis: 'redis',
    'localstack-s3': 'localstackS3',
    'localstack-s3-kms': 'localstackS3Kms',
  } as const;
  for (const kind of plan.services.kinds)
    if (
      (plan.services.limits.perKind[kind]?.maxInstances ?? 0) >
      record.limits.maxInstancesPerKind[names[kind]]
    )
      return fail('BACKEND_SERVICE_LIMIT_EXCEEDED');
}

const SNAPSHOT_VERIFY = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const input=JSON.parse(fs.readFileSync(0,'utf8')),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const refuse=reason=>{throw Error('SNAPSHOT_'+reason)};const outputs=[];
for(const [root,expected]of input){
 const manifestPath=root+'/.devai-native-snapshot.json',manifestStat=fs.lstatSync(manifestPath);if(!manifestStat.isFile()||manifestStat.nlink!==1)refuse('MANIFEST_TYPE');
 const bytes=fs.readFileSync(manifestPath);if(bytes.length>33554432||sha(bytes)!==expected)refuse('MANIFEST_HASH');
 const manifest=JSON.parse(bytes);if(Object.keys(manifest).sort().join(',')!=='entries,schemaVersion'||manifest.schemaVersion!=='1.0.0'||!Array.isArray(manifest.entries)||manifest.entries.length>200000)refuse('MANIFEST_SHAPE');
 const observed=[];let total=0;const walk=dir=>{for(const name of fs.readdirSync(dir).sort()){const full=path.join(dir,name),relative=path.relative(root,full);if(relative==='.devai-native-snapshot.json')continue;if(relative.includes('\u0000'))refuse('PATH');const stat=fs.lstatSync(full),mode=stat.mode&4095;let row;
 if(stat.isDirectory()){row={path:relative,type:'directory',mode};observed.push(row);walk(full)}
 else if(stat.isSymbolicLink()){const target=fs.readlinkSync(full);const destination=path.resolve(path.dirname(full),target);if(!['/workspace','/opt/devai'].some(p=>destination===p||destination.startsWith(p+'/')))refuse('LINK_ESCAPE');row={path:relative,type:'symlink',mode,target};observed.push(row)}
 else if(stat.isFile()){if(stat.nlink!==1||stat.size>268435456||(total+=stat.size)>4294967296)refuse('FILE_LIMIT');const fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let content;try{const before=fs.fstatSync(fd);content=fs.readFileSync(fd);const after=fs.fstatSync(fd);if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||after.dev!==stat.dev||after.ino!==stat.ino||content.length!==stat.size)refuse('RACE')}finally{fs.closeSync(fd)}row={path:relative,type:'file',mode,size:stat.size,sha256:sha(content)};observed.push(row)}else refuse('SPECIAL_FILE');if(observed.length>200000)refuse('ENTRY_LIMIT')
 }};walk(root);observed.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);const expectedRows=[...manifest.entries].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);if(canonical(observed)!==canonical(expectedRows))refuse('CONTENT');outputs.push({root,manifestSha256:expected,entries:observed.length,bytes:total})
}console.log(JSON.stringify(outputs));`;

const PROCESS_FOREST = String.raw`
const fs=require('node:fs');const result=[];for(const name of fs.readdirSync('/proc')){if(!/^\d+$/.test(name))continue;try{const p='/proc/'+name,status=fs.readFileSync(p+'/status','utf8'),get=k=>status.split('\n').find(x=>x.startsWith(k+':'))?.split(':').slice(1).join(':').trim();result.push({pid:Number(name),ppid:Number(get('PPid')),uid:get('Uid'),gid:get('Gid'),capInh:get('CapInh'),capPrm:get('CapPrm'),capEff:get('CapEff'),capBnd:get('CapBnd'),capAmb:get('CapAmb'),noNewPrivs:get('NoNewPrivs'),seccomp:get('Seccomp'),cmdline:fs.readFileSync(p+'/cmdline').toString().split('\0').filter(Boolean),namespaces:Object.fromEntries(['net','pid','mnt','user','ipc'].map(n=>[n,fs.readlinkSync(p+'/ns/'+n)])),uidMap:fs.readFileSync(p+'/uid_map','utf8'),gidMap:fs.readFileSync(p+'/gid_map','utf8'),fds:fs.readdirSync(p+'/fd').map(n=>{try{return {fd:Number(n),target:fs.readlinkSync(p+'/fd/'+n)}}catch{return {fd:Number(n),target:'unreadable'}}})})}catch{}}console.log(JSON.stringify(result));`;

interface ExpectedMount {
  readonly type: string;
  readonly source: string;
  readonly destination: string;
  readonly rw: boolean;
}
interface OwnedContainer {
  readonly name: string;
  readonly role: string;
  id?: string;
  readonly mounts: readonly ExpectedMount[];
  readonly tmpfs: Readonly<Record<string, string>>;
  readonly security: readonly string[];
}
interface OwnedVolume {
  readonly name: string;
  readonly role: string;
  mountpoint?: string;
}
class LinuxEngine {
  readonly containers: OwnedContainer[] = [];
  readonly volumes: OwnedVolume[] = [];
  constructor(
    readonly plan: NativeLinuxTaskSupervisorPlan,
    readonly ledger: Document[],
    readonly planSha256: string,
  ) {}
  call(
    args: readonly string[],
    input?: string,
    timeout = this.plan.limits.prepareTimeoutMs,
  ): string {
    return execFileSync(
      this.plan.docker.executable,
      ['--host', `unix://${this.plan.docker.socket.realpath}`, ...args],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        input,
        timeout,
        maxBuffer: this.plan.limits.maxOutputBytes,
        env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' },
      },
    ).trim();
  }
  labels(role: string): string[] {
    return [
      '--label',
      `devai.native.nonce=${this.plan.nonce}`,
      '--label',
      `devai.native.plan-sha256=${this.planSha256}`,
      '--label',
      `devai.native.role=${role}`,
    ];
  }
  name(role: string): string {
    return `devai-native-${this.plan.nonce.slice(0, 20)}-${role}`;
  }
  inspect(id: string): Document {
    const rows = JSON.parse(this.call(['inspect', id]));
    if (!Array.isArray(rows) || rows.length !== 1) return fail('INSPECT_INVALID');
    return object(rows[0]);
  }
  owned(document: Document, role: string): void {
    const config = object(document['Config']),
      labels = object(config['Labels']);
    if (
      labels['devai.native.nonce'] !== this.plan.nonce ||
      labels['devai.native.plan-sha256'] !== this.planSha256 ||
      labels['devai.native.role'] !== role
    )
      return fail('OWNERSHIP_CHANGED');
  }
  create(role: string, args: readonly string[]): string {
    const name = this.name(role);
    if (this.call(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']) !== '')
      return fail('CONTAINER_NAME_EXISTS');
    const mounts: ExpectedMount[] = [],
      tmpfs: Record<string, string> = {},
      security: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const flag = args[index],
        value = args[index + 1];
      if (value === undefined) continue;
      if (flag === '--mount') {
        const fields = Object.fromEntries(
          value.split(',').map((part) => {
            const split = part.indexOf('=');
            return split < 0 ? [part, 'true'] : [part.slice(0, split), part.slice(split + 1)];
          }),
        );
        if (
          !['volume', 'bind'].includes(fields['type'] ?? '') ||
          typeof fields['source'] !== 'string' ||
          typeof fields['target'] !== 'string'
        )
          return fail('MOUNT_RECIPE_INVALID');
        mounts.push({
          type: fields['type'] ?? '',
          source: fields['source'],
          destination: fields['target'],
          rw: fields['readonly'] !== 'true',
        });
      } else if (flag === '--tmpfs') {
        const split = value.indexOf(':');
        if (split < 1) return fail('TMPFS_RECIPE_INVALID');
        tmpfs[value.slice(0, split)] = value.slice(split + 1);
      } else if (flag === '--security-opt') security.push(value);
    }
    const owned: OwnedContainer = { name, role, mounts, tmpfs, security };
    this.containers.push(owned);
    const id = this.call([
      'create',
      '--name',
      name,
      ...this.labels(role),
      '--pull',
      'never',
      ...args,
    ]);
    if (!/^[a-f0-9]{64}$/u.test(id)) return fail('CONTAINER_ID_INVALID');
    owned.id = id;
    const actual = this.inspect(id);
    this.owned(actual, role);
    this.verifyMountsAndSecurity(actual, owned);
    if (actual['Id'] !== id) return fail('CONTAINER_ID_CHANGED');
    this.ledger.push({ operation: 'container-create', role, id, name, inspection: actual });
    return id;
  }
  verifyMountsAndSecurity(actual: Document, owned: OwnedContainer): void {
    const observed = actual['Mounts'],
      host = object(actual['HostConfig']);
    if (!Array.isArray(observed) || observed.length !== owned.mounts.length)
      return fail('MOUNT_SET_CHANGED');
    for (const expected of owned.mounts) {
      const rows = observed
        .map(object)
        .filter((row) => row['Destination'] === expected.destination);
      if (rows.length !== 1) return fail('MOUNT_DESTINATION_CHANGED');
      const row = rows[0];
      if (
        !row ||
        row['Type'] !== expected.type ||
        row['RW'] !== expected.rw ||
        (expected.type === 'volume'
          ? row['Name'] !== expected.source
          : row['Source'] !== expected.source)
      )
        return fail('MOUNT_IDENTITY_CHANGED');
    }
    if (canonical(host['Tmpfs'] ?? {}) !== canonical(owned.tmpfs)) return fail('TMPFS_SET_CHANGED');
    const security = host['SecurityOpt'];
    if (!Array.isArray(security) || security.length !== owned.security.length)
      return fail('SECCOMP_SET_CHANGED');
    for (const expected of owned.security) {
      if (expected.startsWith('seccomp=')) {
        const rows = security.filter(
          (value) => typeof value === 'string' && value.startsWith('seccomp='),
        );
        if (
          rows.length !== 1 ||
          typeof rows[0] !== 'string' ||
          canonical(JSON.parse(rows[0].slice(8))) !==
            canonical(JSON.parse(readFileSync(expected.slice(8), 'utf8')))
        )
          return fail('SECCOMP_CHANGED');
      } else if (!security.includes(expected)) return fail('SECURITY_OPT_CHANGED');
    }
  }
  volume(role: string, size: number): OwnedVolume {
    const name = this.name(role);
    if (this.call(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']) !== '')
      return fail('VOLUME_NAME_EXISTS');
    const owned: OwnedVolume = { name, role };
    this.volumes.push(owned);
    if (
      this.call([
        'volume',
        'create',
        ...this.labels(role),
        '--driver',
        'local',
        '--opt',
        'type=tmpfs',
        '--opt',
        'device=tmpfs',
        '--opt',
        `o=uid=1000,gid=1000,mode=0700,size=${size}`,
        name,
      ]) !== name
    )
      return fail('VOLUME_CREATE_INVALID');
    const document = object(JSON.parse(this.call(['volume', 'inspect', name]))[0]),
      labels = object(document['Labels']);
    if (
      labels['devai.native.nonce'] !== this.plan.nonce ||
      labels['devai.native.plan-sha256'] !== this.planSha256 ||
      document['Name'] !== name ||
      typeof document['Mountpoint'] !== 'string' ||
      !document['Mountpoint'].startsWith(`/var/lib/docker/volumes/${name}/`)
    )
      return fail('VOLUME_IDENTITY_INVALID');
    owned.mountpoint = document['Mountpoint'];
    this.ledger.push({ operation: 'volume-create', role, name, inspection: document });
    return owned;
  }
  absent(id: string): boolean {
    return (
      this.call([
        'ps',
        '-a',
        '--filter',
        /^[a-f0-9]{64}$/u.test(id) ? `id=${id}` : `name=^/${id}$`,
        '--format',
        '{{.ID}}',
      ]) === ''
    );
  }
  remove(id: string): void {
    const owned = this.containers.find((item) => item.id === id || item.name === id);
    if (!owned) return fail('UNOWNED_CONTAINER');
    if (this.absent(owned.id ?? owned.name)) {
      this.ledger.push({
        operation: 'container-absence',
        role: owned.role,
        id: owned.id ?? owned.name,
        absent: true,
      });
      return;
    }
    const actual = this.inspect(owned.id ?? owned.name);
    this.owned(actual, owned.role);
    if (object(actual['State'])['Paused'] === true && owned.role.startsWith('redis-')) {
      if (actual['Image'] !== this.plan.services.images.redis?.id)
        return fail('REDIS_CLEANUP_IDENTITY_CHANGED');
      this.call(['unpause', owned.id ?? owned.name], undefined, this.plan.limits.cleanupTimeoutMs);
      const resumed = this.inspect(owned.id ?? owned.name);
      this.owned(resumed, owned.role);
      if (
        resumed['Id'] !== actual['Id'] ||
        resumed['Image'] !== actual['Image'] ||
        object(resumed['State'])['Paused'] !== false ||
        object(resumed['State'])['Running'] !== true
      )
        return fail('REDIS_CLEANUP_RESUME_UNPROVEN');
      this.ledger.push({
        operation: 'redis-cleanup-resume',
        id: actual['Id'],
        before: actual,
        after: resumed,
      });
    }
    let contractFailure: string | undefined;
    try {
      this.verifyMountsAndSecurity(actual, owned);
    } catch (cause) {
      contractFailure = String(cause);
      this.ledger.push({
        operation: 'terminal-mount-security-failure',
        id: actual['Id'],
        error: contractFailure,
      });
    }
    if (owned.id !== undefined && actual['Id'] !== owned.id) return fail('CONTAINER_REPLACED');
    this.call(
      ['rm', '--force', '--volumes', owned.id ?? owned.name],
      undefined,
      this.plan.limits.cleanupTimeoutMs,
    );
    if (!this.absent(owned.id ?? owned.name)) return fail('CONTAINER_NOT_ABSENT');
    this.ledger.push({
      operation: 'container-absence',
      role: owned.role,
      id: actual['Id'],
      absent: true,
    });
    if (contractFailure) throw new Error(contractFailure);
  }
  cleanup(failures: string[]): boolean {
    for (const owned of [...this.containers].reverse())
      try {
        this.remove(owned.id ?? owned.name);
      } catch (cause) {
        failures.push(String(cause));
      }
    for (const owned of [...this.volumes].reverse())
      try {
        const names = this.call([
          'volume',
          'ls',
          '--filter',
          `name=^${owned.name}$`,
          '--format',
          '{{.Name}}',
        ]);
        if (names !== '') {
          const actual = object(JSON.parse(this.call(['volume', 'inspect', owned.name]))[0]),
            labels = object(actual['Labels']);
          if (
            labels['devai.native.nonce'] !== this.plan.nonce ||
            labels['devai.native.plan-sha256'] !== this.planSha256 ||
            labels['devai.native.role'] !== owned.role ||
            actual['Name'] !== owned.name ||
            (owned.mountpoint !== undefined && actual['Mountpoint'] !== owned.mountpoint)
          )
            return fail('VOLUME_OWNERSHIP_CHANGED');
          this.call(['volume', 'rm', owned.name], undefined, this.plan.limits.cleanupTimeoutMs);
        }
        const absent =
          this.call([
            'volume',
            'ls',
            '--filter',
            `name=^${owned.name}$`,
            '--format',
            '{{.Name}}',
          ]) === '';
        this.ledger.push({ operation: 'volume-absence', name: owned.name, absent });
        if (!absent) return fail('VOLUME_NOT_ABSENT');
      } catch (cause) {
        failures.push(String(cause));
      }
    return (
      this.containers.every((item) =>
        this.ledger.some(
          (row) =>
            row['operation'] === 'container-absence' &&
            (row['id'] === item.id || row['id'] === item.name) &&
            row['absent'] === true,
        ),
      ) &&
      this.volumes.every((item) =>
        this.ledger.some(
          (row) =>
            row['operation'] === 'volume-absence' &&
            row['name'] === item.name &&
            row['absent'] === true,
        ),
      )
    );
  }
}
function verifyHost(plan: NativeLinuxTaskSupervisorPlan, engine: LinuxEngine): void {
  for (const [name, asset] of Object.entries(plan.hostAssets)) {
    const expected =
      name === 'supervisor'
        ? fileURLToPath(import.meta.url)
        : fileURLToPath(
            new URL('./' + HOST_ASSET_FILES[name as NativeLinuxHostAssetKey], import.meta.url),
          );
    if (
      asset.path !== realpathSync(expected) ||
      realpathSync(asset.path) !== asset.path ||
      !lstatSync(asset.path).isFile() ||
      hash(readFileSync(asset.path)) !== asset.sha256
    )
      return fail('HOST_ASSET_CHANGED');
  }
  const executable = lstatSync(plan.docker.executable),
    socket = lstatSync(plan.docker.socket.realpath),
    seccomp = lstatSync(plan.backend.seccomp.path);
  if (
    !executable.isFile() ||
    realpathSync(plan.docker.executable) !== plan.docker.executable ||
    hash(readFileSync(plan.docker.executable)) !== plan.docker.sha256 ||
    !socket.isSocket() ||
    realpathSync(plan.docker.socket.path) !== plan.docker.socket.realpath ||
    socket.dev !== plan.docker.socket.dev ||
    socket.ino !== plan.docker.socket.ino ||
    !seccomp.isFile() ||
    seccomp.nlink !== 1 ||
    realpathSync(plan.backend.seccomp.path) !== plan.backend.seccomp.path ||
    hash(readFileSync(plan.backend.seccomp.path)) !== plan.backend.seccomp.sha256
  )
    return fail('HOST_IDENTITY_CHANGED');
  const info = object(JSON.parse(engine.call(['info', '--format', '{{json .}}']))),
    version = object(JSON.parse(engine.call(['version', '--format', '{{json .Server}}'])));
  if (
    info['ID'] !== plan.docker.engine.id ||
    info['ServerVersion'] !== plan.docker.engine.serverVersion ||
    version['ApiVersion'] !== plan.docker.engine.apiVersion
  )
    return fail('ENGINE_CHANGED');
  for (const image of [plan.backend.runtime, ...Object.values(plan.services.images)]) {
    const actual = object(JSON.parse(engine.call(['image', 'inspect', image.id]))[0]);
    if (
      actual['Id'] !== image.id ||
      actual['Architecture'] !== image.architecture ||
      actual['Os'] !== 'linux' ||
      (image.reference !== undefined &&
        (!Array.isArray(actual['RepoDigests']) || !actual['RepoDigests'].includes(image.reference)))
    )
      return fail('IMAGE_CHANGED');
  }
  engine.ledger.push({
    operation: 'host-identity',
    docker: plan.docker,
    runtime: plan.backend.runtime,
    serviceImages: plan.services.images,
  });
}
const mount = (volume: string, target: string, readonly = true): string[] => [
  '--mount',
  `type=volume,source=${volume},target=${target}${readonly ? ',readonly' : ''}`,
];
function sandbox(plan: NativeLinuxTaskSupervisorPlan): string[] {
  return [
    '--read-only',
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--security-opt',
    `seccomp=${plan.backend.seccomp.path}`,
    '--cpus',
    '2',
    '--pids-limit',
    String(plan.limits.pids),
    '--memory',
    String(plan.limits.memoryBytes),
    '--memory-swap',
    String(plan.limits.memoryBytes),
    '--shm-size',
    String(plan.limits.shmBytes),
    '--ipc',
    'private',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,uid=1000,gid=1000,mode=1777,size=134217728',
    '--env',
    'HOME=/tmp',
    '--env',
    'PATH=/usr/local/bin:/usr/bin:/bin',
  ];
}
function snapshots(plan: NativeLinuxTaskSupervisorPlan): string[] {
  return [
    ...mount(plan.snapshots.candidate.volume, '/workspace'),
    ...mount(plan.snapshots.dependencies.volume, '/workspace/node_modules'),
    ...mount(plan.snapshots.helpers.volume, '/opt/devai'),
  ];
}
function verifyContainer(engine: LinuxEngine, id: string, network: string): void {
  const actual = engine.inspect(id),
    host = object(actual['HostConfig']),
    config = object(actual['Config']);
  if (
    host['ReadonlyRootfs'] !== true ||
    config['User'] !== '1000:1000' ||
    host['NetworkMode'] !== network ||
    host['Privileged'] !== false ||
    host['PidMode'] !== '' ||
    host['IpcMode'] !== 'private' ||
    !Array.isArray(host['CapDrop']) ||
    host['CapDrop'].join(',').toUpperCase() !== 'ALL' ||
    (Array.isArray(host['CapAdd']) && host['CapAdd'].length !== 0) ||
    Object.keys(object(host['PortBindings'] ?? {})).length !== 0 ||
    host['PublishAllPorts'] === true ||
    (Array.isArray(host['ExtraHosts']) && host['ExtraHosts'].length !== 0) ||
    (Array.isArray(host['Devices']) && host['Devices'].length !== 0) ||
    !Array.isArray(host['SecurityOpt']) ||
    !host['SecurityOpt'].some(
      (item) => typeof item === 'string' && item.startsWith('no-new-privileges'),
    ) ||
    Number(host['NanoCpus']) !== 2_000_000_000 ||
    Number(host['Memory']) !== engine.plan.limits.memoryBytes ||
    Number(host['PidsLimit']) !== engine.plan.limits.pids
  )
    return fail('CONTAINER_CONTAINMENT_CHANGED');
  const mounts = actual['Mounts'];
  if (
    !Array.isArray(mounts) ||
    mounts.some(
      (item) =>
        typeof object(item)['Source'] !== 'string' ||
        String(object(item)['Source']).includes('docker.sock'),
    )
  )
    return fail('ENGINE_MOUNT_EXPOSED');
  engine.ledger.push({ operation: 'container-config-verified', id, network, inspection: actual });
}
function helper(
  engine: LinuxEngine,
  role: string,
  args: readonly string[],
  input: string,
  extra: readonly string[] = [],
  timeout = engine.plan.limits.prepareTimeoutMs,
  withSnapshots = true,
): string {
  const id = engine.create(role, [
    '--interactive',
    '--network',
    'none',
    ...sandbox(engine.plan),
    ...(withSnapshots ? snapshots(engine.plan) : []),
    ...extra,
    '--workdir',
    '/workspace',
    '--entrypoint',
    '/usr/local/bin/node',
    engine.plan.backend.runtime.id,
    ...args,
  ]);
  verifyContainer(engine, id, 'none');
  const output = engine.call(['start', '--attach', '--interactive', id], input, timeout);
  const state = object(engine.inspect(id)['State']);
  if (state['Running'] !== false || state['ExitCode'] !== 0) return fail('HELPER_FAILED');
  engine.ledger.push({
    operation: 'helper-result',
    role,
    id,
    inputSha256: hash(input),
    outputSha256: hash(output),
  });
  engine.remove(id);
  return output;
}
function verifySnapshots(engine: LinuxEngine, role: string): void {
  for (const kind of ['candidate', 'dependencies', 'helpers'] as const) {
    const root =
      kind === 'candidate'
        ? '/workspace'
        : kind === 'dependencies'
          ? '/workspace/node_modules'
          : '/opt/devai';
    const input = JSON.stringify([[root, engine.plan.snapshots[kind].manifestSha256]]);
    const output = helper(
      engine,
      role + '-' + kind,
      ['-e', SNAPSHOT_VERIFY],
      input,
      mount(engine.plan.snapshots[kind].volume, root),
      engine.plan.limits.prepareTimeoutMs,
      false,
    );
    engine.ledger.push({ operation: 'snapshot-verification', kind, facts: JSON.parse(output) });
  }
}

function verifyHelperAssets(engine: LinuxEngine, role: string): void {
  const expected = Object.entries(HOST_ASSET_FILES).map(([key, file]) => ({
    file,
    sha256: engine.plan.hostAssets[key as NativeLinuxHostAssetKey].sha256,
  }));
  const source = String.raw`const fs=require('node:fs'),c=require('node:crypto');const expected=JSON.parse(fs.readFileSync(0,'utf8'));for(const item of expected){const path='/opt/devai/'+item.file,s=fs.lstatSync(path);if(!s.isFile()||s.nlink!==1||fs.realpathSync(path)!==path||c.createHash('sha256').update(fs.readFileSync(path)).digest('hex')!==item.sha256)throw Error('INSTALLED_HELPER_BYTES_CHANGED')}console.log(JSON.stringify(expected));`;
  const output = helper(
    engine,
    role,
    ['-e', source],
    JSON.stringify(expected),
    mount(engine.plan.snapshots.helpers.volume, '/opt/devai'),
    engine.plan.limits.prepareTimeoutMs,
    false,
  );
  engine.ledger.push({ operation: 'installed-helper-bytes-verified', assets: JSON.parse(output) });
}
function validateDerived(
  value: unknown,
  plan: NativeLinuxTaskSupervisorPlan,
  record: NativeLinuxBackendRecord,
): NativeLinuxDerivedTask {
  if (
    !closed(value, [
      'schemaVersion',
      'nonce',
      'kind',
      'inputSha256',
      'plan',
      'task',
      'environment',
      'command',
      'preload',
      'runtimeRoot',
      'outputRoot',
      'selectionDigest',
      'git',
      'node',
      'packageDir',
      'tracked',
      'excludedPrefixes',
      'capabilities',
      'prerequisiteDigests',
      'digest',
    ])
  )
    return fail('DERIVE_ENVELOPE_INVALID');
  const derived = value as NativeLinuxDerivedTask;
  const { digest, ...body } = derived;
  if (
    !closed(derived.preload, ['path', 'sha256']) ||
    !boundPath('/workspace', derived.preload.path) ||
    !hex(derived.preload.sha256) ||
    derived.runtimeRoot !== `/workspace/.devai/state/native-config-traces/${plan.nonce}/runtime` ||
    (derived.outputRoot !== null &&
      derived.outputRoot !== derived.runtimeRoot + '/playwright-results')
  )
    return fail('DERIVE_RUNTIME_PROJECTION_INVALID');
  if (
    derived.schemaVersion !== '1.0.0' ||
    derived.nonce !== plan.nonce ||
    derived.kind !== 'linux-task-plan' ||
    derived.inputSha256 !== plan.portableInput.sha256 ||
    !hex(digest) ||
    hash(canonical(body)) !== digest ||
    !hex(derived.selectionDigest) ||
    !closed(derived.command, ['executable', 'argv', 'cwd']) ||
    !closed(derived.command.executable, ['path', 'sha256']) ||
    derived.command.executable.path !== record.node.path ||
    derived.command.executable.sha256 !== record.node.sha256 ||
    !Array.isArray(derived.command.argv) ||
    derived.command.argv.length === 0 ||
    derived.command.argv.length > 4096 ||
    derived.command.argv.some((word) => typeof word !== 'string' || word.includes('\0')) ||
    !boundPath('/workspace', derived.command.cwd) ||
    !closed(derived.node, ['path', 'sha256', 'version']) ||
    derived.node.path !== record.node.path ||
    derived.node.sha256 !== record.node.sha256 ||
    derived.node.version.replace(/^v/u, '') !== record.node.version ||
    !closed(derived.git, ['path', 'sha256']) ||
    derived.git.path !== record.git.path ||
    derived.git.sha256 !== record.git.sha256 ||
    !boundPath('/workspace', derived.packageDir) ||
    !Array.isArray(derived.tracked) ||
    !Array.isArray(derived.excludedPrefixes) ||
    !Array.isArray(derived.capabilities)
  )
    return fail('DERIVE_BINDING_INVALID');
  const actualPlan = object(derived.plan),
    repository = object(actualPlan['repository']),
    task = object(derived.task);
  if (
    repository['commit'] !== plan.identity.candidate ||
    repository['tree'] !== plan.identity.tree ||
    actualPlan['descriptorDigest'] !== plan.identity.taskPolicySha256 ||
    task['nodeId'] !== plan.identity.taskId ||
    derived.inputSha256 !== plan.identity.inputSha256
  )
    return fail('DERIVED_TASK_MISMATCH');
  const request = object(object(task['outputContract'])['resultPopulation']);
  const profile = object(request['serviceProfile']);
  if (
    profile['profile'] !== plan.identity.profile ||
    profile['backendId'] !== plan.backend.recordId ||
    object(task['outputContract'])['population'] !== plan.identity.population
  )
    return fail('DERIVED_SERVICE_PROFILE_CHANGED');
  if (
    (object(profile['redis'] ?? {})['processControl'] === 'pause-resume-v1') !==
    (plan.services.redisProcessControl !== null)
  )
    return fail('DERIVED_REDIS_CONTROL_CHANGED');
  for (const key of ['postgres', 'redis', 'localstack'] as const) {
    const selected = plan.services.images[key];
    const declared = profile[key];
    if (
      selected !== undefined &&
      (typeof declared !== 'object' ||
        declared === null ||
        typeof object(declared)['image'] !== 'string' ||
        String(object(declared)['image']).split('@')[1] !== selected.reference.split('@')[1])
    )
      return fail('DERIVED_SERVICE_IMAGE_CHANGED');
  }
  for (const [key, value] of Object.entries(object(derived.environment)))
    if (
      !/^[A-Z][A-Z0-9_]*$/u.test(key) ||
      typeof value !== 'string' ||
      value.includes('\0') ||
      /^(?:DOCKER_|TESTCONTAINERS_|PG|STYNX_TEST_PG_|DEVAI_NATIVE_|NODE_OPTIONS$|NODE_PATH$|LD_|DYLD_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/u.test(
        key,
      )
    )
      return fail('DERIVED_ENVIRONMENT_UNSAFE');
  return structuredClone(derived);
}
interface ControlRelay {
  readonly id: string;
  readonly namespace: string;
  readonly socket: NativeServiceControlContext['socket'];
  readonly exchanges: Document[];
  readonly failure: () => string | undefined;
  readonly close: () => Promise<Document>;
}
const delay = (milliseconds: number): Promise<void> =>
  new Promise((accept) => setTimeout(accept, milliseconds));
function bounded<T>(promise: Promise<T>, milliseconds: number, reason: string): Promise<T> {
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(`NATIVE_LINUX_${reason}`)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        accept(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
async function startControl(
  engine: LinuxEngine,
  control: OwnedVolume,
  runtime: OwnedVolume,
  trace: OwnedVolume,
  record: NativeLinuxBackendRecord,
): Promise<ControlRelay> {
  const plan = engine.plan,
    id = engine.create('control', [
      '--interactive',
      '--network',
      'none',
      ...sandbox(plan),
      ...mount(plan.snapshots.helpers.volume, '/opt/devai'),
      ...mount(control.name, '/runtime/control', false),
      ...mount(runtime.name, '/runtime/fixtures', false),
      ...mount(trace.name, '/runtime/trace-output', false),
      '--entrypoint',
      record.node.path,
      plan.backend.runtime.id,
      '/opt/devai/native-service-supervisor.js',
      '--linux-control-host',
    ]);
  verifyContainer(engine, id, 'none');
  const child = spawn(
    plan.docker.executable,
    ['--host', `unix://${plan.docker.socket.realpath}`, 'start', '--attach', '--interactive', id],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } },
  );
  let buffer = '',
    errorBytes = 0,
    failed: string | undefined,
    queue = Promise.resolve(),
    closedFrame: Document | undefined,
    readyAccept: (value: Document) => void = () => {},
    readyReject: (cause: unknown) => void = () => {};
  const exchanges: Document[] = [];
  const handles = new Map<
    string,
    {
      id: string;
      port: number;
      kind: NativeServiceFixtureKind;
      transitions: number;
      paused: boolean;
      pausedAt?: number;
      birth?: { startedAt: string; restartCount: number; pid: number; image: string };
      watchdog?: ReturnType<typeof setTimeout>;
    }
  >();
  let serviceSerial = 0;
  const startsPerKind = new Map<NativeServiceFixtureKind, number>();
  const requestIds = new Set<string>();
  const ready = new Promise<Document>((accept, reject) => {
    readyAccept = accept;
    readyReject = reject;
  });
  void ready.catch(() => {});
  const physicalDeadline = Date.now() + plan.limits.prepareTimeoutMs;
  while (true) {
    try {
      if (object(engine.inspect(id)['State'])['Running'] === true) break;
    } catch (cause) {
      engine.ledger.push({ operation: 'control-start-inspection-retry', error: String(cause) });
    }
    if (Date.now() > physicalDeadline) {
      child.kill('SIGKILL');
      return fail('CONTROL_START_TIMEOUT');
    }
    await delay(50);
  }
  const facts = JSON.parse(
    engine.call([
      'exec',
      id,
      record.node.path,
      '/opt/devai/native-service-supervisor.js',
      '--linux-inspect',
    ]),
  ) as NativeLinuxIsolationFacts;
  assertNativeLinuxIsolation(facts, {
    namespace: facts.namespace,
    nodeSha256: record.node.sha256,
    architecture: plan.backend.runtime.architecture === 'amd64' ? 'x64' : 'arm64',
  });
  engine.ledger.push({ operation: 'control-isolation', id, facts });
  const namespace = facts.namespace;
  const write = (value: unknown): void => {
    if (!child.stdin.writable) return fail('CONTROL_CHANNEL_CLOSED');
    child.stdin.write(JSON.stringify(value) + '\n');
  };
  const startService = async (kind: NativeServiceFixtureKind): Promise<Document> => {
    if ([...handles.values()].some((owned) => owned.paused))
      return fail('START_WHILE_REDIS_PAUSED');
    const kindStarts = (startsPerKind.get(kind) ?? 0) + 1;
    if (
      kindStarts > (plan.services.limits.perKind[kind]?.maxInstances ?? 0) ||
      handles.size >= plan.services.limits.maxConcurrent
    )
      return fail('SERVICE_BUDGET_EXCEEDED');
    startsPerKind.set(kind, kindStarts);
    const serial = serviceSerial++,
      port = 20000 + serial,
      handle = randomBytes(32).toString('hex');
    if (
      serial >= plan.services.limits.maxInstances ||
      port > 65535 ||
      [...handles.values()].some((item) => item.port === port)
    )
      return fail('SERVICE_BUDGET_EXCEEDED');
    const base = [
      '--network',
      `container:${id}`,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--cpus',
      '0.5',
      '--pids-limit',
      '128',
      '--memory',
      '536870912',
      '--memory-swap',
      '536870912',
    ];
    let service: string;
    let credentials: Document | undefined;
    if (kind === 'postgres') {
      const image = plan.services.images.postgres;
      if (!image) return fail('PG_IMAGE_MISSING');
      const password = randomBytes(32).toString('hex');
      credentials = { username: 'devai_fixture', password, database: 'postgres' };
      service = engine.create(`postgres-${serial}`, [
        ...base,
        '--user',
        '70:70',
        '--tmpfs',
        '/var/lib/postgresql/data:rw,nosuid,nodev,noexec,uid=70,gid=70,mode=0700,size=268435456',
        '--tmpfs',
        '/var/run/postgresql:rw,nosuid,nodev,noexec,uid=70,gid=70,mode=0775,size=16777216',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,noexec,uid=70,gid=70,mode=1777,size=16777216',
        '--env',
        'POSTGRES_USER=devai_fixture',
        '--env',
        `POSTGRES_PASSWORD=${password}`,
        image.id,
        'postgres',
        '-p',
        String(port),
        '-c',
        'listen_addresses=127.0.0.1',
      ]);
    } else if (kind === 'redis') {
      const image = plan.services.images.redis;
      if (!image) return fail('REDIS_IMAGE_MISSING');
      service = engine.create(`redis-${serial}`, [
        ...base,
        '--user',
        '1000:1000',
        '--tmpfs',
        '/data:rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=0700,size=16777216',
        image.id,
        'redis-server',
        '--port',
        String(port),
        '--bind',
        '127.0.0.1',
        '--save',
        '',
        '--appendonly',
        'no',
      ]);
    } else {
      const image = plan.services.images.localstack;
      if (!image) return fail('LOCALSTACK_IMAGE_MISSING');
      credentials = { accessKeyId: 'test', secretAccessKey: 'test', region: 'us-east-1' };
      service = engine.create(`localstack-${serial}`, [
        ...base,
        '--user',
        '1000:1000',
        '--tmpfs',
        '/var/lib/localstack:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=268435456',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,uid=1000,gid=1000,mode=1777,size=134217728',
        '--tmpfs',
        '/var/run:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=16777216',
        '--env',
        'HOME=/var/lib/localstack',
        '--env',
        'XDG_CACHE_HOME=/var/lib/localstack/.cache',
        '--env',
        `SERVICES=${kind === 'localstack-s3' ? 's3' : 's3,kms'}`,
        '--env',
        `GATEWAY_LISTEN=127.0.0.1:${port}`,
        '--env',
        `LOCALSTACK_HOST=localhost:${port}`,
        '--env',
        'PERSISTENCE=0',
        '--env',
        'SKIP_SSL_CERT_DOWNLOAD=1',
        '--env',
        'LS_LOG=error',
        '--env',
        'S3_SKIP_SIGNATURE_VALIDATION=0',
        image.id,
      ]);
    }
    // Ownership is retained before starting; partial startup is always removed by the host.
    handles.set(handle, { id: service, port, kind, transitions: 0, paused: false });
    engine.call(['start', service]);
    const deadline =
      Date.now() + Math.min(plan.services.limits.requestTimeoutMs, plan.limits.prepareTimeoutMs);
    for (;;) {
      try {
        if (kind === 'postgres')
          engine.call(
            [
              'exec',
              service,
              'pg_isready',
              '-h',
              '127.0.0.1',
              '-p',
              String(port),
              '-U',
              'devai_fixture',
              '-d',
              'postgres',
            ],
            undefined,
            3000,
          );
        else if (kind === 'redis') {
          if (
            engine.call(
              ['exec', service, 'redis-cli', '-h', '127.0.0.1', '-p', String(port), 'ping'],
              undefined,
              3000,
            ) !== 'PONG'
          )
            return fail('REDIS_NOT_READY');
        } else {
          const health = object(
              JSON.parse(
                engine.call(
                  [
                    'exec',
                    service,
                    'python',
                    '-c',
                    `import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:${port}/_localstack/health',timeout=2).read().decode())`,
                  ],
                  undefined,
                  4000,
                ),
              ),
            ),
            services = object(health['services']);
          if (
            !['available', 'running'].includes(String(services['s3'])) ||
            (kind === 'localstack-s3-kms' &&
              !['available', 'running'].includes(String(services['kms'])))
          )
            return fail('LOCALSTACK_NOT_READY');
        }
        break;
      } catch (cause) {
        if (Date.now() > deadline || object(engine.inspect(service)['State'])['Running'] !== true) {
          try {
            engine.ledger.push({
              operation: 'service-start-failure',
              id: service,
              kind,
              logs: engine.call(['logs', service]),
            });
          } catch (logFailure) {
            engine.ledger.push({
              operation: 'service-start-logs-unavailable',
              id: service,
              error: String(logFailure),
            });
          }
          engine.remove(service);
          handles.delete(handle);
          throw cause;
        }
        await delay(100);
      }
    }
    const actual = engine.inspect(service),
      host = object(actual['HostConfig']);
    if (
      host['NetworkMode'] !== `container:${id}` ||
      host['ReadonlyRootfs'] !== true ||
      host['Privileged'] !== false ||
      Object.keys(object(host['PortBindings'] ?? {})).length !== 0 ||
      !Array.isArray(host['CapDrop']) ||
      host['CapDrop'].join(',').toUpperCase() !== 'ALL' ||
      engine.call(['exec', service, '/bin/readlink', '/proc/self/ns/net']) !== namespace
    )
      return fail('SERVICE_ISOLATION_CHANGED');
    const retained = handles.get(handle),
      birthState = object(actual['State']);
    if (
      !retained ||
      birthState['Running'] !== true ||
      birthState['Paused'] !== false ||
      !integer(birthState['Pid'], 1, 2147483647) ||
      typeof birthState['StartedAt'] !== 'string' ||
      actual['RestartCount'] !== 0 ||
      typeof actual['Image'] !== 'string'
    )
      return fail('SERVICE_BIRTH_UNPROVEN');
    retained.birth = {
      startedAt: birthState['StartedAt'],
      restartCount: 0,
      pid: Number(birthState['Pid']),
      image: actual['Image'],
    };
    engine.ledger.push({
      operation: 'owned-service-ready',
      id: service,
      kind,
      handle,
      port,
      namespace,
      inspection: actual,
    });
    return {
      operation: 'start',
      kind,
      handle,
      host: '127.0.0.1',
      port,
      ...(credentials ? { credentials } : {}),
    };
  };
  const redisProcessControl = (handle: string, target: boolean, cleanup = false): void => {
    const selected = plan.services.redisProcessControl,
      owned = handles.get(handle);
    if (!selected || !owned || owned.kind !== 'redis') return fail('REDIS_CONTROL_UNSELECTED');
    const resource = engine.containers.find((item) => item.id === owned.id);
    if (!resource || !resource.role.startsWith('redis-')) return fail('REDIS_HANDLE_UNOWNED');
    const before = engine.inspect(owned.id),
      state = object(before['State']),
      birth = owned.birth;
    if (!birth) return fail('REDIS_BIRTH_UNBOUND');
    engine.owned(before, resource.role);
    engine.verifyMountsAndSecurity(before, resource);
    if (
      before['Id'] !== owned.id ||
      before['Image'] !== plan.services.images.redis?.id ||
      before['Image'] !== birth.image ||
      before['RestartCount'] !== birth.restartCount ||
      state['Pid'] !== birth.pid ||
      state['StartedAt'] !== birth.startedAt ||
      state['Running'] !== true ||
      typeof state['Paused'] !== 'boolean' ||
      object(before['HostConfig'])['NetworkMode'] !== `container:${id}`
    )
      return fail('REDIS_CONTROL_IDENTITY_CHANGED');
    const changes = state['Paused'] !== target;
    if (!cleanup && changes && owned.transitions >= selected.maxTransitionsPerInstance)
      return fail('REDIS_TRANSITION_BUDGET_EXCEEDED');
    if (changes && target) owned.pausedAt = performance.now();
    if (changes)
      engine.call(
        [target ? 'pause' : 'unpause', owned.id],
        undefined,
        Math.min(plan.services.limits.requestTimeoutMs, 10000),
      );
    const after = engine.inspect(owned.id),
      afterState = object(after['State']);
    engine.owned(after, resource.role);
    engine.verifyMountsAndSecurity(after, resource);
    if (
      after['Id'] !== before['Id'] ||
      after['Image'] !== before['Image'] ||
      after['RestartCount'] !== before['RestartCount'] ||
      afterState['Running'] !== true ||
      afterState['Paused'] !== target ||
      afterState['Pid'] !== state['Pid'] ||
      afterState['StartedAt'] !== birth.startedAt ||
      after['RestartCount'] !== birth.restartCount ||
      object(after['HostConfig'])['NetworkMode'] !== `container:${id}`
    )
      return fail('REDIS_CONTROL_TRANSITION_UNPROVEN');
    if (changes) owned.transitions += 1;
    owned.paused = target;
    const pausedElapsedMs = owned.pausedAt === undefined ? 0 : performance.now() - owned.pausedAt;
    const deadlineExceeded = pausedElapsedMs > selected.maxPausedMs;
    if (deadlineExceeded) {
      failed = 'NATIVE_LINUX_REDIS_PAUSE_DEADLINE_EXCEEDED';
      engine.ledger.push({
        operation: 'redis-pause-deadline-exceeded',
        handle,
        id: owned.id,
        target,
        pausedElapsedMs,
        maxPausedMs: selected.maxPausedMs,
        before,
        after,
      });
      if (target) redisProcessControl(handle, false, true);
      if (!target) delete owned.pausedAt;
      if (!cleanup) return fail('REDIS_PAUSE_DEADLINE_EXCEEDED');
    }
    if (!target) delete owned.pausedAt;
    if (owned.watchdog !== undefined && (!target || changes)) {
      clearTimeout(owned.watchdog);
      delete owned.watchdog;
    }
    if (target && changes)
      owned.watchdog = setTimeout(() => {
        failed = 'NATIVE_LINUX_REDIS_PAUSE_WATCHDOG';
        engine.ledger.push({ operation: 'redis-pause-watchdog', handle, id: owned.id });
        queue = queue
          .then(() => {
            redisProcessControl(handle, false, true);
          })
          .catch((cause) => {
            failed = String(cause);
          });
      }, selected.maxPausedMs);
    engine.ledger.push({
      operation: target ? 'redis-pause' : 'redis-resume',
      handle,
      id: owned.id,
      namespace,
      cleanup,
      idempotent: !changes,
      pausedElapsedMs,
      transitions: owned.transitions,
      before,
      after,
    });
  };
  const frame = async (value: unknown): Promise<void> => {
    const row = object(value);
    if (row['schemaVersion'] !== '1.0.0' || row['nonce'] !== plan.nonce)
      return fail('CONTROL_FRAME_INVALID');
    if (row['frame'] === 'ready') {
      if (
        !closed(row, ['schemaVersion', 'nonce', 'frame', 'namespace', 'socket']) ||
        row['namespace'] !== namespace ||
        !closed(row['socket'], ['path', 'dev', 'ino']) ||
        object(row['socket'])['path'] !== '/runtime/control/control.sock'
      )
        return fail('CONTROL_READY_INVALID');
      readyAccept(row);
      return;
    }
    if (row['frame'] === 'closed') {
      closedFrame = row;
      return;
    }
    const origin = row['origin'];
    if (origin !== 'native' && origin !== 'cleanup') return fail('CONTROL_ORIGIN_INVALID');
    if (!hex(row['id']) || row['frame'] !== 'request') return fail('CONTROL_REQUEST_INVALID');
    const { frame: _frame, id: relayId, origin: _origin, ...request } = row;
    if (
      !closed(
        request,
        request['operation'] === 'start'
          ? ['schemaVersion', 'nonce', 'scope', 'requestId', 'operation', 'kind']
          : ['schemaVersion', 'nonce', 'scope', 'requestId', 'operation', 'handle'],
      ) ||
      typeof request['scope'] !== 'string' ||
      !/^(?:main|[a-f0-9]{32})$/u.test(request['scope']) ||
      typeof request['requestId'] !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(request['requestId']) ||
      requestIds.has(request['requestId'])
    )
      return fail('CONTROL_REQUEST_REPLAY');
    requestIds.add(request['requestId']);
    const common = {
      schemaVersion: '1.0.0',
      nonce: plan.nonce,
      scope: request['scope'],
      requestId: request['requestId'],
    };
    let response: Document;
    try {
      if (
        request['operation'] === 'start' &&
        origin === 'native' &&
        plan.services.kinds.includes(request['kind'] as NativeServiceFixtureKind)
      )
        response = {
          ...common,
          ...(await startService(request['kind'] as NativeServiceFixtureKind)),
        };
      else if (
        request['operation'] === 'stop' &&
        typeof request['handle'] === 'string' &&
        handles.has(request['handle'])
      ) {
        const owned = handles.get(request['handle']);
        if (!owned) return fail('HANDLE_UNKNOWN');
        if (owned.kind === 'redis' && owned.paused)
          redisProcessControl(request['handle'], false, true);
        if (owned.watchdog !== undefined) clearTimeout(owned.watchdog);
        engine.remove(owned.id);
        handles.delete(request['handle']);
        response = { ...common, operation: 'stop', handle: request['handle'], stopped: true };
      } else if (
        (request['operation'] === 'redis-pause' || request['operation'] === 'redis-resume') &&
        typeof request['handle'] === 'string'
      ) {
        redisProcessControl(
          request['handle'],
          request['operation'] === 'redis-pause',
          origin === 'cleanup',
        );
        response = {
          ...common,
          operation: request['operation'],
          handle: request['handle'],
          paused: request['operation'] === 'redis-pause',
        };
      } else return fail('CONTROL_OPERATION_INVALID');
    } catch (cause) {
      failed = String(cause);
      response = {
        ...common,
        error:
          request['operation'] === 'start'
            ? 'START_FAILED'
            : request['operation'] === 'stop'
              ? 'STOP_FAILED'
              : 'PROCESS_CONTROL_FAILED',
      };
    }
    exchanges.push({
      origin,
      relayId,
      request: structuredClone(request),
      requestSha256: hash(canonical(request)),
      response: structuredClone(response),
      responseSha256: hash(canonical(response)),
    });
    engine.ledger.push({
      operation: 'service-exchange',
      origin,
      relayId,
      scope: request['scope'],
      requestId: request['requestId'],
      requestSha256: hash(canonical(request)),
      responseSha256: hash(canonical(response)),
    });
    write({ schemaVersion: '1.0.0', nonce: plan.nonce, frame: 'response', id: relayId, response });
  };
  child.stdout.on('data', (bytes: Buffer) => {
    buffer += bytes.toString('utf8');
    if (Buffer.byteLength(buffer) > 128 * 1024) {
      failed = 'NATIVE_LINUX_CONTROL_BUFFER_LIMIT';
      child.stdin.destroy();
      return;
    }
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      queue = queue
        .then(() => frame(JSON.parse(line)))
        .catch((cause) => {
          failed = String(cause);
          readyReject(cause);
          child.stdin.destroy();
        });
    }
  });
  child.stderr.on('data', (bytes: Buffer) => {
    errorBytes += bytes.length;
    if (errorBytes > plan.limits.maxOutputBytes) {
      failed = 'NATIVE_LINUX_CONTROL_STDERR_LIMIT';
      child.stdin.destroy();
    }
  });
  child.once('error', (cause) => {
    failed = String(cause);
    readyReject(cause);
  });
  child.once('close', (code) => {
    if (!closedFrame) {
      failed = `NATIVE_LINUX_CONTROL_EXIT_${String(code)}`;
      readyReject(new Error(failed));
    }
  });
  write({
    schemaVersion: '1.0.0',
    nonce: plan.nonce,
    namespace,
    path: '/runtime/control/control.sock',
    kinds: plan.services.kinds,
    redisProcessControl: plan.services.redisProcessControl,
    limits: plan.services.limits,
  });
  const readyFrame = await bounded(ready, plan.limits.prepareTimeoutMs, 'CONTROL_READY_TIMEOUT');
  return {
    id,
    namespace,
    socket: readyFrame['socket'] as NativeServiceControlContext['socket'],
    exchanges,
    failure: () => failed,
    close: async () => {
      for (const owned of handles.values())
        if (owned.watchdog !== undefined) clearTimeout(owned.watchdog);
      if (child.exitCode !== null) return fail('CONTROL_ALREADY_EXITED');
      write({ schemaVersion: '1.0.0', nonce: plan.nonce, frame: 'close' });
      const exit = await bounded(
        new Promise<number | null>((accept) => child.once('close', accept)),
        plan.limits.cleanupTimeoutMs,
        'CONTROL_CLOSE_TIMEOUT',
      );
      await queue;
      child.stdin.end();
      if (exit !== 0 || closedFrame?.['complete'] !== true || handles.size !== 0 || failed)
        return fail('CONTROL_CLEANUP_FAILED');
      return closedFrame;
    },
  };
}

async function executeLinuxTask(
  plan: NativeLinuxTaskSupervisorPlan,
  record: NativeLinuxBackendRecord,
): Promise<NativeLinuxTaskSupervisorReceipt> {
  const planSha256 = hash(canonical(plan)),
    lifecycle: Document[] = [],
    failures: string[] = [],
    engine = new LinuxEngine(plan, lifecycle, planSha256);
  let relay: ControlRelay | undefined,
    derived: NativeLinuxDerivedTask | null = null,
    replay: Document | null = null,
    childReceipt: NativeLinuxTaskSupervisorReceipt['child'] = null,
    cleanupComplete = false;
  try {
    verifyHost(plan, engine);
    bindRecord(plan, record);
    verifySnapshots(engine, 'snapshot-before');
    verifyHelperAssets(engine, 'helper-assets-before');
    derived = validateDerived(
      JSON.parse(
        helper(
          engine,
          'derive',
          ['/opt/devai/native-linux-plan.js', '--derive'],
          plan.portableInput.json,
        ),
      ),
      plan,
      record,
    );
    const runtime = engine.volume('fixtures', 32 * 1024 * 1024),
      workRuntime = engine.volume('runtime', 512 * 1024 * 1024),
      control = engine.volume('control', 1024 * 1024),
      trace = engine.volume('trace', plan.limits.maxOutputBytes),
      artifacts = engine.volume('artifacts', 512 * 1024 * 1024);
    relay = await startControl(engine, control, runtime, trace, record);
    const adapter = {
      nonce: plan.nonce,
      repository: '/workspace',
      candidate: plan.identity.candidate,
      packageDir: derived.packageDir,
      git: derived.git,
      tracked: derived.tracked,
      excludedPrefixes: derived.excludedPrefixes,
    };
    const service: NativeServiceControlContext = {
      schemaVersion: '1.0.0',
      nonce: plan.nonce,
      repository: '/workspace',
      candidate: plan.identity.candidate,
      taskId: plan.identity.taskId,
      population: plan.identity.population,
      backend: {
        kind: 'owned-linux-native-v1',
        recordId: plan.backend.recordId,
        recordSha256: plan.backend.recordSha256,
        imageId: plan.backend.runtime.id,
        namespace: relay.namespace,
      },
      socket: relay.socket,
      kinds: plan.services.kinds,
      redisProcessControl: plan.services.redisProcessControl,
      limits: plan.services.limits,
    };
    const adapterBytes = JSON.stringify(adapter),
      serviceBytes = JSON.stringify(service);
    const initialize = String.raw`const fs=require('node:fs');const documents=JSON.parse(fs.readFileSync(0,'utf8'));for(const[name,bytes]of Object.entries(documents)){if(!['adapter-context.json','service-context.json'].includes(name))throw Error('CONTEXT_NAME');const p='/runtime/fixtures/'+name;fs.writeFileSync(p,bytes,{mode:0o400,flag:'wx'});fs.chmodSync(p,0o400);const s=fs.lstatSync(p);if(!s.isFile()||s.nlink!==1||(s.mode&511)!==256)throw Error('CONTEXT_IDENTITY')}fs.writeFileSync('/runtime/fixtures/trace.jsonl','',{mode:0o600,flag:'wx'});fs.writeFileSync('/runtime/trace-output/trace.jsonl','',{mode:0o600,flag:'wx'});`;
    engine.call(
      ['exec', '--interactive', relay.id, record.node.path, '-e', initialize],
      JSON.stringify({
        'adapter-context.json': adapterBytes,
        'service-context.json': serviceBytes,
      }),
    );
    if (trace.mountpoint === undefined) return fail('TRACE_MOUNTPOINT_MISSING');
    const environment = {
      CI: '1',
      NO_COLOR: '1',
      ...derived.environment,
      HOME: '/tmp',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      TMPDIR: derived.runtimeRoot,
      NODE_V8_COVERAGE: '',
      NODE_OPTIONS: `--import=${pathToFileURL(derived.preload.path).href}`,
      DEVAI_NATIVE_COLLECTION_NONCE: plan.nonce,
      DEVAI_NATIVE_ADAPTER_CONTEXT_SHA256: hash(adapterBytes),
      DEVAI_NATIVE_SERVICE_CONTEXT_SHA256: hash(serviceBytes),
      DEVAI_NATIVE_INPUT_TRACE: '/evidence/trace.jsonl',
      DEVAI_NATIVE_INPUT_SCOPE: 'main',
      DEVAI_NATIVE_RUNTIME_ROOT: derived.runtimeRoot,
      ...(derived.outputRoot === null ? {} : { DEVAI_NATIVE_RESULT_ROOT: derived.outputRoot }),
      PWTEST_CACHE_DIR: derived.runtimeRoot + '/playwright',
      DEVAI_NATIVE_RUNNER:
        object(object(derived.task.outputContract)['resultPopulation'])['format'] ===
        'playwright-json'
          ? 'playwright-v1'
          : 'vitest-v1',
    };
    const ownedMounts = [
      ...mount(workRuntime.name, derived.runtimeRoot, false),
      ...mount(control.name, '/runtime/control'),
      ...mount(runtime.name, '/runtime/fixtures'),
      ...mount(runtime.name, '/evidence'),
      ...mount(artifacts.name, '/artifacts', false),
      '--mount',
      `type=bind,source=${trace.mountpoint}/trace.jsonl,target=/evidence/trace.jsonl`,
    ];
    const taskId = engine.create('task', [
      '--network',
      `container:${relay.id}`,
      ...sandbox(plan),
      ...snapshots(plan),
      ...ownedMounts,
      ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      '--workdir',
      derived.command.cwd,
      '--entrypoint',
      derived.command.executable.path,
      plan.backend.runtime.id,
      ...derived.command.argv,
    ]);
    verifyContainer(engine, taskId, `container:${relay.id}`);
    lifecycle.push({
      operation: 'effective-task',
      id: taskId,
      command: derived.command,
      environment,
      serviceContextSha256: hash(serviceBytes),
      adapterContextSha256: hash(adapterBytes),
      mounts: ownedMounts,
    });
    const running = spawn(
      plan.docker.executable,
      ['--host', `unix://${plan.docker.socket.realpath}`, 'start', '--attach', taskId],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } },
    );
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      taskFailure: string | undefined;
    const exit = new Promise<number | null>((accept, reject) => {
      running.once('close', accept);
      running.once('error', reject);
    });
    const collect = (channel: 'stdout' | 'stderr', bytes: Buffer): void => {
      if (stdout.length + stderr.length + bytes.length > plan.limits.maxOutputBytes) {
        taskFailure = 'NATIVE_LINUX_TASK_OUTPUT_LIMIT';
        try {
          engine.call(['stop', '--time', '0', taskId], undefined, plan.limits.cleanupTimeoutMs);
        } catch (stopFailure) {
          failures.push(String(stopFailure));
        }
        return;
      }
      if (channel === 'stdout') {
        stdout = Buffer.concat([stdout, bytes]);
        process.stdout.write(bytes);
      } else {
        stderr = Buffer.concat([stderr, bytes]);
        process.stderr.write(bytes);
      }
    };
    running.stdout.on('data', (bytes: Buffer) => collect('stdout', bytes));
    running.stderr.on('data', (bytes: Buffer) => collect('stderr', bytes));
    let checking = false;
    let forestComplete = false;
    const observe = (): void => {
      if (checking) return;
      checking = true;
      try {
        const actual = engine.inspect(taskId),
          state = object(actual['State']);
        if (state['Running'] !== true) return;
        verifyContainer(engine, taskId, `container:${relay?.id}`);
        const facts = JSON.parse(
          engine.call([
            'exec',
            taskId,
            record.node.path,
            '/opt/devai/native-service-supervisor.js',
            '--linux-inspect',
          ]),
        ) as NativeLinuxIsolationFacts;
        if (!relay) return fail('CONTROL_MISSING');
        assertNativeLinuxIsolation(facts, {
          namespace: relay.namespace,
          nodeSha256: record.node.sha256,
          architecture: plan.backend.runtime.architecture === 'amd64' ? 'x64' : 'arm64',
        });
        const forest = JSON.parse(
          engine.call(['exec', taskId, record.node.path, '-e', PROCESS_FOREST]),
        );
        lifecycle.push({
          operation: 'task-process-observation',
          id: taskId,
          facts,
          forest,
          creationWitness: false,
        });
        forestComplete = true;
        if (relay.failure()) taskFailure = relay.failure();
      } catch (cause) {
        taskFailure = String(cause);
      } finally {
        checking = false;
      }
    };
    const observer = setInterval(observe, 500);
    let status: number | null = null;
    try {
      status = await bounded(exit, plan.limits.taskTimeoutMs, 'TASK_TIMEOUT');
    } catch (cause) {
      taskFailure = String(cause);
      try {
        engine.call(['stop', '--time', '0', taskId], undefined, plan.limits.cleanupTimeoutMs);
      } catch (stopFailure) {
        failures.push(String(stopFailure));
      }
      try {
        await bounded(exit, plan.limits.cleanupTimeoutMs, 'TASK_STOP_TIMEOUT');
      } catch {
        running.kill('SIGKILL');
      }
    } finally {
      clearInterval(observer);
    }
    const terminal = engine.inspect(taskId),
      state = object(terminal['State']);
    if (state['Running'] !== false || state['Pid'] !== 0 || terminal['RestartCount'] !== 0)
      return fail('TASK_NOT_TERMINAL');
    if (!forestComplete)
      lifecycle.push({
        operation: 'task-process-observation',
        id: taskId,
        creationWitness: false,
        observation: 'task-ended-before-first-observation',
      });
    childReceipt = {
      status,
      stdoutSha256: hash(stdout),
      stderrSha256: hash(stderr),
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
    };
    lifecycle.push({ operation: 'task-terminal', id: taskId, state, child: childReceipt });
    if (taskFailure) failures.push(taskFailure);
    if (status !== 0) failures.push(`NATIVE_LINUX_TASK_EXIT_${String(status)}`);
    const controlClosed = await relay.close();
    lifecycle.push({ operation: 'control-terminal', frame: controlClosed });
    // The independent Linux helper reads the stopped task's exact readonly snapshots and owned evidence.
    const traceSha256 = helper(
      engine,
      'trace-hash',
      [
        '-e',
        "const fs=require('node:fs'),c=require('node:crypto');const p='/evidence/trace.jsonl',s=fs.lstatSync(p);if(!s.isFile()||s.nlink!==1||s.size>67108864)throw Error('TRACE_INVALID');console.log(c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))",
      ],
      '',
      mount(trace.name, '/evidence'),
      plan.limits.prepareTimeoutMs,
      false,
    );
    if (!hex(traceSha256)) return fail('TRACE_HASH_INVALID');
    const replayInput = JSON.stringify({
      schemaVersion: '1.0.0',
      nonce: plan.nonce,
      portableInput: plan.portableInput,
      derived,
      service: {
        context: service,
        exchanges: relay.exchanges.map((exchange) => ({
          request: exchange['request'],
          response: exchange['response'],
        })),
      },
      execution: {
        status: childReceipt.status,
        signal: null,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        stdoutSha256: childReceipt.stdoutSha256,
        stderrSha256: childReceipt.stderrSha256,
      },
      trace: { path: '/evidence/trace.jsonl', sha256: traceSha256 },
    });
    replay = object(
      JSON.parse(
        helper(
          engine,
          'replay',
          ['/opt/devai/native-linux-replay.js', '--replay'],
          replayInput,
          [
            ...mount(workRuntime.name, derived.runtimeRoot),
            ...mount(runtime.name, '/runtime/fixtures'),
            ...mount(runtime.name, '/evidence'),
            ...mount(artifacts.name, '/artifacts'),
            '--mount',
            `type=bind,source=${trace.mountpoint}/trace.jsonl,target=/evidence/trace.jsonl,readonly`,
          ],
          plan.limits.replayTimeoutMs,
        ),
      ),
    );
    if (
      !closed(replay, [
        'schemaVersion',
        'nonce',
        'kind',
        'reconstructedPlanDigest',
        'result',
        'findings',
        'traceSha256',
        'stdoutSha256',
        'stderrSha256',
        'complete',
        'replaySha256',
      ])
    )
      return fail('REPLAY_ENVELOPE_INVALID');
    const { replaySha256, ...replayBody } = replay;
    if (
      replay['schemaVersion'] !== '1.0.0' ||
      replay['kind'] !== 'linux-task-replay' ||
      replay['nonce'] !== plan.nonce ||
      replay['reconstructedPlanDigest'] !== derived.digest ||
      !hex(replaySha256) ||
      hash(canonical(replayBody)) !== replaySha256 ||
      replay['traceSha256'] !== traceSha256 ||
      replay['stdoutSha256'] !== childReceipt.stdoutSha256 ||
      replay['stderrSha256'] !== childReceipt.stderrSha256 ||
      replay['complete'] !== true ||
      object(replay['result'])['status'] !== 'pass' ||
      !Array.isArray(replay['findings']) ||
      replay['findings'].length !== 0
    )
      return fail('REPLAY_BINDING_INVALID');
    verifySnapshots(engine, 'snapshot-terminal');
    verifyHelperAssets(engine, 'helper-assets-terminal');
    verifyHost(plan, engine);
    // Polling cannot establish the full process-creation/termination and descriptor witness.
    failures.push('NATIVE_LINUX_PROCESS_CREATION_WITNESS_UNIMPLEMENTED');
  } catch (cause) {
    failures.push(String(cause));
  } finally {
    cleanupComplete = engine.cleanup(failures);
  }
  return {
    schemaVersion: '1.0.0',
    kind: 'diagnostic-zero-origin',
    standing: false,
    nonce: plan.nonce,
    planSha256,
    backendRecordSha256: plan.backend.recordSha256,
    complete: false,
    child: childReceipt,
    derived,
    replay,
    lifecycle,
    failures,
    cleanupComplete,
  };
}

/** Diagnostic-only private host harness. This does not establish origin or approve a backend record. */
export async function diagnoseNativeLinuxTask(
  value: unknown,
  record: NativeLinuxBackendRecord,
): Promise<NativeLinuxTaskSupervisorReceipt> {
  const plan = validatePlan(value);
  bindRecord(plan, record);
  return executeLinuxTask(plan, structuredClone(record));
}
/** The admitted process path must load a fixed package-owned catalogue independently of its caller. */
export async function superviseNativeLinuxTask(
  value: unknown,
): Promise<NativeLinuxTaskSupervisorReceipt> {
  const plan = validatePlan(value);
  bindRecord(plan, activeRecord(plan));
  // Full creation-event and descriptor isolation proof is a required implementation prerequisite.
  return fail('PROCESS_CREATION_WITNESS_UNIMPLEMENTED');
}
async function runPrivateSupervisor(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== '--execute') return fail('MODE_UNSUPPORTED');
  let bytes = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    bytes = Buffer.concat([bytes, Buffer.from(chunk as Uint8Array)]);
    if (bytes.length > 4 * 1024 * 1024) return fail('PLAN_BUFFER_LIMIT');
  }
  let receipt: NativeLinuxTaskSupervisorReceipt;
  try {
    receipt = await superviseNativeLinuxTask(JSON.parse(bytes.toString('utf8')));
  } catch (cause) {
    let plan: Document = {};
    try {
      plan = object(JSON.parse(bytes.toString('utf8')));
    } catch {
      plan = {};
    }
    const backend =
      plan['backend'] !== null &&
      typeof plan['backend'] === 'object' &&
      !Array.isArray(plan['backend'])
        ? object(plan['backend'])
        : {};
    receipt = {
      schemaVersion: '1.0.0',
      kind: 'native-linux-task-receipt',
      standing: false,
      nonce: typeof plan['nonce'] === 'string' ? plan['nonce'] : '',
      planSha256: Object.keys(plan).length === 0 ? hash(bytes) : hash(canonical(plan)),
      backendRecordSha256:
        typeof backend['recordSha256'] === 'string' ? String(backend['recordSha256']) : '',
      complete: false,
      child: null,
      derived: null,
      replay: null,
      lifecycle: [],
      failures: [String(cause)],
      cleanupComplete: true,
    };
  }
  writeFileSync(3, JSON.stringify(receipt) + '\n');
  process.exitCode = receipt.complete ? 0 : 1;
}
if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  void runPrivateSupervisor().catch((cause) => {
    process.stderr.write(String(cause) + '\n');
    process.exitCode = 1;
  });
