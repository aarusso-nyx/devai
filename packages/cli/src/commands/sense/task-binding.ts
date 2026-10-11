import { existsSync, mkdirSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { appendVerbEvidence, loadChain, verifyLoadedChain } from '#runtime-core';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync, type AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { getValidator } from '@devai-nyx/schemas';
import {
  buildSensorReading,
  isExecutableTestFile,
  readCandidateFile,
  type SensorKind,
  type SensorReading,
  type SensorStatus,
} from '@devai-nyx/sensors';
import { resolvedSensorMember } from '../../authority/sensor-member.js';
import {
  buildTaskPlan,
  readTaskDescriptor,
  taskDescriptorDigest,
} from '../../services/check-runner/policy.js';
import { resolveRunnerToolchain } from '../../services/check-runner/runner-plan.js';
import { resolveTaskEnvironment } from '../../services/check-runner/runner-inputs.js';
import { outputDigests } from '../../services/check-runner/runner-execution.js';
import { trackedPaths } from '../../services/check-runner/policy-git.js';
import { CheckCache } from '../../services/check-runner/cache.js';
import { sha256Hex, canonicalize } from '../../services/check-runner/canonical.js';
import type {
  CandidateReceipt,
  PlannedTask,
  TaskDescriptor,
  TaskPlan,
} from '../../services/check-runner/types.js';
import { inspectNativeTestResults, type NativeTestResultContract } from './native-test-results.js';
import { pathToFileURL } from 'node:url';
import {
  inspectNativeConfigurationSelection,
  inspectNativeInputProvenance,
} from './native-input-provenance.js';
import { nativeInputPreloadPath, nativeRunnerSelection } from './native-runner-selection.js';
import { resolveSensorReadingInstance } from './reading-instance.js';
import type { SensorInputs } from './shared.js';

const TASK_KINDS = new Set([
  'type_check',
  'unit_test',
  'integration_test',
  'e2e_test',
  'perf_test',
  'build',
  'migration_check',
]);
const MAX_OUTPUT = 64 * 1024 * 1024;
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');

export interface SensorTaskBinding {
  readonly root: string;
  readonly kind: SensorKind;
  readonly inputs: SensorInputs;
  readonly population: string;
  readonly plan: TaskPlan;
  readonly task: PlannedTask;
  readonly runner: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly declarationDigest: string | null;
  readonly prerequisiteDigests: Readonly<Record<string, string>>;
  readonly nativeSelectionDigest?: string;
}

const nativeFilesystemContext = new AsyncLocalStorage<{
  root: string;
  kind: 'origin' | 'trace';
  nonce?: string;
}>();

/** The broker admits native receipt/trace effects only while the trusted operation is active. */
export function assertNativeSensorFilesystemTarget(
  root: string,
  path: string,
  operation: string,
  renameFrom?: unknown,
): void {
  if (!path.startsWith('record/proofs') && !path.startsWith('.devai/state/native-config-traces'))
    return;
  const context = nativeFilesystemContext.getStore();
  if (context?.root !== realpathSync(root) || !['create', 'update', 'rename'].includes(operation))
    throw new Error('AUTHORITY_NATIVE_SENSOR_PATH_REFUSED');
  const temporary = new RegExp(`^record/proofs/chain\\.json\\.tmp\\.${process.pid}\\.[0-9]+$`, 'u');
  if (operation === 'rename') {
    if (
      context.kind === 'origin' &&
      path === 'record/proofs/chain.json' &&
      typeof renameFrom === 'string' &&
      temporary.test(renameFrom)
    )
      return;
    throw new Error('AUTHORITY_NATIVE_SENSOR_PATH_REFUSED');
  }
  if (
    context.kind === 'origin' &&
    (path === 'record/proofs' || path === 'record/proofs/chain.json' || temporary.test(path))
  )
    return;
  if (
    context.kind === 'trace' &&
    (path === '.devai/state/native-config-traces' ||
      path === `.devai/state/native-config-traces/${context.nonce}` ||
      path === `.devai/state/native-config-traces/${context.nonce}/runtime`)
  )
    return;
  throw new Error('AUTHORITY_NATIVE_SENSOR_PATH_REFUSED');
}

const trustedBindings = new WeakSet<SensorTaskBinding>();
const processBindings = new WeakMap<object, SensorTaskBinding>();
const nativeMeasurements = new WeakMap<
  SensorReading,
  { readonly binding: SensorTaskBinding; readonly body: string }
>();

function measuredBody(reading: SensorReading): string {
  const { id: _id, supersedes: _supersedes, ...facts } = reading;
  return canonicalize(facts);
}

function containedFile(root: string, path: string): string {
  const lexical = resolve(root, path);
  const actual = realpathSync(lexical);
  const rel = relative(root, actual);
  if (
    isAbsolute(path) ||
    !lstatSync(lexical).isFile() ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error('SENSE_TASK_PATH_ESCAPES_ROOT');
  }
  return actual;
}

function closure(descriptor: TaskDescriptor, roots: readonly string[]) {
  const ids = new Set(roots);
  const pending = [...ids];
  for (let index = 0; index < pending.length; index += 1) {
    const task = descriptor.tasks.find((entry) => entry.nodeId === pending[index]);
    if (task === undefined) throw new Error('SENSE_TASK_UNKNOWN');
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) {
        ids.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return descriptor.tasks.filter((task) => ids.has(task.nodeId));
}

function taskPlan(root: string, descriptor: TaskDescriptor, roots: readonly string[]) {
  const nodes = closure(descriptor, roots);
  const toolchain = resolveRunnerToolchain(
    root,
    nodes.flatMap((task) => task.toolchainKeys),
  );
  const environment = resolveTaskEnvironment(
    root,
    nodes.flatMap((task) => task.allowlistedEnv),
  );
  const plan = buildTaskPlan({
    repoRoot: root,
    descriptor,
    target: 'local',
    selectedTaskNodes: roots,
    toolchain,
    environment,
    cacheState: () => ({ cacheState: 'execute', reason: 'sensor-measurement-always-executes' }),
  });
  return { plan, environment };
}

/** Require content-addressed prior completion with current candidate, policy and environment. */
function prerequisites(
  root: string,
  descriptor: TaskDescriptor,
  plan: TaskPlan,
  task: PlannedTask,
): Readonly<Record<string, string>> {
  if (task.dependencies.length === 0) return Object.freeze({});
  if (!plan.clean) throw new Error('SENSE_TASK_PREREQUISITE_CANDIDATE_DIRTY');
  const receiptDir = join(root, '.devai/state/check-cache/v1/receipts');
  if (!existsSync(receiptDir)) throw new Error('SENSE_TASK_PREREQUISITE_REQUIRED');
  const cache = new CheckCache(root, join(root, '.devai/state/check-cache/v1'));
  const required = closure(descriptor, task.dependencies).map((node) => node.nodeId);
  for (const file of readdirSync(receiptDir).sort()) {
    if (!/^[0-9a-f]{64}\.json$/u.test(file)) continue;
    try {
      const receipt = JSON.parse(
        readFileSync(containedFile(root, `.devai/state/check-cache/v1/receipts/${file}`), 'utf8'),
      ) as CandidateReceipt;
      if (
        sha256Hex(receipt) !== file.slice(0, -5) ||
        receipt.schemaVersion !== '1.1.0' ||
        canonicalize(receipt.repository) !== canonicalize(plan.repository) ||
        !Array.isArray(receipt.tasks) ||
        !['affected', 'rc'].includes(receipt.profile)
      )
        continue;
      const ids = receipt.tasks.map((node) => node.nodeId);
      if (new Set(ids).size !== ids.length || !required.every((id) => ids.includes(id))) continue;
      const current = taskPlan(root, descriptor, ids).plan;
      if (
        current.taskPolicyDigest !== receipt.taskPolicyDigest ||
        current.tasks.length !== ids.length
      )
        continue;
      const digests: Record<string, string> = {};
      let valid = true;
      for (const node of current.tasks) {
        const completed = receipt.tasks.find((entry) => entry.nodeId === node.nodeId);
        const dependencyDigests: Record<string, string> = {};
        for (const id of node.dependencies) {
          const digest = digests[id];
          if (digest === undefined) throw new Error('SENSE_TASK_PREREQUISITE_REQUIRED');
          dependencyDigests[id] = digest;
        }
        const inspection = cache.inspect(node, dependencyDigests);
        if (
          completed?.taskKey !== node.taskKey ||
          inspection.cacheState !== 'reusable' ||
          inspection.cachedResultDigest !== completed.resultDigest ||
          inspection.result?.inputDigest !== node.inputDigest
        ) {
          valid = false;
          break;
        }
        digests[node.nodeId] = completed.resultDigest;
      }
      if (valid)
        return Object.freeze(Object.fromEntries(required.map((id) => [id, digests[id] as string])));
    } catch {
      // Malformed or stale receipts never provide prerequisite standing.
    }
  }
  throw new Error('SENSE_TASK_PREREQUISITE_REQUIRED');
}

export function resolveSensorTaskBinding(
  repoRoot: string,
  kind: string,
  inputs: SensorInputs | undefined,
): SensorTaskBinding | undefined {
  if (!TASK_KINDS.has(kind) && inputs?.['taskId'] === undefined) return undefined;
  if (inputs?.['taskId'] === undefined && inputs?.['population'] === undefined) return undefined;
  if (
    !TASK_KINDS.has(kind) ||
    typeof inputs?.['taskId'] !== 'string' ||
    typeof inputs['population'] !== 'string'
  ) {
    throw new Error('SENSE_TASK_REFERENCE_INVALID');
  }
  const validateInput = getValidator('sensor-inputs.schema.json');
  if (!validateInput({ schemaVersion: '1.0.0', inputs: { [kind]: inputs } }))
    throw new Error('SENSE_TASK_REFERENCE_INVALID');
  const root = realpathSync(repoRoot);
  const descriptorPath = containedFile(root, 'test-tasks.json');
  const raw: unknown = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  if (!getValidator('test-task-descriptor.schema.json')(raw))
    throw new Error('SENSE_TASK_DESCRIPTOR_INVALID');
  const descriptor = readTaskDescriptor(descriptorPath);
  const node = descriptor.tasks.find((entry) => entry.nodeId === inputs['taskId']);
  if (node === undefined) throw new Error('SENSE_TASK_UNKNOWN');
  if (!node.sensorKinds?.includes(kind)) throw new Error('SENSE_TASK_KIND_MISMATCH');
  if (node.outputContract['population'] !== inputs['population'])
    throw new Error('SENSE_TASK_POPULATION_MISMATCH');
  if (
    node.runner === 'preflight-v1' ||
    node.argv.length === 0 ||
    node.probes !== undefined ||
    node.outputContract['generated_namespaces'] !== undefined ||
    (node.outputContract['kind'] !== undefined &&
      !['command-result', 'vitest', 'workspace-build'].includes(
        String(node.outputContract['kind']),
      ))
  ) {
    throw new Error('SENSE_TASK_CONTRACT_UNSUPPORTED');
  }
  const { plan, environment } = taskPlan(root, descriptor, [node.nodeId]);
  const task = plan.tasks.find((entry) => entry.nodeId === node.nodeId);
  if (task === undefined || taskDescriptorDigest(descriptor) !== plan.descriptorDigest)
    throw new Error('SENSE_TASK_POLICY_MISMATCH');
  const resultPopulation = node.outputContract['resultPopulation'];
  let nativeSelectionDigest: string | undefined;
  if (resultPopulation !== undefined) {
    if (!plan.clean) throw new Error('SENSE_NATIVE_CANDIDATE_DIRTY');
    if (
      node.outputContract['kind'] !== 'command-result' ||
      !getValidator('test-result-population.schema.json')(resultPopulation)
    )
      throw new Error('SENSE_TASK_RESULT_POPULATION_INVALID');
    const declared = resultPopulation as NativeTestResultContract;
    const actual = task.inputPaths.filter(isExecutableTestFile).sort();
    if (
      actual.length === 0 ||
      canonicalize([...declared.executableFiles].sort()) !==
        canonicalize(declared.executableFiles) ||
      !declared.executableFiles.every((path) => actual.includes(path))
    )
      throw new Error('SENSE_TASK_EXECUTABLE_CENSUS_MISMATCH');
    const tracked = new Set(trackedPaths(root));
    for (const path of actual) {
      if (!tracked.has(path)) throw new Error('SENSE_TASK_EXECUTABLE_NOT_TRACKED');
      readCandidateFile(root, path);
    }
    nativeSelectionDigest = nativeRunnerSelection(root, task, declared);
    if (
      node.allowlistedEnv.some((key) =>
        /^(?:TMPDIR$|PWTEST_CACHE_DIR$|PW_TEST_SOURCE_TRANSFORM|NODE_OPTIONS|NODE_PATH|TSX_|VITEST_|PLAYWRIGHT_JSON_OUTPUT|NODE_V8_COVERAGE|SWC_BINARY_PATH|NAPI_RS_FORCE_WASI|DEVAI_NATIVE_)/u.test(
          key,
        ),
      )
    )
      throw new Error('SENSE_NATIVE_ENVIRONMENT_SELECTION_UNSUPPORTED');
  }
  const cwd = realpathSync(resolve(root, task.cwd));
  const rel = relative(root, cwd);
  if (isAbsolute(task.cwd) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('SENSE_TASK_PATH_ESCAPES_ROOT');
  const declaration = '.devai/config/sensor-inputs.json';
  const binding: SensorTaskBinding = Object.freeze({
    root,
    kind: kind as SensorKind,
    inputs: Object.freeze({ ...inputs }),
    population: inputs['population'],
    plan,
    task,
    runner: node.runner,
    environment: Object.freeze(
      Object.fromEntries(
        node.allowlistedEnv
          .filter((key) => environment[key] !== undefined)
          .map((key) => [key, environment[key] as string]),
      ),
    ),
    declarationDigest: existsSync(join(root, declaration))
      ? sha256Hex(readFileSync(containedFile(root, declaration)))
      : null,
    prerequisiteDigests: prerequisites(root, descriptor, plan, task),
    ...(nativeSelectionDigest === undefined ? {} : { nativeSelectionDigest }),
  });
  trustedBindings.add(binding);
  return binding;
}

function bindingIdentity(binding: SensorTaskBinding): string {
  return canonicalize({
    plan: binding.plan,
    environment: binding.environment,
    declaration: binding.declarationDigest,
    prerequisites: binding.prerequisiteDigests,
    ...(binding.nativeSelectionDigest === undefined
      ? {}
      : { nativeSelectionDigest: binding.nativeSelectionDigest }),
  });
}

function assertFresh(binding: SensorTaskBinding): void {
  if (!trustedBindings.has(binding)) throw new Error('SENSE_TASK_BINDING_UNTRUSTED');
  const current = resolveSensorTaskBinding(binding.root, binding.kind, binding.inputs);
  if (current === undefined || bindingIdentity(current) !== bindingIdentity(binding))
    throw new Error('SENSE_TASK_BINDING_CHANGED');
}

/** Only internally minted process options can admit the exact reviewed task. */
export function matchDeclaredSensorTaskProcess(
  root: string,
  request: AuthorityHostEffectRequest,
): SensorTaskBinding | undefined {
  const options = request.arguments[2];
  if (
    request.kind !== 'process' ||
    request.symbol !== 'spawnSync' ||
    options === null ||
    typeof options !== 'object'
  )
    return undefined;
  const binding = processBindings.get(options);
  if (binding === undefined) return undefined;
  assertFresh(binding);
  if (
    realpathSync(root) !== binding.root ||
    resolvedSensorMember() !== binding.kind ||
    request.arguments[0] !==
      (binding.nativeSelectionDigest === undefined
        ? binding.task.executable.path
        : process.execPath) ||
    canonicalize(request.arguments[1]) !==
      canonicalize(
        binding.nativeSelectionDigest === undefined
          ? binding.task.argv.slice(1)
          : [binding.task.executable.path, ...binding.task.argv.slice(1)],
      )
  )
    return undefined;
  return binding;
}

export function isBoundSensorTaskProcess(request: AuthorityHostEffectRequest): boolean {
  const options = request.arguments[2];
  return options !== null && typeof options === 'object' && processBindings.has(options);
}

function parsedCounts(
  stdout: string,
  stderr: string,
): { passed: number; failed: number } | undefined {
  const summaries: { passed: number; failed: number }[] = [];
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const plain = line.replace(ANSI_SEQUENCE, '').trim();
    // Every reported Tests summary must be complete. A malformed second summary
    // cannot hide behind an earlier valid line from another workspace.
    if (!/^Tests(?:\s|:)/u.test(plain)) continue;
    const vitest = /^Tests\s+(.+)\s+\((\d+)\)$/u.exec(plain);
    const jest = /^Tests:\s+(.+),\s*(\d+) total$/u.exec(plain);
    const match = vitest ?? jest;
    if (match === null) return undefined;
    const parts = (match[1] as string).split(vitest === null ? /,\s*/u : /\s*\|\s*/u);
    const counts: Record<string, number> = {};
    for (const part of parts) {
      const entry = /^(\d+) (passed|failed|skipped|todo|pending)$/u.exec(part);
      if (entry === null || counts[entry[2] as string] !== undefined) return undefined;
      const value = Number(entry[1]);
      if (!Number.isSafeInteger(value)) return undefined;
      counts[entry[2] as string] = value;
    }
    const total = Number(match[2]);
    if (!Number.isSafeInteger(total) || Object.values(counts).reduce((a, b) => a + b, 0) !== total)
      return undefined;
    summaries.push({ passed: counts['passed'] ?? 0, failed: counts['failed'] ?? 0 });
  }
  if (summaries.length > 0) {
    const counts = summaries.reduce(
      (sum, next) => ({ passed: sum.passed + next.passed, failed: sum.failed + next.failed }),
      { passed: 0, failed: 0 },
    );
    if (
      Number.isSafeInteger(counts.passed) &&
      Number.isSafeInteger(counts.failed) &&
      counts.passed + counts.failed > 0
    )
      return counts;
    return undefined;
  }
  try {
    const result = JSON.parse(stdout) as Record<string, unknown>;
    const passed = result['numPassedTests'];
    const failed = result['numFailedTests'];
    const total = result['numTotalTests'];
    const pending = result['numPendingTests'] ?? 0;
    const todo = result['numTodoTests'] ?? 0;
    if (
      [passed, failed, total, pending, todo].every(
        (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
      ) &&
      typeof passed === 'number' &&
      typeof failed === 'number' &&
      typeof pending === 'number' &&
      typeof todo === 'number' &&
      passed + failed > 0 &&
      passed + failed + pending + todo === total &&
      result['success'] === (failed === 0)
    )
      return { passed, failed };
  } catch {
    /* No complete validated result. */
  }
  return undefined;
}

export function executeSensorTask(binding: SensorTaskBinding): SensorReading {
  assertFresh(binding);
  if (resolvedSensorMember() !== binding.kind)
    throw new Error('SENSE_TASK_MEMBER_CONTEXT_REQUIRED');
  const collectionNonce =
    binding.nativeSelectionDigest === undefined ? undefined : randomBytes(32).toString('hex');
  const tracePath =
    collectionNonce === undefined
      ? undefined
      : join(binding.root, '.devai/state/native-config-traces', collectionNonce, 'inputs.ndjson');
  const runtimeRoot = tracePath === undefined ? undefined : join(tracePath, '..', 'runtime');
  if (tracePath !== undefined && runtimeRoot !== undefined)
    nativeFilesystemContext.run(
      { root: binding.root, kind: 'trace', nonce: collectionNonce },
      () => {
        mkdirSync(join(tracePath, '..'), { recursive: true });
        mkdirSync(runtimeRoot);
      },
    );
  const options = Object.freeze({
    cwd: realpathSync(resolve(binding.root, binding.task.cwd)),
    encoding: 'utf8' as const,
    timeout: 600_000,
    maxBuffer: MAX_OUTPUT,
    shell: false as const,
    env: Object.freeze({
      ...(binding.nativeSelectionDigest === undefined
        ? {
            ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
            ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
            ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
          }
        : {}),
      ...(collectionNonce === undefined ? {} : { NODE_V8_COVERAGE: '' }),
      CI: '1',
      NO_COLOR: '1',
      ...binding.environment,
      ...(collectionNonce === undefined
        ? {}
        : {
            DEVAI_NATIVE_COLLECTION_NONCE: collectionNonce,
            DEVAI_NATIVE_INPUT_TRACE: tracePath,
            DEVAI_NATIVE_INPUT_SCOPE: 'main',
            DEVAI_NATIVE_RUNTIME_ROOT: runtimeRoot,
            DEVAI_NATIVE_RUNNER: (
              binding.task.outputContract['resultPopulation'] as NativeTestResultContract
            ).selectionEvidence?.reporter,
            TMPDIR: runtimeRoot,
            PWTEST_CACHE_DIR: join(runtimeRoot as string, 'playwright'),
            NODE_OPTIONS: `--import=${pathToFileURL(nativeInputPreloadPath()).href}`,
          }),
    }),
  });
  processBindings.set(options, binding);
  const start = performance.now();
  const result =
    binding.nativeSelectionDigest === undefined
      ? spawnSync(binding.task.executable.path, binding.task.argv.slice(1), options)
      : spawnSync(
          process.execPath,
          [binding.task.executable.path, ...binding.task.argv.slice(1)],
          options,
        );
  const duration = Math.round(performance.now() - start);
  assertFresh(binding);
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const outputs = outputDigests(
    binding.root,
    binding.task,
    {
      status: result.status,
      signal: result.signal ?? null,
      stdout,
      stderr,
    },
    (path) => readFileSync(containedFile(binding.root, path)),
  );
  const metrics: Record<string, number | string | boolean> = {
    output_digests: canonicalize(outputs),
    task_id: binding.task.nodeId,
    population: binding.population,
    runner: binding.runner,
    task_key: binding.task.taskKey,
    input_digest: binding.task.inputDigest,
    stdout_sha256: sha256Hex(Buffer.from(stdout)),
    stderr_sha256: sha256Hex(Buffer.from(stderr)),
    descriptor_digest: binding.plan.descriptorDigest,
    task_policy_digest: binding.plan.taskPolicyDigest,
    candidate_commit: binding.plan.repository.commit,
    candidate_tree: binding.plan.repository.tree,
    prerequisite_digests: canonicalize(binding.prerequisiteDigests),
  };
  if (collectionNonce !== undefined && binding.nativeSelectionDigest !== undefined) {
    metrics['native_collection_nonce'] = collectionNonce;
    metrics['native_selection_digest'] = binding.nativeSelectionDigest;
    const rawTrace =
      tracePath !== undefined && existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : '';
    metrics['native_input_trace'] = rawTrace;
    metrics['native_input_trace_sha256'] = sha256Hex(Buffer.from(rawTrace));
  }
  let status: SensorStatus =
    result.error !== undefined || result.status === null
      ? 'error'
      : result.status === 0
        ? 'pass'
        : 'fail';
  const findings: { severity: 'info'; code: string; message: string }[] = [];
  if (
    (status === 'pass' || status === 'fail') &&
    ['unit_test', 'integration_test', 'e2e_test'].includes(binding.kind)
  ) {
    const contract = binding.task.outputContract['resultPopulation'] as
      NativeTestResultContract | undefined;
    const native =
      contract === undefined
        ? undefined
        : inspectNativeTestResults(contract, stdout, stderr, {
            repoRoot: binding.root,
            collectionNonce,
          });
    if (native !== undefined) {
      metrics['native_stdout'] = stdout;
      metrics['native_stderr'] = stderr;
      metrics['native_result_population'] = canonicalize(native);
      metrics['native_plan_sha256'] = native.nativePlanSha256;
      metrics['native_result_project'] = native.projectId;
      metrics['native_result_contract_sha256'] = sha256Hex(contract);
      for (const code of native.findings)
        findings.push({
          severity: 'info',
          code,
          message:
            'Native test result population could not discharge the declared complete execution obligations.',
        });
      if (status === 'pass') status = native.status;
    }
    const counts =
      native === undefined
        ? parsedCounts(stdout, stderr)
        : native.status === 'unknown'
          ? undefined
          : {
              passed: native.executedTestIds.length - native.failedTestIds.length,
              failed: native.failedTestIds.length,
            };
    if (counts === undefined && status === 'pass') status = 'unknown';
    else if (counts !== undefined) {
      metrics['tests_passed'] = counts.passed;
      metrics['tests_failed'] = counts.failed;
      if (counts.failed > 0) status = 'fail';
    }
  }
  if (status === 'pass' && binding.kind === 'perf_test') {
    const keys = ['p50_ms', 'p95_ms', 'throughput_rps'];
    const lines = stdout.trim().split('\n');
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed === null || typeof parsed !== 'object') continue;
        const present = keys.filter((key) => Object.hasOwn(parsed, key));
        if (present.length === 0) continue;
        if (
          present.some(
            (key) =>
              typeof parsed[key] !== 'number' ||
              !Number.isFinite(parsed[key]) ||
              Number(parsed[key]) < 0,
          )
        )
          break;
        for (const key of present) metrics[key] = parsed[key] as number;
        break;
      } catch {
        if (keys.some((key) => line.includes(`"${key}"`))) break;
        /* Log noise is not a metric. */
      }
    }
    if (!['p50_ms', 'p95_ms', 'throughput_rps'].some((key) => metrics[key] !== undefined))
      status = 'unknown';
  }
  if (collectionNonce !== undefined) {
    const failures = [
      ...inspectNativeConfigurationSelection(binding.root, stdout),
      ...inspectNativeInputProvenance(
        binding.root,
        collectionNonce,
        String(metrics['native_input_trace'] ?? ''),
        stdout,
        binding.task,
      ),
    ];
    if (failures.length > 0) {
      delete metrics['tests_passed'];
      delete metrics['tests_failed'];
      if (status === 'pass' || status === 'fail') status = 'unknown';
      for (const code of failures)
        findings.push({
          severity: 'info',
          code,
          message:
            'Native configuration/collection input provenance is incomplete, unsupported, or changed.',
        });
    }
  }
  if (status === 'unknown')
    findings.push({
      severity: 'info',
      code: 'SENSE_TASK_OUTPUT_UNMEASURED',
      message: 'The task emitted no validated measurements for this sensor population.',
    });
  const reading = buildSensorReading({
    sensorName: `task:${binding.task.nodeId}`,
    sensorKind: binding.kind,
    command: [...binding.task.argv],
    status,
    deterministic: ['type_check', 'build', 'unit_test'].includes(binding.kind),
    exit_code: result.status ?? -1,
    duration_ms: duration,
    out_head: stdout,
    err_head: stderr,
    killed: result.signal !== null && result.signal !== undefined,
    metrics,
    findings,
  });
  if (binding.nativeSelectionDigest !== undefined)
    nativeMeasurements.set(reading, { binding, body: measuredBody(reading) });
  return reading;
}

