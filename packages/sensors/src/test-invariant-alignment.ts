import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

/**
 * Inventory sensor: test↔invariant alignment (F3 × T4). Phase 26.G
 * (closes D-77 sub-batch 26.G). Reads `law/trace.json`
 * and asserts that every invariant entry has a non-empty `tests[]`
 * array.
 *
 * Status semantics:
 *   - PASS: every invariant in trace.json has ≥ 1 entry in `tests[]`.
 *   - REVIEW: ≥ 1 invariant has an empty `tests[]`. (The invariant
 *     exists but no test claims to exercise it — the alignment is
 *     incomplete. This is a discipline signal, not a hard failure.)
 *   - FAIL: trace.json is missing. (No alignment substrate at all.)
 *
 * ADR-SCR-0004 record layout: every invariant record under `invariantsDir`
 * (default `law/invariants`) must have a trace entry. A record the trace does
 * not name is unaligned exactly like an entry with an empty `tests[]`.
 *
 * F3×T4 = Observation × Alignment per Article 5. This sensor asks
 * "do the tests we run actually exercise the invariants we declared?"
 * — the canonical alignment question.
 */

export interface TestInvariantAlignmentOptions {
  readonly repoRoot: string;
  /** Default: `law/trace.json`. */
  readonly tracePath?: string;
  /** Default: `law/invariants`. */
  readonly invariantsDir?: string;
  readonly now?: string;
}

interface TraceFile {
  readonly invariants?: ReadonlyArray<{
    readonly id?: string;
    readonly tests?: ReadonlyArray<unknown>;
  }>;
}

/** Ids of the invariant records under `dir`, sorted; empty when the directory is absent. */
function recordedInvariantIds(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names) {
    try {
      const id = (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    } catch {
      // An unreadable record is the invariant validator's finding, not this sensor's.
    }
  }
  return ids.sort();
}

export function senseTestInvariantAlignment(opts: TestInvariantAlignmentOptions): SensorReading {
  const raw = opts.tracePath ?? 'law/trace.json';
  const tracePath = isAbsolute(raw) ? raw : resolve(opts.repoRoot, raw);

  let trace: TraceFile | null = null;
  try {
    trace = JSON.parse(readFileSync(tracePath, 'utf8')) as TraceFile;
  } catch {
    trace = null;
  }

  if (trace === null) {
    return buildSensorReading({
      sensorName: 'test-invariant-alignment',
      sensorKind: 'test_invariant_alignment',
      command: ['devai', 'sense-test-invariant-alignment'],
      status: 'fail',
      deterministic: true,
      tier: 'L0',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'error',
          code: 'TEST_INVARIANT_ALIGNMENT_NO_TRACE',
          message: `trace.json not found at ${tracePath}`,
        },
      ],
      metrics: { invariant_count: 0, unaligned_count: 0 },
    });
  }

  const invariants = trace.invariants ?? [];
  const findings: SensorFinding[] = [];
  let unaligned = 0;
  for (const inv of invariants) {
    const tests = inv.tests ?? [];
    if (tests.length === 0) {
      unaligned += 1;
      findings.push({
        severity: 'warning',
        code: 'TEST_INVARIANT_ALIGNMENT_EMPTY_TESTS',
        message: `Invariant ${inv.id ?? '<unknown>'} has no tests[] entries in trace.json.`,
      });
    }
  }

  const rawInvariantsDir = opts.invariantsDir ?? 'law/invariants';
  const invariantsDir = isAbsolute(rawInvariantsDir)
    ? rawInvariantsDir
    : resolve(opts.repoRoot, rawInvariantsDir);
  const tracedIds = new Set(invariants.map((inv) => inv.id));
  for (const id of recordedInvariantIds(invariantsDir)) {
    if (tracedIds.has(id)) continue;
    unaligned += 1;
    findings.push({
      severity: 'warning',
      code: 'TEST_INVARIANT_ALIGNMENT_UNTRACED_RECORD',
      message: `Invariant record ${id} has no entry in trace.json.`,
    });
  }

  let status: SensorStatus;
  if (invariants.length === 0) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'TEST_INVARIANT_ALIGNMENT_EMPTY_TRACE',
      message: 'trace.json contains zero invariants.',
    });
  } else if (unaligned === 0) {
    status = 'pass';
  } else {
    status = 'review';
  }

  return buildSensorReading({
    sensorName: 'test-invariant-alignment',
    sensorKind: 'test_invariant_alignment',
    command: ['devai', 'sense-test-invariant-alignment'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      invariant_count: invariants.length,
      unaligned_count: unaligned,
    },
  });
}
