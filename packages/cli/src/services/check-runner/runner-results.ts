import type { CheckRunnerReport, TaskResult } from './types.js';

const protectedCompletedTaskResults = new WeakMap<CheckRunnerReport, readonly TaskResult[]>();

export function snapshotTaskResult(value: TaskResult): TaskResult {
  return Object.freeze({
    ...value,
    dependencyResultDigests: Object.freeze({ ...value.dependencyResultDigests }),
    outputDigests: Object.freeze({ ...value.outputDigests }),
  });
}

/**
 * A protected certification host may retain the canonical task-result population
 * while it is still live. This never consults a cache path and is unavailable for
 * reports that did not produce an attestable candidate receipt.
 */
export function readProtectedCompletedTaskResults(
  report: CheckRunnerReport,
): readonly TaskResult[] {
  const results = protectedCompletedTaskResults.get(report);
  if (results === undefined) throw new Error('release-certification-task-results-unavailable');
  return results.map(snapshotTaskResult);
}

/** Retain a protected run's canonical task results for its attestable report. */
export function retainProtectedCompletedTaskResults(
  report: CheckRunnerReport,
  results: readonly TaskResult[],
): void {
  protectedCompletedTaskResults.set(report, results);
}
