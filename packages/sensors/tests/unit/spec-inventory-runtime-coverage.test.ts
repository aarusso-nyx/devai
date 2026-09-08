import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SensorReading } from '../../src/sensor-reading.js';
import { senseSpecAlignment } from '../../src/spec-alignment.js';
import { senseSpecPerformanceTargets } from '../../src/spec-performance-targets.js';

const NOW = '2026-09-08T12:00:00.000Z';

const roots: string[] = [];
const denied = vi.hoisted(() => new Set<string>());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (denied.has(String(args[0])))
        throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' });
      return actual.readFileSync(...args);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (denied.has(String(args[0])))
        throw Object.assign(new Error('fixture directory denied'), { code: 'EACCES' });
      return actual.readdirSync(...args);
    },
  };
});

afterEach(() => {
  denied.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-spec-inventory-'));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, contents = 'export const value = 1;\n'): string {
  const path = resolve(root, rel);
  if (!path.startsWith(resolve(root) + sep)) throw new Error('fixture path escapes root');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function writeJson(root: string, rel: string, value: unknown): string {
  return write(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

/** Write `law/invariants/<id>.json` carrying the given `scope.code_areas[]`. */
function invariant(root: string, name: string, body: Record<string, unknown>): string {
  return writeJson(root, join('law/invariants', `${name}.json`), body);
}

/** Inject one exact-path read failure, independent of the runner user. */
function denyRead(path: string): void {
  denied.add(path);
}

function codes(reading: SensorReading): readonly string[] {
  return (reading.findings ?? []).map((finding) => finding.code);
}

function findingFor(reading: SensorReading, code: string) {
  return (reading.findings ?? []).find((finding) => finding.code === code);
}

describe('senseSpecAlignment forward scan, reverse scan and reading envelope', () => {
  it('passes with the full reading envelope when both scans are clean', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-1', { id: 'INV-1', scope: { code_areas: ['packages/demo/src/**'] } });
    write(root, 'packages/demo/src/index.ts');
    write(root, 'packages/demo/src/util.ts');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    expect(reading.schemaVersion).toBe('1.0.0');
    expect(reading.sensor).toEqual({ name: 'spec-alignment', kind: 'spec_alignment' });
    expect(reading.command).toBe('devai sense-spec-alignment');
    expect(reading.command_hash).toBe(
      createHash('sha256').update('devai sense-spec-alignment').digest('hex'),
    );
    expect(reading.tier).toBe('L0');
    expect(reading.deterministic).toBe(true);
    expect(reading.timestamp).toBe(NOW);
    expect(reading.id).toMatch(/^SR-[0-9a-f]{16}$/);
    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toEqual({
      invariants_scanned: 1,
      invariants_broken_forward: 0,
      source_files_scanned: 2,
      source_files_claimed: 2,
      reverse_pct: 100,
      reverse_threshold_pct: 80,
    });
  });

  it('fails with one finding per invariant whose every code area matches zero files', () => {
    const root = fixtureRoot();
    const stale = invariant(root, 'INV-STALE', {
      id: 'INV-STALE',
      scope: { code_areas: ['packages/gone/src/**', 'packages/also-gone/entry.ts'] },
    });
    invariant(root, 'INV-OK', { id: 'INV-OK', scope: { code_areas: ['packages/demo/src/**'] } });
    write(root, 'packages/demo/src/index.ts');
    // Unclaimed by every invariant: reverse is 50 %, well below the default 80 %.
    write(root, 'packages/other/src/orphan.ts');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('fail');
    // Forward failure suppresses the reverse-threshold finding entirely.
    expect(reading.findings).toEqual([
      {
        severity: 'error',
        code: 'SPEC_ALIGNMENT_INVARIANT_HAS_NO_MATCHING_FILES',
        message: 'Invariant INV-STALE has zero matching files for any of its scope.code_areas[].',
        file: stale,
      },
    ]);
    expect(reading.metrics).toEqual({
      invariants_scanned: 2,
      invariants_broken_forward: 1,
      source_files_scanned: 2,
      source_files_claimed: 1,
      reverse_pct: 50,
      reverse_threshold_pct: 80,
    });
  });

  it('keeps an invariant when at least one of its code areas matches', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-MIXED', {
      id: 'INV-MIXED',
      scope: { code_areas: ['packages/deleted/src/**', 'packages/demo/src/**'] },
    });
    write(root, 'packages/demo/src/index.ts');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics?.invariants_broken_forward).toBe(0);
  });

  it('does not flag invariants that declare no code areas at all', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-EMPTY', { id: 'INV-EMPTY', scope: { code_areas: [] } });
    invariant(root, 'INV-NO-SCOPE', { id: 'INV-NO-SCOPE' });
    write(root, 'packages/demo/src/index.ts');

    const reading = senseSpecAlignment({ repoRoot: root, reverseThresholdPct: 0, now: NOW });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toEqual({
      invariants_scanned: 2,
      invariants_broken_forward: 0,
      source_files_scanned: 1,
      source_files_claimed: 0,
      reverse_pct: 0,
      reverse_threshold_pct: 0,
    });
  });

  it('falls back to the invariant filename when the record carries no id', () => {
    const root = fixtureRoot();
    invariant(root, 'anonymous', { scope: { code_areas: ['packages/gone/**'] } });

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    expect(findingFor(reading, 'SPEC_ALIGNMENT_INVARIANT_HAS_NO_MATCHING_FILES')?.message).toBe(
      'Invariant anonymous.json has zero matching files for any of its scope.code_areas[].',
    );
  });

  it('skips unparsable JSON and non-JSON entries in the invariants directory', () => {
    const root = fixtureRoot();
    write(root, 'law/invariants/broken.json', '{ not json');
    write(root, 'law/invariants/notes.md', 'code_areas: packages/gone/**');
    invariant(root, 'INV-1', { id: 'INV-1', scope: { code_areas: ['packages/demo/src/**'] } });
    write(root, 'packages/demo/src/index.ts');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('pass');
    expect(reading.metrics?.invariants_scanned).toBe(1);
  });

  it('treats a missing invariants directory and an empty plant as a pass', () => {
    const root = fixtureRoot();

    const reading = senseSpecAlignment({ repoRoot: root, reverseThresholdPct: 100, now: NOW });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toEqual({
      invariants_scanned: 0,
      invariants_broken_forward: 0,
      source_files_scanned: 0,
      source_files_claimed: 0,
      reverse_pct: 100,
      reverse_threshold_pct: 100,
    });
  });

  it('reports the reverse shortfall with the claimed ratio in the finding message', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-1', {
      id: 'INV-1',
      scope: { code_areas: ['packages/demo/src/claimed.ts'] },
    });
    write(root, 'packages/demo/src/claimed.ts');
    write(root, 'packages/demo/src/orphan-a.ts');
    write(root, 'packages/demo/src/orphan-b.ts');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'SPEC_ALIGNMENT_REVERSE_BELOW_THRESHOLD',
        message: 'Reverse-claim ratio 33.3% is below threshold 80% (1 / 3 source files claimed).',
      },
    ]);
    expect(reading.metrics?.reverse_pct).toBe(33.33);
    expect(reading.metrics?.source_files_claimed).toBe(1);
  });

  it('honours an adopter-supplied reverse threshold on both sides of the boundary', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-1', {
      id: 'INV-1',
      scope: { code_areas: ['packages/demo/src/claimed.ts'] },
    });
    write(root, 'packages/demo/src/claimed.ts');
    write(root, 'packages/demo/src/orphan.ts');

    const below = senseSpecAlignment({ repoRoot: root, reverseThresholdPct: 50, now: NOW });
    const above = senseSpecAlignment({ repoRoot: root, reverseThresholdPct: 51, now: NOW });

    expect(below.status).toBe('pass');
    expect(below.metrics?.reverse_threshold_pct).toBe(50);
    expect(above.status).toBe('review');
    expect(findingFor(above, 'SPEC_ALIGNMENT_REVERSE_BELOW_THRESHOLD')?.message).toBe(
      'Reverse-claim ratio 50.0% is below threshold 51% (1 / 2 source files claimed).',
    );
  });

  it('matches literal code areas by stat and flags literal paths that no longer exist', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-FILE', {
      id: 'INV-FILE',
      scope: { code_areas: ['packages/demo/src/index.ts'] },
    });
    invariant(root, 'INV-MISSING', {
      id: 'INV-MISSING',
      scope: { code_areas: ['packages/demo/src/removed.ts'] },
    });
    write(root, 'packages/demo/src/index.ts');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('fail');
    expect(reading.findings?.map((finding) => finding.message)).toEqual([
      'Invariant INV-MISSING has zero matching files for any of its scope.code_areas[].',
    ]);
  });

  it('does not let a single-star code area match nested files', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-SHALLOW', {
      id: 'INV-SHALLOW',
      scope: { code_areas: ['packages/demo/src/*'] },
    });
    write(root, 'packages/demo/src/nested/deep.ts');

    const shallow = senseSpecAlignment({ repoRoot: root, now: NOW });
    expect(shallow.status).toBe('fail');
    expect(shallow.metrics?.source_files_claimed).toBe(0);

    write(root, 'packages/demo/src/top.ts');
    const withTopLevel = senseSpecAlignment({ repoRoot: root, now: NOW });
    expect(withTopLevel.status).toBe('review');
    expect(withTopLevel.metrics?.source_files_claimed).toBe(1);
  });

  it('escapes regex metacharacters when compiling code-area globs', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-DOT', {
      id: 'INV-DOT',
      scope: { code_areas: ['packages/demo/src/*.ts'] },
    });
    write(root, 'packages/demo/src/index.ts');
    // `axts` only matches if the `.` in the glob is treated as a wildcard.
    write(root, 'packages/demo/src/axts');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    expect(reading.metrics?.source_files_scanned).toBe(1);
    expect(reading.metrics?.source_files_claimed).toBe(1);
    expect(reading.status).toBe('pass');
  });

  it('compiles globs containing parentheses without throwing', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-PAREN', {
      id: 'INV-PAREN',
      scope: { code_areas: ['packages/demo/src/*(1).ts'] },
    });
    write(root, 'packages/demo/src/copy(1).ts');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    expect(reading.metrics?.source_files_claimed).toBe(1);
    expect(reading.status).toBe('pass');
  });

  it('excludes node_modules, .git, dist and build from the walked trees', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-1', { id: 'INV-1', scope: { code_areas: ['packages/demo/src/**'] } });
    write(root, 'packages/demo/src/index.ts');
    write(root, 'packages/demo/src/node_modules/dep/index.ts');
    write(root, 'packages/demo/src/dist/index.js');
    write(root, 'packages/demo/src/build/index.js');
    write(root, 'packages/demo/src/.git/config', '[core]\n');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    expect(reading.metrics?.source_files_scanned).toBe(1);
    expect(reading.status).toBe('pass');
  });

  it('expands the packages/* wildcard segment and ignores non-directory entries', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-1', { id: 'INV-1', scope: { code_areas: ['packages/*/src/**'] } });
    write(root, 'packages/alpha/src/a.ts');
    write(root, 'packages/beta/src/b.ts');
    write(root, 'packages/alpha/tests/a.test.ts');
    write(root, 'packages/README.md', '# packages\n');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    expect(reading.metrics?.source_files_scanned).toBe(2);
    expect(reading.metrics?.source_files_claimed).toBe(2);
    expect(reading.status).toBe('pass');
    expect(reading.metrics?.invariants_broken_forward).toBe(0);
  });

  it('filters wildcard segment entries by the glob rather than accepting every sibling', () => {
    const root = fixtureRoot();
    write(root, 'packages/demo-a/src/a.ts');
    write(root, 'packages/demo-b/src/b.ts');
    write(root, 'packages/other/src/c.ts');

    const reading = senseSpecAlignment({
      repoRoot: root,
      sourceGlobs: ['packages/demo-*/src/**'],
      reverseThresholdPct: 0,
      now: NOW,
    });

    expect(reading.metrics?.source_files_scanned).toBe(2);
  });

  it('supports a leading wildcard segment and a literal source-glob prefix', () => {
    const root = fixtureRoot();
    write(root, 'alpha/src/a.ts');
    write(root, 'beta/src/b.ts');
    write(root, 'apps/web/routes.tsx');

    const leading = senseSpecAlignment({
      repoRoot: root,
      sourceGlobs: ['*/src/**'],
      reverseThresholdPct: 0,
      now: NOW,
    });
    const literal = senseSpecAlignment({
      repoRoot: root,
      sourceGlobs: ['apps/web/**'],
      reverseThresholdPct: 0,
      now: NOW,
    });

    expect(leading.metrics?.source_files_scanned).toBe(2);
    expect(literal.metrics?.source_files_scanned).toBe(1);
  });

  it('skips source globs whose wildcard parent directory does not exist', () => {
    const root = fixtureRoot();
    write(root, 'packages/demo/src/index.ts');

    const reading = senseSpecAlignment({
      repoRoot: root,
      sourceGlobs: ['missing/*/src/**', 'packages/*/src/**'],
      now: NOW,
    });

    expect(reading.metrics?.source_files_scanned).toBe(1);
  });

  it('resolves a relative repoRoot against the working directory', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-1', { id: 'INV-1', scope: { code_areas: ['packages/demo/src/**'] } });
    write(root, 'packages/demo/src/index.ts');

    const absolute = senseSpecAlignment({ repoRoot: root, now: NOW });
    const viaRelative = senseSpecAlignment({
      repoRoot: relative(process.cwd(), root),
      now: NOW,
    });

    expect(viaRelative.metrics).toEqual(absolute.metrics);
    expect(viaRelative.status).toBe('pass');
    expect(viaRelative.id).toBe(absolute.id);
  });

  it('survives unreadable invariant and source directories', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-1', { id: 'INV-1', scope: { code_areas: ['packages/demo/src/**'] } });
    write(root, 'packages/demo/src/index.ts');
    write(root, 'packages/demo/src/locked/hidden.ts');
    denyRead(join(root, 'packages/demo/src/locked'));

    const withLockedSource = senseSpecAlignment({ repoRoot: root, now: NOW });
    expect(withLockedSource.metrics?.source_files_scanned).toBe(1);
    expect(withLockedSource.status).toBe('pass');

    denyRead(join(root, 'law/invariants'));
    const withLockedInvariants = senseSpecAlignment({ repoRoot: root, now: NOW });
    expect(withLockedInvariants.metrics?.invariants_scanned).toBe(0);
    expect(withLockedInvariants.status).toBe('review');
  });

  it('rejects malformed code areas rather than treating characters as paths', () => {
    for (const codeAreas of ['packages/demo/src/**', [42], null, {}]) {
      const root = fixtureRoot();
      invariant(root, 'INV-INVALID', { id: 'INV-INVALID', scope: { code_areas: codeAreas } });
      write(root, 'packages/demo/src/index.ts');
      const reading = senseSpecAlignment({ repoRoot: root, now: NOW });
      expect(reading.metrics?.invariants_broken_forward).toBe(1);
      expect(reading.metrics?.source_files_claimed).toBe(0);
      expect(reading.status).toBe('fail');
      expect(codes(reading)).toEqual(['SPEC_ALIGNMENT_INVALID_CODE_AREAS']);
    }
  });

  it('derives a stable id from the findings and a fresh timestamp by default', () => {
    const root = fixtureRoot();
    invariant(root, 'INV-1', { id: 'INV-1', scope: { code_areas: ['packages/demo/src/**'] } });
    write(root, 'packages/demo/src/index.ts');

    const first = senseSpecAlignment({ repoRoot: root, now: NOW });
    const second = senseSpecAlignment({ repoRoot: root, now: '2027-01-01T00:00:00.000Z' });
    expect(second.id).toBe(first.id);
    expect(second.timestamp).toBe('2027-01-01T00:00:00.000Z');

    const untimed = senseSpecAlignment({ repoRoot: root });
    expect(untimed.timestamp).not.toBe(NOW);
    expect(Number.isNaN(Date.parse(untimed.timestamp))).toBe(false);

    invariant(root, 'INV-STALE', { id: 'INV-STALE', scope: { code_areas: ['packages/gone/**'] } });
    const failing = senseSpecAlignment({ repoRoot: root, now: NOW });
    expect(failing.id).not.toBe(first.id);
  });
});

describe('senseSpecPerformanceTargets signal counting and status boundaries', () => {
  it('passes with the full reading envelope when both signals are present', () => {
    const root = fixtureRoot();
    writeJson(root, 'law/invariants/PERF-1.json', { id: 'PERF-1', type: 'performance' });
    write(root, 'product/use-cases/checkout.md', '- p95 latency under 200 ms at steady state\n');

    const reading = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });

    expect(reading.schemaVersion).toBe('1.0.0');
    expect(reading.sensor).toEqual({
      name: 'spec-performance-targets',
      kind: 'spec_performance_targets',
    });
    expect(reading.command).toBe('devai sense-spec-performance-targets');
    expect(reading.command_hash).toBe(
      createHash('sha256').update('devai sense-spec-performance-targets').digest('hex'),
    );
    expect(reading.tier).toBe('L0');
    expect(reading.deterministic).toBe(true);
    expect(reading.timestamp).toBe(NOW);
    expect(reading.id).toMatch(/^SR-[0-9a-f]{16}$/);
    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toEqual({
      perf_invariants: 1,
      perf_use_cases: 1,
      targets_total: 2,
      perf_relevant_code_detected: 0,
    });
  });

  it('fails when there are no invariants, no use-cases and no perf-relevant code', () => {
    const root = fixtureRoot();
    write(root, 'packages/demo/src/index.ts');
    write(root, 'product/use-cases/checkout.md', 'The checkout flow should feel quick.\n');

    const reading = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('fail');
    expect(reading.findings).toEqual([
      {
        severity: 'error',
        code: 'SPEC_PERFORMANCE_NO_TARGETS',
        message: 'No perf invariants, no perf use-cases, no perf-relevant code areas detected.',
      },
    ]);
    expect(reading.metrics).toEqual({
      perf_invariants: 0,
      perf_use_cases: 0,
      targets_total: 0,
      perf_relevant_code_detected: 0,
    });
  });

  it('reviews perf-relevant code with no invariants ahead of the other warnings', () => {
    const root = fixtureRoot();
    write(root, 'packages/demo/src/_probes/latency-probe.ts');
    write(root, 'product/use-cases/checkout.md', 'Acceptance: throughput of 1000 rps.\n');

    const reading = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'SPEC_PERFORMANCE_NO_INVARIANTS_BUT_PERF_CODE',
        message:
          'No type=performance invariants but perf-relevant code paths detected (probes/bench).',
      },
    ]);
    expect(reading.metrics).toEqual({
      perf_invariants: 0,
      perf_use_cases: 1,
      targets_total: 1,
      perf_relevant_code_detected: 1,
    });
  });

  it('reviews a perf invariant that no use-case backs', () => {
    const root = fixtureRoot();
    writeJson(root, 'law/invariants/PERF-1.json', { id: 'PERF-1', type: 'performance' });
    write(root, 'product/use-cases/checkout.md', 'The user completes checkout.\n');

    const reading = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'SPEC_PERFORMANCE_NO_USE_CASES',
        message: 'No use-case acceptance criteria mentioning latency/throughput.',
      },
    ]);
    expect(reading.metrics?.targets_total).toBe(1);
  });

  it('reviews perf use-cases that no invariant backs', () => {
    const root = fixtureRoot();
    writeJson(root, 'law/invariants/SEC-1.json', { id: 'SEC-1', type: 'security' });
    write(root, 'product/use-cases/checkout.md', 'Acceptance: p99 latency under budget.\n');

    const reading = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(codes(reading)).toEqual(['SPEC_PERFORMANCE_NO_INVARIANTS']);
    expect(findingFor(reading, 'SPEC_PERFORMANCE_NO_INVARIANTS')?.message).toBe(
      'Use-cases mention perf but no type=performance invariants.',
    );
    expect(reading.metrics).toEqual({
      perf_invariants: 0,
      perf_use_cases: 1,
      targets_total: 1,
      perf_relevant_code_detected: 0,
    });
  });

  it('honours adopter-raised signal requirements', () => {
    const root = fixtureRoot();
    writeJson(root, 'law/invariants/PERF-1.json', { id: 'PERF-1', type: 'performance' });
    write(root, 'product/use-cases/checkout.md', 'Acceptance: p95 latency < 200ms.\n');

    const raised = senseSpecPerformanceTargets({
      repoRoot: root,
      signalsRequired: { invariants: 2, use_cases: 1 },
      now: NOW,
    });
    const met = senseSpecPerformanceTargets({
      repoRoot: root,
      signalsRequired: { invariants: 1, use_cases: 1 },
      now: NOW,
    });

    expect(raised.status).toBe('review');
    // Every warning branch is guarded on a zero count, so a shortfall against a
    // raised requirement produces a REVIEW carrying no explanatory finding.
    expect(raised.findings).toEqual([]);
    expect(met.status).toBe('pass');
  });

  it('passes an empty repository when the adopter requires no signals', () => {
    const root = fixtureRoot();

    const reading = senseSpecPerformanceTargets({
      repoRoot: root,
      signalsRequired: { invariants: 0, use_cases: 0 },
      now: NOW,
    });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toEqual({
      perf_invariants: 0,
      perf_use_cases: 0,
      targets_total: 0,
      perf_relevant_code_detected: 0,
    });
  });

  it('counts use-case text that names a concrete latency or throughput target', () => {
    for (const text of [
      'p95 under budget',
      'p999 tail budget',
      'Latency budget agreed',
      'sustained THROUGHPUT target',
      'responds in 200 ms',
      'responds in 200ms',
      'handles 1000 rps',
      'handles 50 tps',
      'handles 30 qps',
    ]) {
      const root = fixtureRoot();
      write(root, 'product/use-cases/case.md', `${text}\n`);
      const reading = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });
      expect(reading.metrics?.perf_use_cases, text).toBe(1);
    }
  });

  it('ignores use-case text that only gestures at speed', () => {
    for (const text of [
      'the page should be fast',
      'p9 is not a percentile',
      'measured in milliseconds',
      'drains the 500 msg backlog',
      'no numbers, just vibes',
    ]) {
      const root = fixtureRoot();
      write(root, 'product/use-cases/case.md', `${text}\n`);
      const reading = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });
      expect(reading.metrics?.perf_use_cases, text).toBe(0);
    }
  });

  it('counts only .md and .json use-case files, case-insensitively', () => {
    const root = fixtureRoot();
    write(root, 'product/use-cases/a.md', 'p95 latency\n');
    write(root, 'product/use-cases/b.MD', 'p95 latency\n');
    writeJson(root, 'product/use-cases/c.json', { acceptance: ['p95 latency < 200 ms'] });
    write(root, 'product/use-cases/d.txt', 'p95 latency\n');
    write(root, 'product/use-cases/NOTES', 'p95 latency\n');
    // The extension test is anchored at the end of the path, so a `.md` that is
    // not the final extension does not count.
    write(root, 'product/use-cases/legacy.md.bak', 'p95 latency\n');

    const reading = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });

    expect(reading.metrics?.perf_use_cases).toBe(3);
  });

  it('walks every configured use-case directory recursively and sums the counts', () => {
    const root = fixtureRoot();
    write(root, 'product/use-cases/checkout/flow.md', 'p95 latency\n');
    write(root, 'docs/flows/search.md', 'throughput target\n');
    write(root, 'docs/flows/ignored/note.txt', 'latency\n');

    const reading = senseSpecPerformanceTargets({
      repoRoot: root,
      useCaseDirs: ['product/use-cases', 'docs/flows', 'product/missing'],
      now: NOW,
    });

    expect(reading.metrics?.perf_use_cases).toBe(2);
  });

  it('skips use-case files it cannot read', () => {
    const root = fixtureRoot();
    write(root, 'product/use-cases/readable.md', 'p95 latency\n');
    const locked = write(root, 'product/use-cases/locked.md', 'p95 latency\n');
    denyRead(locked);

    const reading = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });

    expect(reading.metrics?.perf_use_cases).toBe(1);
  });

  it('counts only top-level type=performance invariant files', () => {
    const root = fixtureRoot();
    writeJson(root, 'law/invariants/PERF-1.json', { id: 'PERF-1', type: 'performance' });
    writeJson(root, 'law/invariants/PERF-2.json', { id: 'PERF-2', type: 'performance' });
    writeJson(root, 'law/invariants/SEC-1.json', { id: 'SEC-1', type: 'security' });
    writeJson(root, 'law/invariants/SEC-2.json', { id: 'SEC-2', type: 'security' });
    writeJson(root, 'law/invariants/UNTYPED.json', { id: 'UNTYPED' });
    write(root, 'law/invariants/broken.json', '{ not json');
    // Valid JSON body, wrong extension: the `.json` filter is what excludes it.
    writeJson(root, 'law/invariants/PERF-3.md', { id: 'PERF-3', type: 'performance' });
    writeJson(root, 'law/invariants/nested/PERF-4.json', { id: 'PERF-4', type: 'performance' });
    // A directory whose name ends in .json: reading it throws and is skipped.
    mkdirSync(join(root, 'law/invariants/dir.json'), { recursive: true });

    const reading = senseSpecPerformanceTargets({
      repoRoot: root,
      signalsRequired: { invariants: 1, use_cases: 0 },
      now: NOW,
    });

    expect(reading.metrics?.perf_invariants).toBe(2);
    expect(reading.status).toBe('pass');
  });

  it('reads invariants from an adopter-supplied directory and tolerates unreadable ones', () => {
    const root = fixtureRoot();
    writeJson(root, 'spec/laws/PERF-1.json', { id: 'PERF-1', type: 'performance' });
    write(root, 'product/use-cases/checkout.md', 'p95 latency\n');

    const custom = senseSpecPerformanceTargets({
      repoRoot: root,
      invariantsDir: 'spec/laws',
      now: NOW,
    });
    expect(custom.status).toBe('pass');
    expect(custom.metrics?.perf_invariants).toBe(1);

    // The default directory does not exist here, so the count is zero.
    const defaulted = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });
    expect(defaulted.metrics?.perf_invariants).toBe(0);

    denyRead(join(root, 'spec/laws'));
    const locked = senseSpecPerformanceTargets({
      repoRoot: root,
      invariantsDir: 'spec/laws',
      now: NOW,
    });
    expect(locked.metrics?.perf_invariants).toBe(0);
    expect(locked.status).toBe('review');
  });

  it('detects every default perf-signal pattern and honours custom ones', () => {
    for (const rel of [
      'packages/demo/src/_probes/probe.ts',
      'packages/demo/src/index.bench.ts',
      'packages/demo/src/index.perf.spec.ts',
    ]) {
      const root = fixtureRoot();
      write(root, rel);
      const reading = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });
      expect(reading.metrics?.perf_relevant_code_detected, rel).toBe(1);
      expect(reading.status, rel).toBe('review');
      expect(codes(reading), rel).toEqual(['SPEC_PERFORMANCE_NO_INVARIANTS_BUT_PERF_CODE']);
    }

    const root = fixtureRoot();
    write(root, 'benchmarks/load.ts');
    expect(senseSpecPerformanceTargets({ repoRoot: root, now: NOW }).status).toBe('fail');
    expect(
      senseSpecPerformanceTargets({
        repoRoot: root,
        perfSignalPatterns: ['/benchmarks/'],
        now: NOW,
      }).metrics?.perf_relevant_code_detected,
    ).toBe(1);
  });

  it('ignores perf signals buried in node_modules, dist and build trees', () => {
    const root = fixtureRoot();
    write(root, 'node_modules/dep/_probes/probe.ts');
    write(root, 'dist/_probes/probe.js');
    write(root, 'build/index.bench.js');
    // The same walker feeds the use-case scan, which has no second
    // node_modules guard: a vendored use-case must not be counted either.
    write(root, 'product/use-cases/node_modules/vendored.md', 'p95 latency under 200 ms\n');

    const reading = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });

    expect(reading.metrics?.perf_relevant_code_detected).toBe(0);
    expect(reading.metrics?.perf_use_cases).toBe(0);
    expect(reading.status).toBe('fail');
  });

  it('derives a stable id from the findings and a fresh timestamp by default', () => {
    const root = fixtureRoot();
    writeJson(root, 'law/invariants/PERF-1.json', { id: 'PERF-1', type: 'performance' });
    write(root, 'product/use-cases/checkout.md', 'p95 latency\n');

    const first = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });
    const second = senseSpecPerformanceTargets({
      repoRoot: root,
      now: '2027-01-01T00:00:00.000Z',
    });
    expect(second.id).toBe(first.id);

    const untimed = senseSpecPerformanceTargets({ repoRoot: root });
    expect(untimed.timestamp).not.toBe(NOW);
    expect(Number.isNaN(Date.parse(untimed.timestamp))).toBe(false);

    rmSync(join(root, 'product/use-cases'), { recursive: true, force: true });
    const reviewing = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });
    expect(reviewing.id).not.toBe(first.id);
  });
});
