import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { senseSpecAlignment } from '../../src/spec-alignment.js';
import { senseSpecPerformanceTargets } from '../../src/spec-performance-targets.js';

const NOW = '2026-09-08T12:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-spec-inventory-red-'));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, contents = 'export const value = 1;\n'): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writeJson(root: string, rel: string, value: unknown): void {
  write(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

describe('round23 D1 — forward scan cannot expand a glob whose wildcard is not the last segment', () => {
  it('does not call packages/*/src/** stale when files exist under it', () => {
    const root = fixtureRoot();
    writeJson(root, 'law/invariants/INV-1.json', {
      id: 'INV-1',
      scope: { code_areas: ['packages/*/src/**'] },
    });
    write(root, 'packages/alpha/src/index.ts');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    // The same run's reverse scan claims the file with this very glob, so the
    // sensor simultaneously reports "claimed by an invariant" and "invariant
    // matches zero files". Only the forward direction is wrong.
    expect(reading.metrics?.source_files_claimed).toBe(1);
    expect(reading.metrics?.invariants_broken_forward).toBe(0);
    expect(reading.status).toBe('pass');
  });

  it('does not call packages/demo/src/*.ts stale when a matching file exists', () => {
    const root = fixtureRoot();
    writeJson(root, 'law/invariants/INV-1.json', {
      id: 'INV-1',
      scope: { code_areas: ['packages/demo/src/*.ts'] },
    });
    write(root, 'packages/demo/src/index.ts');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    expect(reading.metrics?.invariants_broken_forward).toBe(0);
    expect(reading.status).toBe('pass');
  });
});

describe('round23 D2 — reverse scan denominator is every file, not source modules', () => {
  it('does not count fixtures and markdown under src/ as unclaimed source files', () => {
    const root = fixtureRoot();
    writeJson(root, 'law/invariants/INV-1.json', {
      id: 'INV-1',
      scope: { code_areas: ['packages/demo/src/index.ts'] },
    });
    write(root, 'packages/demo/src/index.ts');
    // Non-module payloads that the design note excludes from the reverse scan.
    write(root, 'packages/demo/src/__fixtures__/sample.json', '{ "a": 1 }\n');
    write(root, 'packages/demo/src/README.md', '# demo\n');
    write(root, 'packages/demo/src/logo.svg', '<svg/>\n');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    expect(reading.metrics?.source_files_scanned).toBe(1);
    expect(reading.metrics?.reverse_pct).toBe(100);
    expect(reading.status).toBe('pass');
  });
});

describe('round23 D3 — a literal code area that holds no files still counts as matched', () => {
  it('flags an invariant whose literal code area is an empty directory', () => {
    const root = fixtureRoot();
    writeJson(root, 'law/invariants/INV-EMPTY-DIR.json', {
      id: 'INV-EMPTY-DIR',
      scope: { code_areas: ['packages/demo/src/legacy'] },
    });
    mkdirSync(join(root, 'packages/demo/src/legacy'), { recursive: true });
    write(root, 'packages/demo/src/index.ts');

    const reading = senseSpecAlignment({ repoRoot: root, now: NOW });

    // The claim resolves to zero files on disk, which the note defines as
    // broken-forward; `statSync` on the surviving directory hides it.
    expect(reading.metrics?.invariants_broken_forward).toBe(1);
    expect(reading.status).toBe('fail');
  });
});

describe('round23 D4 — perf keywords are matched anywhere in the file, not in the criteria', () => {
  it('does not count a use-case whose acceptance criteria name no perf target', () => {
    const root = fixtureRoot();
    writeJson(root, 'law/invariants/PERF-1.json', { id: 'PERF-1', type: 'performance' });
    writeJson(root, 'product/use-cases/checkout.json', {
      id: 'UC-CHECKOUT',
      title: 'Checkout',
      description: 'Motivated by a customer complaint about p95 latency at peak.',
      preconditions: ['the cart is non-empty'],
      acceptance: ['the order is persisted', 'a receipt is emailed'],
    });

    const reading = senseSpecPerformanceTargets({ repoRoot: root, now: NOW });

    // Narrative prose is not an acceptance criterion; counting it turns a
    // REVIEW ("perf invariant with no use-case backing") into a PASS.
    expect(reading.metrics?.perf_use_cases).toBe(0);
    expect(reading.status).toBe('review');
  });
});

it('deduplicates overlapping source globs and honors nested wildcard and extension filters', () => {
  const root = fixtureRoot();
  writeJson(root, 'law/invariants/INV-1.json', {
    id: 'INV-1',
    scope: { code_areas: ['packages/*/src/*/deep/*.ts'] },
  });
  write(root, 'packages/a/src/nested/deep/one.ts');
  write(root, 'packages/a/src/nested/deep/other.js');
  write(root, 'packages/a/src/nested/deep/note.md');
  const reading = senseSpecAlignment({
    repoRoot: root,
    sourceGlobs: ['packages/*/src/*/deep/*.ts', 'packages/a/src/nested/deep/one.ts'],
    now: NOW,
  });
  expect(reading.status).toBe('pass');
  expect(reading.metrics?.source_files_scanned).toBe(1);
  expect(reading.metrics?.source_files_claimed).toBe(1);
});

it('derives performance relevance only from paths inside the repository', () => {
  const parent = fixtureRoot();
  for (const directory of ['_probes/checkout', 'node_modules/checkout']) {
    const root = join(parent, directory);
    write(root, 'src/index.ts');
    expect(
      senseSpecPerformanceTargets({ repoRoot: root, now: NOW }).metrics
        ?.perf_relevant_code_detected,
    ).toBe(0);
    write(root, 'src/_probes/latency.ts');
    expect(
      senseSpecPerformanceTargets({ repoRoot: root, now: NOW }).metrics
        ?.perf_relevant_code_detected,
    ).toBe(1);
  }
});

it('counts only string criteria in structured use cases, once per file', () => {
  const root = fixtureRoot();
  writeJson(root, 'product/use-cases/a.json', {
    acceptance: ['p95 < 200ms', 'throughput > 1000rps'],
    preconditions: ['latency measured'],
  });
  writeJson(root, 'product/use-cases/b.JSON', { preconditions: ['p99 < 500ms'] });
  writeJson(root, 'product/use-cases/c.json', {
    acceptance: 'p95 < 100ms',
    preconditions: [42, { text: 'latency' }],
  });
  writeJson(root, 'product/use-cases/d.json', null);
  write(root, 'product/use-cases/e.json', 'bad JSON p95 latency');
  expect(senseSpecPerformanceTargets({ repoRoot: root, now: NOW }).metrics?.perf_use_cases).toBe(2);
});
