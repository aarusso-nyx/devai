import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { senseTestInvariantAlignment } from '../../src/test-invariant-alignment.js';

const NOW = '2026-09-08T12:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-alignment-pilot-'));
  roots.push(root);
  return root;
}

function writeJson(root: string, relativePath: string, value: unknown): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('test invariant alignment boundary pilot', () => {
  it('fails with a precise no-trace finding and zero metrics when the default trace is missing', () => {
    const root = fixtureRoot();

    const reading = senseTestInvariantAlignment({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'fail',
      sensor: { name: 'test-invariant-alignment', kind: 'test_invariant_alignment' },
      deterministic: true,
      tier: 'L0',
      timestamp: NOW,
      metrics: { invariant_count: 0, unaligned_count: 0 },
      findings: [
        {
          severity: 'error',
          code: 'TEST_INVARIANT_ALIGNMENT_NO_TRACE',
          message: `trace.json not found at ${resolve(root, 'law/trace.json')}`,
        },
      ],
    });
  });

  it('fails malformed JSON as an unavailable trace substrate', () => {
    const root = fixtureRoot();
    const tracePath = join(root, 'law/trace.json');
    mkdirSync(dirname(tracePath), { recursive: true });
    writeFileSync(tracePath, '{not-json');

    const reading = senseTestInvariantAlignment({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('fail');
    expect(reading.metrics).toEqual({ invariant_count: 0, unaligned_count: 0 });
    expect(reading.findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'TEST_INVARIANT_ALIGNMENT_NO_TRACE',
      }),
    ]);
  });

  it('resolves both the default relative trace and an explicit absolute trace', () => {
    const root = fixtureRoot();
    const tracePath = writeJson(root, 'law/trace.json', {
      invariants: [
        { id: 'INV-ALIGNED-001', tests: ['packages/sensors/tests/unit/example.test.ts'] },
      ],
    });

    const relative = senseTestInvariantAlignment({ repoRoot: root, now: NOW });
    const absolute = senseTestInvariantAlignment({ repoRoot: root, tracePath, now: NOW });

    expect(relative).toMatchObject({
      status: 'pass',
      timestamp: NOW,
      metrics: { invariant_count: 1, unaligned_count: 0 },
      findings: [],
    });
    expect(absolute).toMatchObject({
      status: 'pass',
      timestamp: NOW,
      metrics: { invariant_count: 1, unaligned_count: 0 },
      findings: [],
    });
  });

  it('reviews an empty trace and emits its dedicated finding', () => {
    const root = fixtureRoot();
    writeJson(root, 'law/trace.json', { invariants: [] });

    const reading = senseTestInvariantAlignment({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'review',
      metrics: { invariant_count: 0, unaligned_count: 0 },
      findings: [
        {
          severity: 'warning',
          code: 'TEST_INVARIANT_ALIGNMENT_EMPTY_TRACE',
          message: 'trace.json contains zero invariants.',
        },
      ],
    });
  });

  it('reviews each invariant with missing or empty tests and counts both as unaligned', () => {
    const root = fixtureRoot();
    writeJson(root, 'law/trace.json', {
      invariants: [
        { id: 'INV-ALIGNED-001', tests: ['test/one.test.ts'] },
        { id: 'INV-EMPTY-002', tests: [] },
        { id: 'INV-MISSING-003' },
        { tests: [] },
      ],
    });

    const reading = senseTestInvariantAlignment({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.metrics).toEqual({ invariant_count: 4, unaligned_count: 3 });
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'TEST_INVARIANT_ALIGNMENT_EMPTY_TESTS',
        message: 'Invariant INV-EMPTY-002 has no tests[] entries in trace.json.',
      },
      {
        severity: 'warning',
        code: 'TEST_INVARIANT_ALIGNMENT_EMPTY_TESTS',
        message: 'Invariant INV-MISSING-003 has no tests[] entries in trace.json.',
      },
      {
        severity: 'warning',
        code: 'TEST_INVARIANT_ALIGNMENT_EMPTY_TESTS',
        message: 'Invariant <unknown> has no tests[] entries in trace.json.',
      },
    ]);
  });
});
