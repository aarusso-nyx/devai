import { readFileSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, isAbsolute, sep } from 'node:path';
import { readTaskDescriptor } from '../services/check-runner/policy.js';
import { getValidator } from '@devai-nyx/schemas';
import type { ReleaseFailureClass } from '../services/release-preflight.js';
import { currentRepositoryState } from '../services/check-runner/policy-git.js';
import { resolveSensorTaskDeclaration } from './sense/task-binding.js';
import type { SensorInputs } from './sense/shared.js';
import type { CheckResult } from './doctor-support.js';

interface Failure {
  readonly status: 'blocked' | 'fail';
  readonly failureClass: ReleaseFailureClass;
  readonly remediation: string;
}

/** A refusal explains a failed planning prerequisite; it never downgrades a release gate. */
export function classifyExecutionReadinessFailure(code: string): Failure {
  if (/^SENSE_TASK_(?:KIND|POPULATION)_MISMATCH$/u.test(code))
    return {
      status: 'fail',
      failureClass: 'policy-invalid',
      remediation:
        'Correct the sensor annotation and exact population in the declared task binding, then replan.',
    };
  const name = code.split(':', 1)[0];
  if (name === 'SENSE_TASK_PREREQUISITE_REQUIRED')
    return {
      status: 'blocked',
      failureClass: 'sensor-stale',
      remediation:
        'Complete the declared predecessors for this exact candidate and execution recipe, then replan.',
    };
  if (
    name === 'SENSE_NATIVE_SERVICE_BACKEND_UNIMPLEMENTED' ||
    name === 'SENSE_NATIVE_SERVICE_BACKEND_UNSUPPORTED'
  )
    return {
      status: 'blocked',
      failureClass: 'unknown',
      remediation:
        'Use a DEVAI package with the approved implementation for this declared backend; retain containment and rerun adoption.',
    };
  if (
    name !== undefined &&
    new Set([
      'ENOENT',
      'ENOTDIR',
      'CHECK_RUNNER_TOOLCHAIN_MISSING',
      'CHECK_RUNNER_EXECUTABLE_MISSING',
      'SENSE_NATIVE_INPUT_PACKAGE_UNRESOLVED',
      'SENSE_NATIVE_DEPENDENCY_UNRESOLVED',
      'SENSE_NATIVE_DEPENDENCY_MANIFEST_MISSING',
      'NATIVE_INPUT_PACKAGE_MANIFEST_MISSING',
    ]).has(name)
  )
    return {
      status: 'blocked',
      failureClass: 'environment-drift',
      remediation:
        'Prepare the declared executable, installed dependencies or required local input for this exact runtime, then replan.',
    };
  if (
    name !== undefined &&
    new Set([
      'SENSE_TASK_PREREQUISITE_CANDIDATE_DIRTY',
      'SENSE_NATIVE_CANDIDATE_DIRTY',
      'SENSE_TASK_EXECUTABLE_CENSUS_MISMATCH',
      'SENSE_TASK_EXECUTABLE_NOT_TRACKED',
      'SENSE_TASK_POLICY_MISMATCH',
      'SENSE_TASK_BINDING_CHANGED',
      'EXECUTION_READINESS_CANDIDATE_CHANGED',
      'CHECK_RUNNER_EXECUTABLE_IDENTITY_MISMATCH',
    ]).has(name)
  )
    return {
      status: 'fail',
      failureClass: 'evidence-mismatch',
      remediation:
        'Reconcile the candidate and declared task identity, preserve the rejected evidence, then replan the exact candidate.',
    };
  if (
    name !== undefined &&
    new Set([
      'SENSE_INPUTS_INVALID',
      'SENSE_TASK_REFERENCE_INVALID',
      'SENSE_TASK_DESCRIPTOR_INVALID',
      'SENSE_TASK_UNKNOWN',
      'SENSE_TASK_CONTRACT_UNSUPPORTED',
      'SENSE_TASK_RESULT_POPULATION_INVALID',
      'SENSE_TASK_PATH_ESCAPES_ROOT',
      'CHECK_TASK_DESCRIPTOR_MISSING',
      'CHECK_RUNNER_DESCRIPTOR',
      'CHECK_RUNNER_TOOLCHAIN_MANIFEST_INVALID',
      'SENSE_NATIVE_ENVIRONMENT_SELECTION_UNSUPPORTED',
      'SENSE_NATIVE_CONFIG_CLOSURE_INCOMPLETE',
      'SENSE_NATIVE_CONFIG_IN_MUTATED_NAMESPACE',
      'SENSE_NATIVE_CONFIG_LOADER_REQUIRED',
      'SENSE_NATIVE_CONFIG_LOADER_UNSUPPORTED',
      'SENSE_NATIVE_CONFIG_PATH_REQUIRED',
      'SENSE_NATIVE_CONFIG_REPEATED',
      'SENSE_NATIVE_CONFIG_REQUIRED',
      'SENSE_NATIVE_EXECUTABLE_UNRECOGNIZED',
      'SENSE_NATIVE_EXPLICIT_CONFIG_REQUIRED',
      'SENSE_NATIVE_PROJECT_SELECTION_INVALID',
      'SENSE_NATIVE_REPORTER_BYTES_MISMATCH',
      'SENSE_NATIVE_REPORTER_FORMAT_MISMATCH',
      'SENSE_NATIVE_REPORTER_REQUIRED',
      'SENSE_NATIVE_REPORTER_SELECTION_INVALID',
      'SENSE_NATIVE_RUN_MODE_REQUIRED',
      'SENSE_NATIVE_RUNNER_PACKAGE_NONREGULAR',
      'SENSE_NATIVE_SELECTION_UNSUPPORTED',
      'SENSE_NATIVE_VITE_VERSION_UNSUPPORTED',
    ]).has(name)
  )
    return {
      status: 'fail',
      failureClass: 'policy-invalid',
      remediation:
        'Correct the named declaration or supported interface without widening authority, then rerun readiness.',
    };
  return {
    status: 'fail',
    failureClass: 'unknown',
    remediation:
      'Inspect the bounded refusal code and repair its cause before any long validation or publication gate.',
  };
}

