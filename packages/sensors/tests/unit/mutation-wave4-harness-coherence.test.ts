import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { senseHarnessCoherence } from '../../src/harness-coherence.js';

const NOW = '2026-09-08T12:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-wave4-coherence-'));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, contents: string): void {
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(root + sep)) throw new Error('fixture path escaped root');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

const validConcurrency = `concurrency:
  group: ci-${'${{ github.ref }}'}
  cancel-in-progress: true
jobs:
  build:
    steps:
      - run: echo ok
`;

describe('wave4 concurrency declaration boundaries', () => {
  it('accepts the ordinary top-level concurrency spelling', () => {
    const root = fixtureRoot();
    write(root, '.github/workflows/ci.yml', validConcurrency);

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(reading.metrics).toMatchObject({ concurrency_semantic_issues: 0, workflow_count: 1 });
    expect(reading.status).toBe('pass');
  });
});

describe('wave4 empty population and reference filtering', () => {
  it('reviews an empty workflow population with deterministic metadata', () => {
    const reading = senseHarnessCoherence({ repoRoot: fixtureRoot(), now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.deterministic).toBe(true);
    expect(reading.metrics).toMatchObject({ workflow_count: 0, incoherence_score: 0 });
    expect(reading.findings?.[0]?.code).toBe('HARNESS_COHERENCE_NO_WORKFLOWS');
  });

  it('excludes local and unpinned references from action-version drift', () => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/a.yml',
      `jobs:
  check:
    steps:
      - uses: actions/checkout
      - uses: actions/checkout@v4
      - uses: ./.github/actions/local@v1
`,
    );
    write(
      root,
      '.github/workflows/b.yml',
      `jobs:
  check:
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/local@v2
`,
    );

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(reading.metrics).toMatchObject({ workflow_count: 2, action_version_drift_count: 0 });
    expect(
      reading.findings?.some(
        (finding) => finding.code === 'HARNESS_COHERENCE_ACTION_VERSION_DRIFT',
      ),
    ).toBe(false);
  });
});

describe('wave4 all-present policy populations', () => {
  it('does not mark permissions as mixed when every ci workflow declares it', () => {
    const root = fixtureRoot();
    for (const name of ['ci-a.yml', 'ci-b.yml']) {
      write(
        root,
        `.github/workflows/${name}`,
        `permissions:
  contents: read
jobs:
  build:
    steps:
      - run: echo ok
`,
      );
    }

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(reading.metrics).toMatchObject({ workflow_count: 2, permissions_mixed: 0 });
    expect(
      reading.findings?.some((finding) => finding.code === 'HARNESS_COHERENCE_PERMISSIONS_MIXED'),
    ).toBe(false);
  });

  it('keeps all-present concurrency policy populations clean at exact zero score', () => {
    const root = fixtureRoot();
    for (const name of ['ci-a.yml', 'ci-b.yml'])
      write(root, `.github/workflows/${name}`, validConcurrency);

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(reading.metrics).toMatchObject({
      workflow_count: 2,
      concurrency_mixed: 0,
      concurrency_semantic_issues: 0,
      incoherence_score: 0,
    });
    expect(
      reading.findings?.some((finding) => finding.code === 'HARNESS_COHERENCE_CONCURRENCY_MIXED'),
    ).toBe(false);
    expect(reading.status).toBe('pass');
  });
});
