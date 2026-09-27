import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: spec robustness targets (F1 × T8). Phase 27.E.
 * Per design note at docs/theory/architecture/sensors/spec_robustness_targets.md.
 *
 * ADR-SCR-0004 record layout: the targets record `law/targets/robustness.json`
 * (kind `robustness`, at least one target naming a sensor kind and a metric)
 * stands in for the error-contract files. PASS needs the robustness invariants
 * and either an error-contract file or at least one declared target.
 */

export interface SpecRobustnessTargetsOptions {
  readonly repoRoot: string;
  readonly invariantsDir?: string;
  readonly errorContractDirs?: readonly string[];
  /** Default: `law/targets/robustness.json`. */
  readonly targetsPath?: string;
  readonly now?: string;
}

const DEFAULT_INVARIANTS_DIR = 'law/invariants';
const DEFAULT_ERROR_DIRS = ['docs/reference/contracts'];
const DEFAULT_TARGETS_PATH = 'law/targets/robustness.json';
const ERROR_FILE_RE = /^(errors?[-_].*|errors?\.json|error-.*\.(md|json))$/i;
const ROBUSTNESS_STATEMENT_RE =
  /\b(error|retry|idempot(?:ent)?|circuit|timeout|fallback|graceful)\b/i;

function abs(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

interface InvariantRecord {
  readonly type?: string;
  readonly statement?: string;
}

function countRobustnessInvariants(repoRoot: string, dir: string): number {
  const d = abs(repoRoot, dir);
  let entries: string[];
  try {
    entries = readdirSync(d);
  } catch {
    return 0;
  }
  let n = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(d, entry), 'utf8')) as InvariantRecord;
      if (parsed.type === 'error_semantics') {
        n += 1;
        continue;
      }
      if (
        parsed.type === 'data_contract' &&
        typeof parsed.statement === 'string' &&
        ROBUSTNESS_STATEMENT_RE.test(parsed.statement)
      ) {
        n += 1;
      }
    } catch {
      // skip
    }
  }
  return n;
}

function countErrorContracts(repoRoot: string, dirs: readonly string[]): number {
  let n = 0;
  for (const dir of dirs) {
    const d = abs(repoRoot, dir);
    const st = safeStat(d);
    if (st === null || !st.isDirectory()) continue;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (ERROR_FILE_RE.test(entry)) n += 1;
    }
  }
  return n;
}

/**
 * Targets declared by a law/targets record (ADR-SCR-0004): the number of `targets[]`
 * entries naming a sensor kind and a metric, when the record carries the expected
 * `kind` and is not retired. Zero when the file is absent or unreadable.
 */
function countDeclaredTargets(repoRoot: string, path: string, kind: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs(repoRoot, path), 'utf8'));
  } catch {
    return 0;
  }
  if (typeof parsed !== 'object' || parsed === null) return 0;
  const record = parsed as { kind?: unknown; status?: unknown; targets?: unknown };
  if (record.kind !== kind || record.status === 'retired' || !Array.isArray(record.targets)) {
    return 0;
  }
  return (record.targets as unknown[]).filter((target) => {
    if (typeof target !== 'object' || target === null) return false;
    const t = target as { sensor_kind?: unknown; metric?: unknown };
    return (
      typeof t.sensor_kind === 'string' &&
      t.sensor_kind.length > 0 &&
      typeof t.metric === 'string' &&
      t.metric.length > 0
    );
  }).length;
}

export function senseSpecRobustnessTargets(opts: SpecRobustnessTargetsOptions): SensorReading {
  const robustnessInv = countRobustnessInvariants(
    opts.repoRoot,
    opts.invariantsDir ?? DEFAULT_INVARIANTS_DIR,
  );
  const errorContracts = countErrorContracts(
    opts.repoRoot,
    opts.errorContractDirs ?? DEFAULT_ERROR_DIRS,
  );

  const robustnessTargets = countDeclaredTargets(
    opts.repoRoot,
    opts.targetsPath ?? DEFAULT_TARGETS_PATH,
    'robustness',
  );

  let status: SensorStatus;
  const findings: SensorFinding[] = [];
  if (robustnessInv >= 1 && (errorContracts >= 1 || robustnessTargets >= 1)) {
    status = 'pass';
  } else if (robustnessInv >= 1 || errorContracts >= 1 || robustnessTargets >= 1) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'SPEC_ROBUSTNESS_PARTIAL',
      message: `Partial robustness targets: ${String(robustnessInv)} invariants, ${String(errorContracts)} error contracts. Both should be ≥ 1.`,
    });
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'SPEC_ROBUSTNESS_NO_TARGETS',
      message: 'No error_semantics invariants and no error-contract files.',
    });
  }

  return buildSensorReading({
    sensorName: 'spec-robustness-targets',
    sensorKind: 'spec_robustness_targets',
    command: ['devai', 'sense-spec-robustness-targets'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      error_semantics_invariants: robustnessInv,
      error_contract_files: errorContracts,
      targets_total: robustnessInv + errorContracts,
    },
  });
}
