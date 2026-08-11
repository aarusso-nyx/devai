import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: spec performance targets (F1 × T7). Phase 27.D.
 * Per design note at docs/theory/architecture/sensors/spec_performance_targets.md.
 */

export interface SpecPerformanceTargetsOptions {
  readonly repoRoot: string;
  readonly invariantsDir?: string;
  readonly useCaseDirs?: readonly string[];
  readonly perfSignalPatterns?: readonly string[];
  /**
   * Phase 29.K (T-1): adopter-tunable minimum signal counts.
   * Default: 1 perf invariant + 1 perf use-case for PASS.
   */
  readonly signalsRequired?: { readonly invariants: number; readonly use_cases: number };
  readonly now?: string;
}

const DEFAULT_INVARIANTS_DIR = 'law/invariants';
const DEFAULT_USE_CASE_DIRS = ['product/use-cases'];
const DEFAULT_PERF_SIGNALS = ['_probes/', '.bench.', '.perf.'];

const PERF_KEYWORDS_RE =
  /\b(p\d{2,3}|latency|throughput|\d+\s*ms\b|\d+\s*rps\b|\d+\s*tps\b|\d+\s*qps\b)\b/i;

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

function walkPaths(dir: string, sink: string[]): void {
  const st = safeStat(dir);
  if (st === null) return;
  if (st.isFile()) {
    sink.push(dir);
    return;
  }
  if (!st.isDirectory()) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === 'build') continue;
    walkPaths(join(dir, e), sink);
  }
}

interface InvariantRecord {
  readonly id?: string;
  readonly type?: string;
}

function countPerfInvariants(repoRoot: string, dir: string): number {
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
      if (parsed.type === 'performance') n += 1;
    } catch {
      // skip
    }
  }
  return n;
}

function countPerfUseCases(repoRoot: string, dirs: readonly string[]): number {
  let n = 0;
  for (const dir of dirs) {
    const sink: string[] = [];
    walkPaths(abs(repoRoot, dir), sink);
    for (const f of sink) {
      if (!/\.(md|json)$/i.test(f)) continue;
      let content: string;
      try {
        content = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      if (PERF_KEYWORDS_RE.test(content)) n += 1;
    }
  }
  return n;
}

function hasPerfRelevantCode(repoRoot: string, patterns: readonly string[]): boolean {
  const sink: string[] = [];
  walkPaths(repoRoot, sink);
  for (const f of sink) {
    if (f.includes('node_modules/')) continue;
    for (const p of patterns) {
      if (f.includes(p)) return true;
    }
  }
  return false;
}

export function senseSpecPerformanceTargets(opts: SpecPerformanceTargetsOptions): SensorReading {
  const perfInvariants = countPerfInvariants(
    opts.repoRoot,
    opts.invariantsDir ?? DEFAULT_INVARIANTS_DIR,
  );
  const perfUseCases = countPerfUseCases(opts.repoRoot, opts.useCaseDirs ?? DEFAULT_USE_CASE_DIRS);
  const perfRelevant = hasPerfRelevantCode(
    opts.repoRoot,
    opts.perfSignalPatterns ?? DEFAULT_PERF_SIGNALS,
  );
  const required = opts.signalsRequired ?? { invariants: 1, use_cases: 1 };

  const findings: SensorFinding[] = [];
  let status: SensorStatus;
  if (perfInvariants >= required.invariants && perfUseCases >= required.use_cases) {
    status = 'pass';
  } else if (perfInvariants >= 1 || perfUseCases >= 1 || perfRelevant) {
    status = 'review';
    if (perfInvariants === 0 && perfRelevant) {
      findings.push({
        severity: 'warning',
        code: 'SPEC_PERFORMANCE_NO_INVARIANTS_BUT_PERF_CODE',
        message:
          'No type=performance invariants but perf-relevant code paths detected (probes/bench).',
      });
    } else if (perfUseCases === 0) {
      findings.push({
        severity: 'warning',
        code: 'SPEC_PERFORMANCE_NO_USE_CASES',
        message: 'No use-case acceptance criteria mentioning latency/throughput.',
      });
    } else if (perfInvariants === 0) {
      findings.push({
        severity: 'warning',
        code: 'SPEC_PERFORMANCE_NO_INVARIANTS',
        message: 'Use-cases mention perf but no type=performance invariants.',
      });
    }
  } else {
    status = 'fail';
    findings.push({
      severity: 'error',
      code: 'SPEC_PERFORMANCE_NO_TARGETS',
      message: 'No perf invariants, no perf use-cases, no perf-relevant code areas detected.',
    });
  }

  return buildSensorReading({
    sensorName: 'spec-performance-targets',
    sensorKind: 'spec_performance_targets',
    command: ['devai', 'sense-spec-performance-targets'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      perf_invariants: perfInvariants,
      perf_use_cases: perfUseCases,
      targets_total: perfInvariants + perfUseCases,
      perf_relevant_code_detected: perfRelevant ? 1 : 0,
    },
  });
}
