import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, accessSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getValidator } from '@devai-nyx/schemas';
import { isExecutableTestFile, readCandidateFile } from '@devai-nyx/sensors';
import { readTaskDescriptor } from '../../services/check-runner/policy.js';
import { canonicalize, sha256Hex } from '../../services/check-runner/canonical.js';
import {
  RELEASE_INPUT_PROJECTION,
  trackedPaths,
  isHarnessMutatedPath,
} from '../../services/check-runner/policy-git.js';
import { planSensorTasks, sensorTaskPrerequisites } from './sensor-task-plan.js';
import { nativeCoverageGitIdentity } from './native-coverage-host.js';
import { nativeExecutionCommand, nativeRunnerSelection } from './native-runner-selection.js';
import type { NativeTestResultContract } from './native-test-results.js';
import type { PlannedTask, TaskPlan } from '../../services/check-runner/types.js';

export interface NativeLinuxPlanInput {
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
  readonly runtimeRoot: string;
  readonly outputRoot: string | null;
  readonly selectionDigest: string;
  readonly preload: { readonly path: string; readonly sha256: string };
  readonly git: { readonly path: string; readonly sha256: string };
  readonly node: { readonly path: string; readonly sha256: string; readonly version: string };
  readonly packageDir: string;
  readonly tracked: readonly string[];
  readonly excludedPrefixes: readonly string[];
  readonly capabilities: readonly string[];
  readonly prerequisiteDigests: Readonly<Record<string, string>>;
  readonly digest: string;
}
const refuse = (code: string): never => {
  throw new Error(`NATIVE_LINUX_PLAN_${code}`);
};
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  canonicalize(Object.keys(value).sort()) === canonicalize([...keys].sort());
const hex = (value: unknown, length = 64): value is string =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(value);
const fileHash = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/** Private helper admission. No adopter JSON supplies executable paths, argv or environment. */
export function parseNativeLinuxPlanInput(raw: string): NativeLinuxPlanInput {
  if (Buffer.byteLength(raw) > 65536) return refuse('INPUT_TOO_LARGE');
  const input: unknown = JSON.parse(raw);
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
    input['schemaVersion'] !== '1.0.0' ||
    !hex(input['nonce']) ||
    input['repository'] !== '/workspace' ||
    typeof input['kind'] !== 'string' ||
    !['unit_test', 'integration_test', 'e2e_test'].includes(input['kind']) ||
    !hex(input['candidate'], 40) ||
    !hex(input['tree'], 40) ||
    !hex(input['backendRecordSha256']) ||
    !closed(input['inputs'], ['taskId', 'population']) ||
    typeof input['inputs']['taskId'] !== 'string' ||
    input['inputs']['taskId'].length === 0 ||
    typeof input['inputs']['population'] !== 'string' ||
    input['inputs']['population'].length === 0 ||
    !closed(input['snapshotManifestSha256'], ['candidate', 'dependencies', 'helpers']) ||
    !Object.values(input['snapshotManifestSha256']).every((value) => hex(value))
  )
    return refuse('INPUT_INVALID');
  return input as unknown as NativeLinuxPlanInput;
}
function contained(root: string, path: string): string {
  const lexical = resolve(root, path),
    actual = realpathSync(lexical),
    rel = relative(root, actual);
  if (
    isAbsolute(path) ||
    !lstatSync(lexical).isFile() ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  )
    return refuse('INPUT_ESCAPES');
  return actual;
}
/** The immutable base's tools run only here, before any adopter workload exists. */
function linuxToolchain(
  root: string,
  required: readonly string[],
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const key of [...new Set(required)].sort()) {
    if (key === 'node') values[key] = process.version;
    else if (['pnpm', 'git', 'postgres'].includes(key)) {
      const executable =
        key === 'pnpm' ? '/usr/local/bin/pnpm' : key === 'git' ? '/usr/bin/git' : '/usr/bin/psql';
      const actual = realpathSync(executable);
      if (!lstatSync(actual).isFile()) return refuse('TOOLCHAIN_UNAVAILABLE');
      accessSync(actual, constants.X_OK);
      values[key] = execFileSync(actual, ['--version'], {
        cwd: '/',
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' },
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 65536,
        shell: false,
      }).trim();
    } else if (['eslint', 'vitest', 'typescript'].includes(key)) {
      const manifest = JSON.parse(
        readFileSync(
          createRequire(resolve(root, 'package.json')).resolve(`${key}/package.json`),
          'utf8',
        ),
      ) as { name?: unknown; version?: unknown };
      if (
        manifest.name !== key ||
        typeof manifest.version !== 'string' ||
        manifest.version.length === 0
      )
        return refuse('TOOLCHAIN_INVALID');
      values[key] = `${key}@${manifest.version}`;
    } else return refuse('TOOLCHAIN_UNSUPPORTED');
  }
  return Object.freeze(values);
}

