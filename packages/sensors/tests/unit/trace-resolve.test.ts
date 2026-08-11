// Invariants: INV-DEVAI-001
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { senseTraceResolve } from '../../src/trace-resolve.js';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixture(tests: Array<{ path?: string; target_type?: 'test' | 'script' }>): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-trace-resolve-'));
  fixtureRoots.push(root);
  mkdirSync(join(root, 'law/invariants'), { recursive: true });
  writeFileSync(join(root, 'law/invariants/INV-TEST-001.json'), '{}\n');
  writeFileSync(
    join(root, 'law/trace.json'),
    `${JSON.stringify({ invariants: [{ id: 'INV-TEST-001', tests }] }, null, 2)}\n`,
  );
  return root;
}

describe('senseTraceResolve trace non-vacuity', () => {
  it('fails closed when the trace file is absent', () => {
    const root = makeFixture([]);
    rmSync(join(root, 'law/trace.json'));

    const reading = senseTraceResolve({ repoRoot: root });
    expect(reading.status).toBe('error');
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ severity: 'critical', code: 'no_trace' }),
    );
  });

  it('does not count an invariant with no linked targets as traced', () => {
    const reading = senseTraceResolve({ repoRoot: makeFixture([]) });

    expect(reading.status).toBe('review');
    expect(reading.metrics).toMatchObject({
      invariants_total: 1,
      traced_invariants: 0,
      untraced_invariants: 1,
    });
    expect(reading.findings).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'untraced_invariant',
      }),
    );
  });

  it('fails when the invariant catalog is unavailable', () => {
    const root = makeFixture([]);
    rmSync(join(root, 'law/invariants'), { recursive: true });

    const reading = senseTraceResolve({ repoRoot: root });
    expect(reading.status).toBe('fail');
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ severity: 'critical', code: 'invariant_catalog_unavailable' }),
    );
  });

  it.each([
    ['../../outside.test.ts', 'traversal'],
    ['tests', 'directory'],
  ])('fails for a %s trace target', (path, _kind) => {
    const root = makeFixture([{ path }]);
    mkdirSync(join(root, 'tests'), { recursive: true });
    const reading = senseTraceResolve({ repoRoot: root });

    expect(reading.status).toBe('fail');
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'invalid_test_path' }),
    );
  });

  it('fails when an otherwise valid executable test path is not tracked', () => {
    const root = makeFixture([{ path: 'tests/example.test.ts' }]);
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests/example.test.ts'), 'export {};\n');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', 'law'], { cwd: root });

    const reading = senseTraceResolve({ repoRoot: root });
    expect(reading.status).toBe('fail');
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'invalid_test_path' }),
    );
  });
});
