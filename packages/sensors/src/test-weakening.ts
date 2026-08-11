import { execFileSync } from '@devai-nyx/authority';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';

export interface TestWeakeningOptions {
  readonly cwd: string;
  /** Git ref to diff against (default: HEAD~1). */
  readonly baseRef?: string;
  /** Decrease ratio above which the change is flagged. Default per D-21: 0.20. */
  readonly thresholdRatio?: number;
  /** Files to check. If empty, infers from `git diff --name-only`. */
  readonly files?: readonly string[];
}

interface AssertionCounts {
  readonly assertions: number;
  readonly skips: number;
}

/**
 * AST-diff weakening detection: for each changed *.test.ts / *.spec.ts
 * file, count `expect(...)` calls and skip/todo annotations before and
 * after the change, flag if the after-count drops by more than the
 * threshold ratio.
 *
 * The default threshold is a 20% decrease. Reports
 * one finding per drift; the overall status is 'fail' if any finding
 * exceeds threshold, 'review' if any decrease at all, 'pass' otherwise.
 */
export function senseTestWeakening(opts: TestWeakeningOptions): SensorReading {
  const baseRef = opts.baseRef ?? 'HEAD~1';
  const threshold = opts.thresholdRatio ?? 0.2;
  const command = ['devai', 'sense', 'test-weakening', '--base-ref', baseRef];

  let changedFiles: string[];
  if (opts.files !== undefined && opts.files.length > 0) {
    changedFiles = [...opts.files];
  } else {
    try {
      // Phase 29.E (D-A-29): explicitly redirect stderr to silence
      // git's `fatal: path '...' exists on disk, but not in 'HEAD~1'`
      // line that leaks through to the parent in some Node versions.
      const out = execFileSync(
        'git',
        ['diff', '--name-only', baseRef, '--', '*.test.ts', '*.spec.ts'],
        {
          cwd: opts.cwd,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      );
      changedFiles = out.split('\n').filter((f) => f.length > 0);
    } catch (err) {
      return buildSensorReading({
        sensorName: 'test-weakening',
        sensorKind: 'test_weakening_review',
        command,
        status: 'error',
        deterministic: true,
        findings: [
          {
            severity: 'critical',
            code: 'git_diff_failed',
            message: err instanceof Error ? err.message : String(err),
          },
        ],
      });
    }
  }

  const findings: SensorFinding[] = [];
  let totalDrift = 0;
  for (const file of changedFiles) {
    let baseText = '';
    try {
      // Phase 29.E (D-A-29): explicitly silence stderr so the
      // `fatal: path '...' exists on disk, but not in 'HEAD~1'` line
      // for brand-new test files doesn't leak past the catch.
      baseText = execFileSync('git', ['show', `${baseRef}:${file}`], {
        cwd: opts.cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      // New file: nothing to compare against; skip silently.
      continue;
    }
    let headText = '';
    try {
      headText = readFileSync(`${opts.cwd}/${file}`, 'utf8');
    } catch {
      continue;
    }
    const before = countAssertions(baseText);
    const after = countAssertions(headText);
    const decrease = before.assertions - after.assertions;
    const ratio = before.assertions > 0 ? decrease / before.assertions : 0;
    const skipDelta = after.skips - before.skips;
    if (ratio > threshold || decrease >= 1) {
      totalDrift++;
      findings.push({
        severity: ratio > threshold ? 'error' : 'warning',
        code: ratio > threshold ? 'unjustified_weakening' : 'weakening',
        message: `assertions ${String(before.assertions)} → ${String(after.assertions)} (decrease ratio ${ratio.toFixed(2)}); skip delta ${String(skipDelta)}`,
        file,
      });
    }
  }

  const errorCount = findings.filter(
    (f) => f.severity === 'error' || f.severity === 'critical',
  ).length;
  const status: SensorStatus = errorCount > 0 ? 'fail' : findings.length > 0 ? 'review' : 'pass';

  return buildSensorReading({
    sensorName: 'test-weakening',
    sensorKind: 'test_weakening_review',
    command,
    status,
    deterministic: true,
    findings,
    metrics: { files_checked: changedFiles.length, drift_count: totalDrift },
    // Phase 30.D (closes W-2): include timestamp in id so every
    // invocation produces a distinct SR file. Stynx U5 reported
    // F3×T9 oscillating UNKNOWN/PASS — caused by content-addressed
    // SRs overwriting each other on identical state. Forcing
    // unique ids means every run leaves an audit-trail entry.
    forceUniqueId: true,
  });
}

function countAssertions(source: string): AssertionCounts {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  let assertions = 0;
  let skips = 0;
  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && expr.text === 'expect') assertions++;
      if (ts.isPropertyAccessExpression(expr)) {
        const obj = expr.expression;
        if (ts.isIdentifier(obj) && (obj.text === 'it' || obj.text === 'describe')) {
          if (expr.name.text === 'skip' || expr.name.text === 'todo' || expr.name.text === 'only') {
            skips++;
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  return { assertions, skips };
}
