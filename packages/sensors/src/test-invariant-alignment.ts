import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
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
 * F3×T4 = Observation × Alignment per Article 5. This sensor asks
 * "do the tests we run actually exercise the invariants we declared?"
 * — the canonical alignment question.
 */

export interface TestInvariantAlignmentOptions {
  readonly repoRoot: string;
  /** Default: `law/trace.json`. */
  readonly tracePath?: string;
  readonly now?: string;
}

interface TraceFile {
  readonly invariants?: ReadonlyArray<{
    readonly id?: string;
    readonly tests?: ReadonlyArray<unknown>;
  }>;
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
