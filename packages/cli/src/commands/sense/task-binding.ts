import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync, type AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { getValidator } from '@devai-nyx/schemas';
import {
  buildSensorReading,
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
import { CheckCache } from '../../services/check-runner/cache.js';
import { sha256Hex, canonicalize } from '../../services/check-runner/canonical.js';
import type {
  CandidateReceipt,
  PlannedTask,
  TaskDescriptor,
  TaskPlan,
} from '../../services/check-runner/types.js';
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
}

const trustedBindings = new WeakSet<SensorTaskBinding>();
const processBindings = new WeakMap<object, SensorTaskBinding>();

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
    request.arguments[0] !== binding.task.executable.path ||
    canonicalize(request.arguments[1]) !== canonicalize(binding.task.argv.slice(1))
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
  const options = Object.freeze({
    cwd: realpathSync(resolve(binding.root, binding.task.cwd)),
    encoding: 'utf8' as const,
    timeout: 600_000,
    maxBuffer: MAX_OUTPUT,
    shell: false as const,
    env: Object.freeze({
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      CI: '1',
      NO_COLOR: '1',
      ...binding.environment,
    }),
  });
  processBindings.set(options, binding);
  const start = performance.now();
  const result = spawnSync(binding.task.executable.path, binding.task.argv.slice(1), options);
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
    descriptor_digest: binding.plan.descriptorDigest,
    task_policy_digest: binding.plan.taskPolicyDigest,
    candidate_commit: binding.plan.repository.commit,
    candidate_tree: binding.plan.repository.tree,
    prerequisite_digests: canonicalize(binding.prerequisiteDigests),
  };
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
    const counts = parsedCounts(stdout, stderr);
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
  if (status === 'unknown')
    findings.push({
      severity: 'info',
      code: 'SENSE_TASK_OUTPUT_UNMEASURED',
      message: 'The task emitted no validated measurements for this sensor population.',
    });
  return buildSensorReading({
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
}
