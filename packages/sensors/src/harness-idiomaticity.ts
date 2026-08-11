import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import { loadWorkflows } from './harness/workflow-parser.js';

/**
 * F5 harness idiomaticity sensor (28.F; F5×T5). Per design note at
 * docs/theory/architecture/sensors/harness_idiomaticity.md.
 */

export interface HarnessIdiomaticityOptions {
  readonly repoRoot: string;
  readonly workflowDir?: string;
  readonly now?: string;
  /**
   * Phase 35.D (D-93): suppress the reusable-workflow signal when
   * `workflow_count < minWorkflowsForReusableCheck`. Default 1
   * (no behavior change). Adopters with a small fixed CI surface
   * (e.g. 2 workflows) pack-tune to 3 so the score is graded over
   * (composite + cache) rather than (composite + reusable + cache),
   * matching the honest "reusables aren't worth it at this scale"
   * read. At workflow_count ≥ threshold the original three-axis
   * grade applies.
   */
  readonly minWorkflowsForReusableCheck?: number;
}

export function senseHarnessIdiomaticity(opts: HarnessIdiomaticityOptions): SensorReading {
  const workflows = loadWorkflows(opts.repoRoot, opts.workflowDir);
  const findings: SensorFinding[] = [];

  if (workflows.length === 0) {
    return buildSensorReading({
      sensorName: 'harness-idiomaticity',
      sensorKind: 'harness_idiomaticity',
      command: ['devai', 'sense-harness-idiomaticity'],
      status: 'review',
      deterministic: true,
      tier: 'L0',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_IDIOMATICITY_NO_WORKFLOWS',
          message: 'No workflows found.',
        },
      ],
      metrics: { workflow_count: 0, idiomaticity_score: 0 },
    });
  }

  const compositeCount = workflows.reduce((acc, w) => acc + w.compositeActionUses.length, 0);
  const reusableCount = workflows.reduce((acc, w) => acc + w.reusableWorkflowUses.length, 0);
  const cachePresent = workflows.some((w) => w.hasCache);
  const compositePresent = compositeCount > 0;
  const reusablePresent = reusableCount > 0;

  // Phase 35.D (D-93): when workflow_count < minWorkflowsForReusableCheck,
  // suppress the reusable-workflow signal from both the score denominator
  // and the findings list. Small-CI repos (2 workflows) don't benefit from
  // reusable workflows; grading them on the same 3-axis scale as 10+
  // workflow repos produces noise, not signal.
  const minWorkflowsForReusable = opts.minWorkflowsForReusableCheck ?? 1;
  const checkReusable = workflows.length >= minWorkflowsForReusable;

  const reusableAxes = checkReusable ? (reusablePresent ? 1 : 0) : 0;
  const reusableDenominator = checkReusable ? 1 : 0;
  const score = (compositePresent ? 1 : 0) + reusableAxes + (cachePresent ? 1 : 0);
  const denominator = 1 + reusableDenominator + 1; // composite + reusable? + cache

  if (!compositePresent)
    findings.push({
      severity: 'warning',
      code: 'HARNESS_IDIOMATICITY_NO_COMPOSITE_ACTIONS',
      message:
        'No composite-action references (./.github/actions/*) found. Consider extracting repeated step sequences.',
    });
  if (checkReusable && !reusablePresent)
    findings.push({
      severity: 'warning',
      code: 'HARNESS_IDIOMATICITY_NO_REUSABLE_WORKFLOWS',
      message: 'No reusable workflow references found. Consider factoring shared CI logic.',
    });
  if (!cachePresent)
    findings.push({
      severity: 'warning',
      code: 'HARNESS_IDIOMATICITY_NO_CACHE',
      message: 'No cache action usage detected. Dep install will run from scratch every CI run.',
    });

  let status: SensorStatus;
  if (score === denominator) status = 'pass';
  else if (score === 0) status = 'fail';
  else status = 'review';

  return buildSensorReading({
    sensorName: 'harness-idiomaticity',
    sensorKind: 'harness_idiomaticity',
    command: ['devai', 'sense-harness-idiomaticity'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      workflow_count: workflows.length,
      composite_action_uses: compositeCount,
      reusable_workflow_uses: reusableCount,
      cache_present: cachePresent ? 1 : 0,
      idiomaticity_score: score,
    },
  });
}
