import { canonicalJson } from '@devai-nyx/utils';
import { captureProtectedMutationExecution } from './release-certification-container.js';
import {
  captureProtectedMutationProgram,
  captureProtectedMutationProgramPackage,
  type ProtectedMutationProgram,
} from './release-mutation-program.js';
import {
  normalizeReleaseMutationPackageV21,
  type ReleaseMutationDiscoveredMutantV21,
  type ReleaseMutationPackageArtifactsV21,
} from './release-mutation-artifacts.js';

const INVALID = 'release-certification-mutation-program-invalid';
const produced = new WeakMap<object, ReleaseMutationPackageArtifactsV21>();

function refuse(): never {
  throw new Error(INVALID);
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())
  )
    return refuse();
  return value as Record<string, unknown>;
}

function copy(value: ReleaseMutationPackageArtifactsV21): ReleaseMutationPackageArtifactsV21 {
  return {
    inputDigest: value.inputDigest,
    report: { ...value.report, bytes: Buffer.from(value.report.bytes) },
    result: { ...value.result, bytes: Buffer.from(value.result.bytes) },
  };
}

/**
 * Normalize only the private result of this exact protected program invocation.
 * The observation is captured before test workers run. Its complete selected and
 * instrumented census is checked before filtering zero-emission files for the
 * raw reporter comparison. This does not execute, retain, or certify anything.
 */
export function normalizeProtectedMutationExecutionV21(input: {
  readonly program: ProtectedMutationProgram;
  readonly execution: unknown;
}): ReleaseMutationPackageArtifactsV21 {
  const program = captureProtectedMutationProgram(input.program);
  const { package: pkg, limits } = captureProtectedMutationProgramPackage(input.program);
  const execution = captureProtectedMutationExecution(input.execution, input.program);
  if (
    execution.program_identity_sha256 !== program.identity_sha256 ||
    execution.mutation_observation === undefined ||
    execution.mutation_observation.length === 0 ||
    execution.mutation_observation.length > program.maximum_observation_bytes ||
    execution.mutation_report === undefined ||
    execution.mutation_report.length === 0 ||
    execution.mutation_report.length > program.maximum_raw_report_bytes
  )
    refuse();
  let observation: Record<string, unknown>;
  try {
    observation = closed(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(execution.mutation_observation)),
      ['selected', 'instrumented', 'source_files'],
    );
  } catch {
    return refuse();
  }
  const targets = pkg.mutation_targets.map(({ path, sha256 }) => ({ path, sha256 }));
  if (
    canonicalJson(observation.selected) !== canonicalJson(targets) ||
    canonicalJson(observation.instrumented) !== canonicalJson(targets.map(({ path }) => path)) ||
    !Array.isArray(observation.source_files) ||
    observation.source_files.length !== targets.length ||
    observation.source_files.length > limits.maximum_files
  )
    refuse();
  let mutantCount = 0;
  const ids = new Set<string>();
  const sourceFiles = observation.source_files.map((value, index) => {
    const row = closed(value, ['path', 'sha256', 'mutants']);
    const target = targets[index];
    if (
      target === undefined ||
      row.path !== target.path ||
      row.sha256 !== target.sha256 ||
      !Array.isArray(row.mutants)
    )
      return refuse();
    mutantCount += row.mutants.length;
    if (mutantCount > limits.maximum_mutants) refuse();
    for (const value of row.mutants) {
      const mutant = closed(value, ['id', 'mutatorName', 'replacementDigest', 'location']);
      if (typeof mutant.id !== 'string' || ids.has(mutant.id)) refuse();
      ids.add(mutant.id);
    }
    return {
      path: `${pkg.expected.workspace}/${target.path}`,
      sha256: target.sha256,
      // Detailed identity/location validation remains in the single normalizer.
      mutants: row.mutants as ReleaseMutationDiscoveredMutantV21[],
    };
  });
  const artifacts = normalizeReleaseMutationPackageV21({
    expected: pkg.expected,
    raw_report: execution.mutation_report,
    execution_cwd: '/workspace/candidate',
    process: {
      errorAbsent: execution.result.errorCode === undefined,
      signal: execution.result.signal,
      status: execution.result.status,
    },
    source_files: sourceFiles.filter((entry) => entry.mutants.length !== 0),
    test_files: pkg.selected_tests.map((entry) => entry.path),
    limits,
  });
  if (artifacts.inputDigest !== pkg.input_digest) refuse();
  const result = copy(artifacts);
  produced.set(result, copy(artifacts));
  return result;
}

/** Failed results remain failed; same-instance custody proves origin, not a passing verdict. */
export function captureProducedMutationPackageV21(
  value: unknown,
): ReleaseMutationPackageArtifactsV21 {
  const artifacts = value !== null && typeof value === 'object' ? produced.get(value) : undefined;
  if (artifacts === undefined) return refuse();
  return copy(artifacts);
}