/** Reconstruct only on the actual contained Linux runtime; the host never remaps a Mac plan. */
export function deriveNativeLinuxTask(raw: string): NativeLinuxDerivedTask {
  const input = parseNativeLinuxPlanInput(raw);
  if (
    process.platform !== 'linux' ||
    process.version !== 'v24.20.0' ||
    realpathSync(input.repository) !== '/workspace' ||
    process.getuid?.() !== 1000
  )
    return refuse('RUNTIME_UNSUPPORTED');
  const root = input.repository;
  for (const [kind, directory] of Object.entries({
    candidate: root,
    dependencies: '/workspace/node_modules',
    helpers: '/opt/devai',
  })) {
    const manifest = contained(directory, '.devai-native-snapshot.json');
    if (
      fileHash(manifest) !==
      input.snapshotManifestSha256[kind as keyof typeof input.snapshotManifestSha256]
    )
      return refuse('SNAPSHOT_CHANGED');
  }
  const descriptorPath = contained(root, 'test-tasks.json');
  const rawDescriptor: unknown = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  if (!getValidator('test-task-descriptor.schema.json')(rawDescriptor))
    return refuse('DESCRIPTOR_INVALID');
  const descriptor = readTaskDescriptor(descriptorPath);
  const declaration = descriptor.tasks.find((node) => node.nodeId === input.inputs.taskId);
  if (
    declaration === undefined ||
    !declaration.sensorKinds?.includes(input.kind) ||
    declaration.outputContract['population'] !== input.inputs.population ||
    declaration.runner !== 'exec-v1' ||
    declaration.probes !== undefined ||
    declaration.outputContract['generated_namespaces'] !== undefined ||
    declaration.outputContract['kind'] !== 'command-result'
  )
    return refuse('DECLARATION_INVALID');
  const contract = declaration.outputContract['resultPopulation'];
  if (
    !getValidator('test-result-population.schema.json')(contract) ||
    (contract as NativeTestResultContract).serviceProfile === undefined
  )
    return refuse('NATIVE_CONTRACT_REQUIRED');
  if (
    declaration.allowlistedEnv.some((key) =>
      /^(?:TMPDIR$|PWTEST_CACHE_DIR$|PW_TEST_SOURCE_TRANSFORM|NODE_OPTIONS|NODE_PATH|TSX_|VITEST_|PLAYWRIGHT_JSON_OUTPUT|NODE_V8_COVERAGE|SWC_BINARY_PATH|NAPI_RS_FORCE_WASI|DEVAI_NATIVE_)/u.test(
        key,
      ),
    )
  )
    return refuse('ENVIRONMENT_UNSUPPORTED');
  const reconstruct = (ids: readonly string[]) =>
    planSensorTasks(root, descriptor, ids, linuxToolchain);
  const { plan, environment } = reconstruct([declaration.nodeId]);
  const task = plan.tasks.find((node) => node.nodeId === declaration.nodeId);
  if (
    !plan.clean ||
    plan.repository.commit !== input.candidate ||
    plan.repository.tree !== input.tree ||
    task === undefined
  )
    return refuse('CANDIDATE_CHANGED');
  const resultContract = contract as NativeTestResultContract;
  const actual = task.inputPaths.filter(isExecutableTestFile).sort();
  if (
    actual.length === 0 ||
    canonicalize([...resultContract.executableFiles].sort()) !==
      canonicalize(resultContract.executableFiles) ||
    !resultContract.executableFiles.every((path) => actual.includes(path))
  )
    return refuse('EXECUTABLE_CENSUS_MISMATCH');
  const tracked = trackedPaths(root).filter((path) => !isHarnessMutatedPath(path));
  const trackedSet = new Set(tracked);
  for (const path of actual) {
    if (!trackedSet.has(path)) return refuse('EXECUTABLE_NOT_TRACKED');
    readCandidateFile(root, path);
  }
  const require = createRequire(resolve(root, task.cwd, 'package.json'));
  const preloadPath = realpathSync(
    resolve(
      dirname(require.resolve('@aarusso-nyx/devai/native-coverage-adapter')),
      'native-input-provenance.js',
    ),
  );
  for (const asset of [
    'native-test-reporter.js',
    'native-playwright-reporter.js',
    'native-input-provenance.js',
    'native-coverage-adapter.js',
    'native-coverage-kernel.js',
    'native-coverage-data.js',
    'native-service-fixtures.js',
    'native-service-fixtures-kernel.js',
    'native-platform-probes.js',
    'native-playwright-loader.js',
  ]) {
    if (
      fileHash(resolve(dirname(preloadPath), asset)) !==
      fileHash(fileURLToPath(new URL(`./${asset}`, import.meta.url)))
    )
      return refuse('PACKAGE_ASSETS_CHANGED');
  }
  const selectionDigest = nativeRunnerSelection(root, task, resultContract, preloadPath);
  const effective = nativeExecutionCommand(root, task, input.nonce);
  const packageDir = realpathSync(resolve(root, task.cwd));
  const rel = relative(root, packageDir);
  if (isAbsolute(task.cwd) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return refuse('CWD_ESCAPES');
  const command = {
    executable: { path: effective.executable, sha256: fileHash(effective.executable) },
    argv: effective.argv,
    cwd: packageDir,
  };
  const result = {
    schemaVersion: '1.0.0' as const,
    nonce: input.nonce,
    kind: 'linux-task-plan' as const,
    inputSha256: sha256Hex(Buffer.from(raw)),
    plan,
    task,
    environment: Object.freeze(
      Object.fromEntries(
        declaration.allowlistedEnv
          .filter((key) => environment[key] !== undefined)
          .map((key) => [key, environment[key] as string]),
      ),
    ),
    command,
    runtimeRoot: resolve(root, '.devai/state/native-config-traces', input.nonce, 'runtime'),
    outputRoot: effective.outputRoot,
    selectionDigest,
    preload: { path: preloadPath, sha256: fileHash(preloadPath) },
    git: nativeCoverageGitIdentity(),
    node: {
      path: realpathSync(process.execPath),
      sha256: fileHash(realpathSync(process.execPath)),
      version: process.version,
    },
    packageDir,
    tracked,
    excludedPrefixes: RELEASE_INPUT_PROJECTION.excludedPrefixes,
    capabilities: serviceCapabilities(resultContract),
    prerequisiteDigests: sensorTaskPrerequisites(root, descriptor, plan, task, reconstruct),
  };
  return Object.freeze({ ...result, digest: sha256Hex(result) });
}

function serviceCapabilities(contract: NativeTestResultContract): readonly string[] {
  const profile = contract.serviceProfile?.profile;
  const control =
    contract.serviceProfile?.redis?.processControl === 'pause-resume-v1'
      ? ['fixture:redis-process-control']
      : [];
  const base = [
    'db:write',
    'fixture:postgresql',
    'fixture:loopback-http',
    'proc:owned-native-fixture',
  ];
  if (profile === 'postgres-http-v1') return base.sort();
  if (profile === 'postgres-http-s3-v1') return [...base, 'fixture:localstack-s3'].sort();
  if (profile === 'postgres-redis-http-s3-kms-v1')
    return [
      ...base,
      ...control,
      'fixture:redis',
      'fixture:localstack-s3',
      'fixture:localstack-kms',
    ].sort();
  if (profile === 'playwright-chromium-web-v1')
    return [
      ...base,
      ...control,
      'fixture:redis',
      'fixture:localstack-s3',
      'fixture:localstack-kms',
      'fixture:chromium',
      'fixture:reference-web',
    ].sort();
  return refuse('SERVICE_PROFILE_UNSUPPORTED');
}
