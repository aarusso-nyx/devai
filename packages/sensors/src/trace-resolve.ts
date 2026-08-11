import { execFileSync } from '@devai-nyx/authority';
import { validateRepositoryTarget } from '@devai-nyx/utils';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

export interface TraceResolveOptions {
  readonly repoRoot: string;
  readonly tracePath?: string;
  readonly invariantsDir?: string;
}

type TraceTargetType = 'test' | 'config-attestation' | 'script';

interface TraceFile {
  meta?: {
    completeness?: {
      require_test_links?: boolean;
    };
  };
  invariants?: Array<{
    id?: string;
    tests?: Array<{ path?: string; suite?: string; target_type?: TraceTargetType }>;
  }>;
}

/**
 * Resolve the trace at `tracePath` against the invariants under
 * `invariantsDir` and check that:
 *   - every trace entry references an existing invariant file
 *   - every trace entry's test paths exist on disk
 *   - every invariant has a trace entry (coverage)
 *
 * Emits a SensorReading with one finding per problem.
 */
export function senseTraceResolve(opts: TraceResolveOptions): SensorReading {
  const tracePath = opts.tracePath ?? resolve(opts.repoRoot, 'law/trace.json');
  const invariantsDir = opts.invariantsDir ?? resolve(opts.repoRoot, 'law/invariants');
  const command = [
    'devai',
    'sense',
    'trace-resolve',
    '--trace',
    tracePath,
    '--invariants-dir',
    invariantsDir,
  ];
  const findings: SensorFinding[] = [];

  if (!existsSync(tracePath)) {
    return buildSensorReading({
      sensorName: 'trace-resolve',
      sensorKind: 'trace_resolution',
      command,
      status: 'error',
      deterministic: true,
      findings: [
        { severity: 'critical', code: 'no_trace', message: `${tracePath} does not exist` },
      ],
    });
  }

  let parsed: TraceFile;
  try {
    parsed = JSON.parse(readFileSync(tracePath, 'utf8')) as TraceFile;
  } catch (err) {
    return buildSensorReading({
      sensorName: 'trace-resolve',
      sensorKind: 'trace_resolution',
      command,
      status: 'error',
      deterministic: true,
      findings: [
        {
          severity: 'critical',
          code: 'trace_parse',
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    });
  }

  // Build invariant catalog from filenames in invariantsDir (INV-*.json).
  let invariantIds: Set<string>;
  try {
    invariantIds = new Set(
      readdirSync(invariantsDir)
        .filter((f) => /^INV-.+\.json$/.test(f))
        .map((f) => f.replace(/\.json$/, '')),
    );
  } catch {
    invariantIds = new Set();
    findings.push({
      severity: 'critical',
      code: 'invariant_catalog_unavailable',
      message: `${invariantsDir} could not be read`,
    });
  }

  let unresolvedTraceEntries = 0;
  let missingTestPaths = 0;
  let untracedInvariants = 0;

  const requireTestLinks = parsed.meta?.completeness?.require_test_links === true;
  const anyLinkedIds = new Set<string>();
  const testLinkedIds = new Set<string>();
  // D-123 (item 10): an invariant traced ONLY by non-'test' targets
  // (config-attestation / script) has weaker evidence than one with
  // at least one real 'test' entry — track separately so trace
  // completeness metrics don't overstate active test verification.
  const nonTestLinkedIds = new Set<string>();
  for (const [i, entry] of (parsed.invariants ?? []).entries()) {
    const id = entry.id;
    if (id === undefined) {
      unresolvedTraceEntries++;
      findings.push({
        severity: 'error',
        code: 'missing_invariant_id',
        message: `trace entry [${String(i)}] has no invariant id`,
      });
      continue;
    }
    const knownInvariant = invariantIds.has(id);
    if (!knownInvariant) {
      unresolvedTraceEntries++;
      findings.push({
        severity: 'error',
        code: 'unresolved_invariant',
        message: `trace entry [${String(i)}] references invariant ${id} that does not exist`,
      });
    }
    const tests = entry.tests ?? [];
    for (const [j, t] of tests.entries()) {
      if (t.path === undefined || t.path.length === 0) {
        missingTestPaths++;
        findings.push({
          severity: 'warning',
          code: 'missing_test_path',
          message: `trace entry [${String(i)}] test [${String(j)}] has no path`,
        });
        continue;
      }
      const target = validateRepositoryTarget(
        opts.repoRoot,
        t.path,
        t.target_type === undefined || t.target_type === 'test' ? 'test' : 'file',
      );
      let tracked = false;
      if (target.ok) {
        try {
          execFileSync('git', ['ls-files', '--error-unmatch', '--', target.repositoryPath], {
            cwd: opts.repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'ignore', 'ignore'],
          });
          tracked = true;
        } catch {
          tracked = false;
        }
      }
      if (!target.ok || !tracked) {
        missingTestPaths++;
        findings.push({
          severity: 'error',
          code: 'invalid_test_path',
          message: `trace entry [${String(i)}] test [${String(j)}] path '${t.path}' is not a contained, tracked file of the declared kind`,
        });
        continue;
      }
      if (knownInvariant) {
        anyLinkedIds.add(id);
        if (t.target_type === undefined || t.target_type === 'test') {
          testLinkedIds.add(id);
        } else {
          nonTestLinkedIds.add(id);
        }
      }
    }
  }

  const tracedIds = requireTestLinks ? testLinkedIds : anyLinkedIds;
  for (const id of invariantIds) {
    if (!tracedIds.has(id)) {
      untracedInvariants++;
      findings.push({
        severity: 'warning',
        code: 'untraced_invariant',
        message: `invariant ${id} has no trace entry`,
      });
    }
  }

  const attestationOnlyIds = new Set([...nonTestLinkedIds].filter((id) => !testLinkedIds.has(id)));
  for (const id of attestationOnlyIds) {
    findings.push({
      severity: 'info',
      code: 'attestation_only_invariant',
      message: `invariant ${id} is traced only by non-test targets (config-attestation/script) — weaker evidence than an executing test`,
    });
  }

  const errorCount = findings.filter(
    (f) => f.severity === 'error' || f.severity === 'critical',
  ).length;
  // 'info' findings (e.g. attestation_only_invariant) never affect status —
  // matches every other sensor's convention (docs-drift's driftCount is
  // error-only-counted too). Only 'warning'+ severities trip 'review'.
  const reviewCount = findings.filter((f) => f.severity === 'warning').length;
  const status: SensorStatus = errorCount > 0 ? 'fail' : reviewCount > 0 ? 'review' : 'pass';

  return buildSensorReading({
    sensorName: 'trace-resolve',
    sensorKind: 'trace_resolution',
    command,
    status,
    deterministic: true,
    findings,
    metrics: {
      unresolved_trace_entries: unresolvedTraceEntries,
      missing_test_paths: missingTestPaths,
      untraced_invariants: untracedInvariants,
      invariants_total: invariantIds.size,
      traced_invariants: tracedIds.size,
      attestation_only_invariants: attestationOnlyIds.size,
    },
  });
}
