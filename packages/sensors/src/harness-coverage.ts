import { spawnSync } from '@devai-nyx/authority';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import { loadWorkflows } from './harness/workflow-parser.js';

/**
 * F5 harness coverage sensor (28.B; F5×T1). Computes the union of
 * `on.<trigger>.paths[]` filters across all workflows and asks
 * "what fraction of tracked repo files would trigger ≥ 1 workflow?"
 * Per design note at docs/theory/architecture/sensors/harness_coverage.md.
 */

export interface HarnessCoverageOptions {
  readonly repoRoot: string;
  readonly workflowDir?: string;
  readonly thresholds?: { readonly pass: number; readonly review: number };
  readonly now?: string;
}

const DEFAULT_THRESHOLDS = { pass: 80, review: 50 } as const;

function listGitFiles(repoRoot: string): readonly string[] {
  const r = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter((s) => s.length > 0);
}

function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c !== undefined && /[.+?^${}()|[\]\\]/.test(c)) {
      re += '\\' + c;
    } else {
      re += c ?? '';
    }
  }
  re += '$';
  return new RegExp(re);
}

export function senseHarnessCoverage(opts: HarnessCoverageOptions): SensorReading {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const workflows = loadWorkflows(opts.repoRoot, opts.workflowDir);
  const findings: SensorFinding[] = [];

  if (workflows.length === 0) {
    return buildSensorReading({
      sensorName: 'harness-coverage',
      sensorKind: 'harness_coverage',
      command: ['devai', 'sense-harness-coverage'],
      status: 'review',
      deterministic: true,
      tier: 'L0',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_COVERAGE_NO_WORKFLOWS',
          message: 'No workflow files found.',
        },
      ],
      metrics: { workflow_count: 0, total_files: 0, covered_files: 0, coverage_pct: 0 },
    });
  }

  // If any workflow has zero `paths:` filters, it runs on every push/PR
  // for the matching event — treat as full-repo coverage.
  const anyUnfiltered = workflows.some((w) => w.onPaths.length === 0);
  if (anyUnfiltered) {
    return buildSensorReading({
      sensorName: 'harness-coverage',
      sensorKind: 'harness_coverage',
      command: ['devai', 'sense-harness-coverage'],
      status: 'pass',
      deterministic: true,
      tier: 'L0',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [],
      metrics: {
        workflow_count: workflows.length,
        covered_by_unfiltered_workflow: 1,
        coverage_pct: 100,
      },
    });
  }

  const pathsRes = workflows.flatMap((w) => w.onPaths.map(globToRegExp));
  const ignoreRes = workflows.flatMap((w) => w.onPathsIgnore.map(globToRegExp));
  const files = listGitFiles(opts.repoRoot);
  let covered = 0;
  for (const f of files) {
    if (ignoreRes.some((re) => re.test(f))) continue;
    if (pathsRes.some((re) => re.test(f))) covered += 1;
  }
  const pct = files.length === 0 ? 0 : (covered / files.length) * 100;

  let status: SensorStatus;
  if (pct >= thresholds.pass) status = 'pass';
  else if (pct >= thresholds.review) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'HARNESS_COVERAGE_PARTIAL',
      message: `${pct.toFixed(1)}% of tracked files are covered by some workflow path filter (below pass ${String(thresholds.pass)}%).`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'HARNESS_COVERAGE_BELOW_THRESHOLD',
      message: `${pct.toFixed(1)}% coverage (below review ${String(thresholds.review)}%).`,
    });
  }

  return buildSensorReading({
    sensorName: 'harness-coverage',
    sensorKind: 'harness_coverage',
    command: ['devai', 'sense-harness-coverage'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      workflow_count: workflows.length,
      total_files: files.length,
      covered_files: covered,
      coverage_pct: Number(pct.toFixed(2)),
      threshold_pass: thresholds.pass,
      threshold_review: thresholds.review,
    },
  });
}