function reason(error: unknown): string {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^(?:ENOENT|ENOTDIR)$/u.test(error.code)
  )
    return error.code;
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,127}/u.exec(message)?.[0] ?? 'EXECUTION_READINESS_UNEXPECTED';
}

/** Cheap read-only planning of declared adopter tasks. Passing grants no native execution standing. */
export function checkAdopterExecutionReadiness(repoRoot: string): CheckResult {
  const name = 'adopter-execution-readiness';
  const bindings: Record<string, unknown>[] = [];
  const info: Record<string, unknown> = {
    status: 'not-required',
    standing: 'diagnostic-only',
    bindings,
  };
  try {
    const root = realpathSync(repoRoot);
    const readContained = (path: string): unknown => {
      const lexical = join(root, path);
      const actual = realpathSync(lexical);
      const rel = relative(root, actual);
      if (
        !lstatSync(lexical).isFile() ||
        rel === '..' ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel)
      )
        throw new Error('SENSE_TASK_PATH_ESCAPES_ROOT');
      return JSON.parse(readFileSync(actual, 'utf8')) as unknown;
    };
    const selected: [string, SensorInputs][] = [];
    const declarationPath = '.devai/config/sensor-inputs.json';
    if (existsSync(join(root, declarationPath))) {
      const declaration = readContained(declarationPath);
      if (!getValidator('sensor-inputs.schema.json')(declaration))
        throw new Error('SENSE_INPUTS_INVALID');
      const inputs = (declaration as { inputs: Record<string, SensorInputs> }).inputs;
      selected.push(
        ...Object.entries(inputs).filter(
          ([, input]) => input['taskId'] !== undefined || input['population'] !== undefined,
        ),
      );
    }
    if (existsSync(join(root, 'test-tasks.json'))) {
      const raw = readContained('test-tasks.json');
      if (!getValidator('test-task-descriptor.schema.json')(raw))
        throw new Error('SENSE_TASK_DESCRIPTOR_INVALID');
      const descriptor = readTaskDescriptor(join(root, 'test-tasks.json'));
      for (const task of descriptor.tasks)
        for (const kind of task.sensorKinds ?? []) {
          const population = task.outputContract['population'];
          if (typeof population !== 'string') throw new Error('SENSE_TASK_REFERENCE_INVALID');
          if (
            !selected.some(
              ([key, input]) =>
                key === kind &&
                input['taskId'] === task.nodeId &&
                input['population'] === population,
            )
          )
            selected.push([kind, { taskId: task.nodeId, population }]);
        }
    }
    if (selected.length === 0) return { name, ok: true, info };
    const candidate = currentRepositoryState(root);
    info['identity'] = {
      candidate,
      runtime: {
        version: process.version,
        platform: process.platform,
        arch: process.arch,
        executableSha256: createHash('sha256')
          .update(readFileSync(realpathSync(process.execPath)))
          .digest('hex'),
      },
    };
    const validate = getValidator('sensor-inputs.schema.json');
    for (const [sensorKind, value] of selected.sort(([a], [b]) => a.localeCompare(b))) {
      const input = value;
      const row: Record<string, unknown> = {
        sensorKind,
        taskId: input['taskId'] ?? null,
        population: input['population'] ?? null,
      };
      bindings.push(row);
      try {
        if (!validate({ schemaVersion: '1.0.0', inputs: { [sensorKind]: input } }))
          throw new Error('SENSE_TASK_REFERENCE_INVALID');
        const binding = resolveSensorTaskDeclaration(root, sensorKind, input as SensorInputs);
        if (binding === undefined) throw new Error('SENSE_TASK_REFERENCE_INVALID');
        Object.assign(row, {
          status: 'pass',
          reasonCode: 'ADOPTER_TASK_PLAN_READY',
          readinessScope: 'declaration-plan',
          taskKey: binding.task.taskKey,
          ...(binding.nativeSelectionDigest === undefined
            ? {}
            : { nativeSelectionDigest: binding.nativeSelectionDigest }),
        });
      } catch (error) {
        const code = reason(error);
        Object.assign(row, { reasonCode: code, ...classifyExecutionReadinessFailure(code) });
      }
    }
    if (JSON.stringify(currentRepositoryState(root)) !== JSON.stringify(candidate))
      throw new Error('EXECUTION_READINESS_CANDIDATE_CHANGED');
    info['status'] = bindings.some((row) => row['status'] === 'fail')
      ? 'fail'
      : bindings.some((row) => row['status'] === 'blocked')
        ? 'blocked'
        : 'pass';
    return {
      name,
      ok: info['status'] === 'pass',
      info,
      ...(info['status'] === 'pass'
        ? {}
        : {
            errors: bindings
              .filter((row) => row['status'] !== 'pass')
              .map(
                (row) =>
                  `${String(row['sensorKind'])}: ${String(row['reasonCode'])}. ${String(row['remediation'])}`,
              ),
          }),
    };
  } catch (error) {
    const code = reason(error),
      failure = classifyExecutionReadinessFailure(code);
    return {
      name,
      ok: false,
      info: { ...info, ...failure, reasonCode: code },
      errors: [`${code}. ${failure.remediation}`],
    };
  }
}
