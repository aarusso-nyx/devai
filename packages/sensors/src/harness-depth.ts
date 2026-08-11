import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import { loadWorkflows } from './harness/workflow-parser.js';

/**
 * F5 harness depth sensor (28.C; F5×T2). Per design note at
 * docs/theory/architecture/sensors/harness_depth.md.
 */

export interface HarnessDepthOptions {
  readonly repoRoot: string;
  readonly workflowDir?: string;
  readonly thresholds?: { readonly pass: number };
  readonly now?: string;
}

const DEFAULT_THRESHOLDS = { pass: 3 } as const;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] ?? 0;
}

export function senseHarnessDepth(opts: HarnessDepthOptions): SensorReading {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const workflows = loadWorkflows(opts.repoRoot, opts.workflowDir);
  const findings: SensorFinding[] = [];

  const stepCounts: number[] = [];
  let totalMatrix = 0;
  let jobsCount = 0;
  for (const wf of workflows) {
    for (const job of wf.jobs) {
      stepCounts.push(job.stepCount);
      totalMatrix += job.matrixCombinations;
      jobsCount += 1;
    }
  }
  stepCounts.sort((a, b) => a - b);
  const p95 = percentile(stepCounts, 0.95);
  const median = percentile(stepCounts, 0.5);

  let status: SensorStatus;
  if (workflows.length === 0 || jobsCount === 0) {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'HARNESS_DEPTH_NO_JOBS',
      message: workflows.length === 0 ? 'No workflows found.' : 'No jobs across all workflows.',
    });
  } else if (p95 >= thresholds.pass) {
    status = 'pass';
  } else if (p95 >= 1) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'HARNESS_DEPTH_THIN',
      message: `95th-percentile step count ${String(p95)} below PASS threshold ${String(thresholds.pass)}.`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'HARNESS_DEPTH_EMPTY',
      message: 'Workflows have effectively no steps.',
    });
  }

  return buildSensorReading({
    sensorName: 'harness-depth',
    sensorKind: 'harness_depth',
    command: ['devai', 'sense-harness-depth'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      workflow_count: workflows.length,
      jobs_count: jobsCount,
      steps_p95: p95,
      steps_median: median,
      total_matrix_combinations: totalMatrix,
      threshold_pass: thresholds.pass,
    },
  });
}
