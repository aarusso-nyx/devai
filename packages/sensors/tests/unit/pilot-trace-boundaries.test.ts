import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { senseTraceResolve } from '../../src/trace-resolve.js';

let root = '';

function git(...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(invariantNames: string[], trace: unknown, trackedTests: string[] = []): void {
  root = mkdtempSync(join(tmpdir(), 'devai-pilot-trace-'));
  mkdirSync(join(root, 'law/invariants'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  for (const name of invariantNames) {
    writeFileSync(join(root, 'law/invariants', name), '{}\n');
  }
  for (const path of trackedTests) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, 'export {};\n');
  }
  writeJson(join(root, 'law/trace.json'), trace);
  git('init', '-q');
  if (trackedTests.length > 0) git('add', '--', ...trackedTests);
  git('add', '--', 'law');
  git('commit', '-qm', 'fixture');
}

async function sense() {
  return withAuthorityHostTestScope(() => senseTraceResolve({ repoRoot: root }));
}

beforeEach(() => {
  root = '';
});

afterEach(() => {
  if (root.length > 0) rmSync(root, { recursive: true, force: true });
});

describe('trace resolution pilot boundaries', () => {
  it('passes with tracked tests and catalogs only exact INV-*.json filenames', async () => {
    fixture(
      [
        'INV-ALPHA.json',
        'INV-BETA.json',
        'INV-ALPHA.json.bak',
        'inv-lower.json',
        'xINV-GAMMA.json',
      ],
      {
        invariants: [
          { id: 'INV-ALPHA', tests: [{ path: 'tests/alpha.test.ts' }] },
          { id: 'INV-BETA', tests: [{ path: 'tests/beta.test.ts' }] },
        ],
      },
      ['tests/alpha.test.ts', 'tests/beta.test.ts'],
    );

    const reading = await sense();
    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toMatchObject({
      invariants_total: 2,
      traced_invariants: 2,
      untraced_invariants: 0,
      missing_test_paths: 0,
      unresolved_trace_entries: 0,
    });
  });

  it('requires an executing test link when completeness requires test links', async () => {
    fixture(
      ['INV-ATTEST.json'],
      {
        meta: { completeness: { require_test_links: true } },
        invariants: [
          {
            id: 'INV-ATTEST',
            tests: [{ path: 'tests/config.json', target_type: 'config-attestation' }],
          },
        ],
      },
      ['tests/config.json'],
    );

    const reading = await sense();
    expect(reading.status).toBe('review');
    expect(reading.metrics).toMatchObject({
      invariants_total: 1,
      traced_invariants: 0,
      untraced_invariants: 1,
      attestation_only_invariants: 1,
    });
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'untraced_invariant' }),
    );
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ severity: 'info', code: 'attestation_only_invariant' }),
    );
  });

  it('reports invalid, untracked, and directory targets while retaining valid links', async () => {
    fixture(
      ['INV-TARGETS.json'],
      {
        invariants: [
          {
            id: 'INV-TARGETS',
            tests: [
              { path: 'tests/linked.test.ts' },
              { path: 'tests/untracked.test.ts' },
              { path: 'tests' },
              { path: '../outside.test.ts' },
            ],
          },
        ],
      },
      ['tests/linked.test.ts'],
    );
    writeFileSync(join(root, 'tests/untracked.test.ts'), 'export {};\n');

    const reading = await sense();
    expect(reading.status).toBe('fail');
    expect(reading.metrics).toMatchObject({
      traced_invariants: 1,
      missing_test_paths: 3,
      unresolved_trace_entries: 0,
    });
    expect(
      reading.findings?.filter((finding) => finding.code === 'invalid_test_path'),
    ).toHaveLength(3);
  });

  it('fails closed and preserves unresolved entries when the catalog cannot be read', async () => {
    fixture(['INV-MISSING.json'], { invariants: [{ id: 'INV-MISSING', tests: [] }] });
    rmSync(join(root, 'law/invariants'), { recursive: true, force: true });

    const reading = await sense();
    expect(reading.status).toBe('fail');
    expect(reading.metrics).toMatchObject({
      invariants_total: 0,
      unresolved_trace_entries: 1,
      untraced_invariants: 0,
    });
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ severity: 'critical', code: 'invariant_catalog_unavailable' }),
    );
  });

  it('treats an attestation-only trace as passing when test links are optional', async () => {
    fixture(
      ['INV-ATTEST.json'],
      {
        invariants: [
          {
            id: 'INV-ATTEST',
            tests: [{ path: 'tests/config.json', target_type: 'config-attestation' }],
          },
        ],
      },
      ['tests/config.json'],
    );

    const reading = await sense();
    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({
      traced_invariants: 1,
      untraced_invariants: 0,
      attestation_only_invariants: 1,
    });
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ severity: 'info', code: 'attestation_only_invariant' }),
    );
  });
});
