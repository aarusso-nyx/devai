import { existsSync, readFileSync, readdirSync } from '@devai-nyx/authority';
import { join } from 'node:path';

import { canonicalSha256 } from '@devai-nyx/utils';
import {
  type ReleaseRecord,
  type ReleaseCheck,
  aggregateVerdict,
  nextReleaseId,
  persist,
  stateDir,
} from './records.js';
export {
  runPostdeployVerify,
  runPostdeployVerifyFromCharter,
  runRuntimeDrift,
  runRuntimeDriftFromCharter,
  type PostdeployVerifyOptions,
  type PostdeployVerifyFromCharterOptions,
  type RuntimeDriftOptions,
  type RuntimeDriftFromCharterOptions,
  type ProbeAggregate,
  type DriftProbeOutcome,
} from './postdeploy.js';
export type {
  ReleaseRecord,
  ReleaseKind,
  ReleaseVerdict,
  ReleaseInputs,
  ReleaseCheck,
  ReleaseDriftObservation,
} from './records.js';

function countJsonFilesRecursively(root: string): number {
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += countJsonFilesRecursively(path);
    else if (entry.isFile() && entry.name.endsWith('.json')) count += 1;
  }
  return count;
}

export interface GateOptions {
  readonly repoRoot: string;
  readonly scorecardRef?: string;
  readonly sensorReadingsDir?: string;
  readonly invariantsDir?: string;
  readonly artifactRef?: string;
  readonly environment?: ReleaseRecord['environment'];
  readonly auditChainHead?: string;
  readonly now?: string;
}

/**
 * Read the scorecard (if provided) and assemble a gate-decision.
 * The check set is intentionally simple at MVP: scorecard verdict,
 * invariant catalog presence, sensor-reading freshness. Each check
 * produces a check entry; verdict aggregates per aggregateVerdict.
 */
export function runReleaseGate(opts: GateOptions): ReleaseRecord {
  const checks: ReleaseCheck[] = [];
  const reasons: string[] = [];

  // Check 1: scorecard verdict (if a scorecard file is supplied).
  if (opts.scorecardRef !== undefined) {
    if (!existsSync(opts.scorecardRef)) {
      checks.push({
        name: 'scorecard.readable',
        verdict: 'inconclusive',
        detail: `scorecard not found at ${opts.scorecardRef}`,
      });
      reasons.push('scorecard not found');
    } else {
      try {
        const sc = JSON.parse(readFileSync(opts.scorecardRef, 'utf8')) as {
          gate_decision?: string;
          overall_state?: string;
        };
        const decision = sc.gate_decision ?? sc.overall_state ?? 'unknown';
        const verdict: ReleaseCheck['verdict'] =
          decision === 'pass' || decision === 'green'
            ? 'pass'
            : decision === 'fail' || decision === 'red'
              ? 'block'
              : decision === 'review' || decision === 'amber' || decision === 'yellow'
                ? 'review'
                : 'inconclusive';
        checks.push({ name: 'scorecard.decision', verdict, detail: `decision=${decision}` });
        if (verdict === 'block') reasons.push(`scorecard decision: ${decision}`);
        if (verdict === 'review') reasons.push(`scorecard requires review: ${decision}`);
      } catch (err) {
        checks.push({
          name: 'scorecard.parse',
          verdict: 'inconclusive',
          detail: err instanceof Error ? err.message : String(err),
        });
        reasons.push('scorecard parse error');
      }
    }
  } else {
    checks.push({
      name: 'scorecard.decision',
      verdict: 'skipped',
      detail: 'no --scorecard provided',
    });
  }

  // Check 2: invariant catalog non-empty (proxy for "RTD is ready").
  if (opts.invariantsDir !== undefined) {
    if (!existsSync(opts.invariantsDir)) {
      checks.push({
        name: 'invariants.present',
        verdict: 'block',
        detail: `invariants dir not found at ${opts.invariantsDir}`,
      });
      reasons.push('invariants directory missing');
    } else {
      const names = readdirSync(opts.invariantsDir, { withFileTypes: true }).filter(
        (entry) => entry.isFile() && /^INV-.*\.json$/.test(entry.name),
      );
      if (names.length === 0) {
        checks.push({
          name: 'invariants.present',
          verdict: 'block',
          detail: 'no INV-*.json files',
        });
        reasons.push('invariants catalog empty');
      } else {
        checks.push({
          name: 'invariants.present',
          verdict: 'pass',
          detail: `${String(names.length)} INV file(s)`,
        });
      }
    }
  } else {
    checks.push({ name: 'invariants.present', verdict: 'skipped' });
  }

  // Check 3: sensor readings present.
  if (opts.sensorReadingsDir !== undefined) {
    if (!existsSync(opts.sensorReadingsDir)) {
      checks.push({
        name: 'sensors.fresh',
        verdict: 'review',
        detail: 'no sensor-readings dir found',
      });
      reasons.push('no sensor readings');
    } else {
      const readingCount = countJsonFilesRecursively(opts.sensorReadingsDir);
      const verdict: ReleaseCheck['verdict'] = readingCount > 0 ? 'pass' : 'review';
      checks.push({
        name: 'sensors.fresh',
        verdict,
        detail: `${String(readingCount)} reading(s)`,
      });
      if (verdict === 'review') reasons.push('no sensor readings emitted');
    }
  } else {
    checks.push({ name: 'sensors.fresh', verdict: 'skipped' });
  }

  const verdict = aggregateVerdict(checks);
  const record: ReleaseRecord = {
    schemaVersion: '1.0.0',
    id: nextReleaseId(opts.repoRoot),
    kind: 'gate',
    decided_at: opts.now ?? new Date().toISOString(),
    ...(opts.artifactRef !== undefined && { artifact_ref: opts.artifactRef }),
    ...(opts.environment !== undefined && { environment: opts.environment }),
    verdict,
    ...(reasons.length > 0 && { reasons }),
    inputs: {
      ...(opts.scorecardRef !== undefined && { scorecard_ref: opts.scorecardRef }),
      ...(opts.sensorReadingsDir !== undefined && { sensor_readings_dir: opts.sensorReadingsDir }),
      ...(opts.invariantsDir !== undefined && { invariants_dir: opts.invariantsDir }),
      ...(opts.auditChainHead !== undefined && { audit_chain_head: opts.auditChainHead }),
    },
    checks,
  };
  persist(opts.repoRoot, record);
  return record;
}

export function listReleases(repoRoot: string): readonly ReleaseRecord[] {
  const dir = stateDir(repoRoot);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => /^REL-\d{4,}\.json$/.test(n))
      .sort();
  } catch {
    return [];
  }
  const out: ReleaseRecord[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, n), 'utf8')) as ReleaseRecord);
    } catch {
      // skip unparseable
    }
  }
  return out;
}

/**
 * Compute a deterministic content hash over a release record for
 * external log / audit-trail purposes. SHA-256 over the
 * current canonical-JSON form.
 *
 * **Not persisted on the release-control.schema.json record
 * itself.** Unlike `agent-run` / `rtd-manifest`, release records
 * carry no stored `manifest_hash` field, so there is no
 * callers compute the hash on demand and MUST treat each call as
 * authoritative for the live record at call time.
 */
export function releaseContentHash(record: ReleaseRecord): string {
  return canonicalSha256(record);
}

export function getReleaseDir(repoRoot: string): string {
  return stateDir(repoRoot);
}