/** Mint execution origin only for an internally measured native result and its exact instance. */
export function attestNativeTaskExecution(
  repoRoot: string,
  measured: SensorReading,
  instance: SensorReading,
): void {
  const origin = nativeMeasurements.get(measured);
  if (origin === undefined) {
    if (measured.metrics?.['native_collection_nonce'] !== undefined)
      throw new Error('SENSE_NATIVE_EXECUTION_ORIGIN_UNTRUSTED');
    return;
  }
  const { binding, body } = origin;
  if (realpathSync(repoRoot) !== binding.root)
    throw new Error('SENSE_NATIVE_EXECUTION_ROOT_MISMATCH');
  assertFresh(binding);
  if (measuredBody(measured) !== body || measuredBody(instance) !== body)
    throw new Error('SENSE_NATIVE_EXECUTION_INSTANCE_CHANGED');
  if (canonicalize(resolveSensorReadingInstance(repoRoot, measured)) !== canonicalize(instance))
    throw new Error('SENSE_NATIVE_EXECUTION_INSTANCE_UNRESOLVED');
  const path = `.devai/state/sensor-readings/${instance.sensor.kind}/${instance.id}.json`;
  const digest = sha256Hex(Buffer.from(`${JSON.stringify(instance, null, 2)}\n`));
  const chainPath = 'record/proofs/chain.json';
  if (existsSync(join(binding.root, chainPath))) {
    const chain = loadChain(join(binding.root, chainPath));
    if (!verifyLoadedChain(chain).valid) throw new Error('SENSE_NATIVE_EXECUTION_CHAIN_INVALID');
    if (
      chain.records.some(
        (receipt) =>
          receipt.action === 'sense.task.execute' &&
          receipt.status === 'completed' &&
          receipt.context.git.head_sha === binding.plan.repository.commit &&
          receipt.artifacts.some(
            (artifact) => artifact.path === path && artifact.sha256 === digest,
          ),
      )
    ) {
      nativeMeasurements.delete(measured);
      return;
    }
  }
  const appended = nativeFilesystemContext.run({ root: binding.root, kind: 'origin' }, () =>
    appendVerbEvidence({
      repoRoot: binding.root,
      chainPath,
      action: 'sense.task.execute',
      status: 'completed',
      artifacts: [{ path, sha256: digest, kind: 'sensor-reading' }],
      notes: [
        'Registered native task execution origin; custody requires a later sense.readings.record receipt.',
      ],
    }),
  );
  if (!appended.ok)
    throw new Error(`SENSE_NATIVE_EXECUTION_ORIGIN_APPEND_FAILED:${appended.error ?? ''}`);
  nativeMeasurements.delete(measured);
}
