import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ThresholdPolicy {
  readonly freshness?: {
    readonly scorecard_failure_max_age_hours?: unknown;
  };
}

/** Resolve the configured stale-failure boundary and reject malformed policy. */
export function loadScorecardFailureMaxAgeMs(repoRoot: string): number | undefined {
  const canonicalPath = join(repoRoot, 'law/policy/thresholds.json');
  const materializedPath = join(repoRoot, '.devai/config/thresholds.json');
  const policyPath = existsSync(canonicalPath) ? canonicalPath : materializedPath;
  if (!existsSync(policyPath)) return undefined;
  const policyBytes = readFileSync(policyPath, 'utf8');
  if (
    policyPath === canonicalPath &&
    existsSync(materializedPath) &&
    readFileSync(materializedPath, 'utf8') !== policyBytes
  ) {
    throw new Error('canonical and materialized thresholds.json bytes diverge');
  }
  const parsed = JSON.parse(policyBytes) as ThresholdPolicy;
  const hours = parsed.freshness?.scorecard_failure_max_age_hours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 1 || hours > 8760) {
    throw new Error(
      'thresholds.json freshness.scorecard_failure_max_age_hours must be at least 1 and at most 8760',
    );
  }
  return hours * 60 * 60 * 1000;
}
