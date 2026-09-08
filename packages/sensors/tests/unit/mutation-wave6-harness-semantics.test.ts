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
  const root = mkdtempSync(join(tmpdir(), 'devai-wave6-coherence-'));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, contents: string): void {
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(root + sep)) throw new Error('fixture path escaped root');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

describe('wave6 concurrency declaration semantics', () => {
  it('does not treat job-level concurrency as a top-level declaration', () => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/ci.yml',
      `jobs:
  build:
    concurrency:
      group: ci
      cancel-in-progress: true
    steps:
      - run: echo ok
`,
    );

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(reading.metrics).toMatchObject({ workflow_count: 1, concurrency_semantic_issues: 1 });
    expect(reading.status).toBe('review');
  });

  it('does not treat an unknown concurrency-group key as the policy declaration', () => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/ci.yml',
      `concurrency-group:
  group: ci
  cancel-in-progress: true
jobs:
  build:
    steps:
      - run: echo ok
`,
    );

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(reading.metrics?.concurrency_semantic_issues).toBe(1);
    expect(reading.status).toBe('review');
  });

  it('accepts a final concurrency block when the file has no trailing newline', () => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/ci.yml',
      `jobs:
  build:
    steps:
      - run: echo ok
concurrency:
  group: ci
  cancel-in-progress: true`,
    );

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(reading.metrics).toMatchObject({ workflow_count: 1, concurrency_semantic_issues: 0 });
    expect(reading.status).toBe('pass');
  });
});

describe('wave6 serialized trigger semantics', () => {
  it('requires cancel false for a standard scheduled workflow', () => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/ci.yml',
      `on:
  schedule:
    - cron: '0 0 * * *'
concurrency:
  group: ci
  cancel-in-progress: false
jobs:
  build:
    steps:
      - run: echo ok
`,
    );

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(reading.metrics?.concurrency_semantic_issues).toBe(0);
    expect(reading.status).toBe('pass');
  });

  it('does not treat an unknown schedule-disabled key as a scheduled trigger', () => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/ci.yml',
      `on:
  schedule-disabled:
    - cron: '0 0 * * *'
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  build:
    steps:
      - run: echo ok
`,
    );

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(reading.metrics?.concurrency_semantic_issues).toBe(0);
    expect(reading.status).toBe('pass');
  });
});

describe('wave6 score accumulation and thresholds', () => {
  it('keeps two independent incoherence contributions at review under the default bound', () => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/ci-a.yml',
      `permissions:
  contents: read
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  build:
    steps:
      - uses: actions/checkout@v1
`,
    );
    write(
      root,
      '.github/workflows/ci-b.yml',
      `concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  build:
    steps:
      - uses: actions/checkout@v2
`,
    );

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(reading.metrics).toMatchObject({
      workflow_count: 2,
      action_version_drift_count: 1,
      permissions_mixed: 1,
      incoherence_score: 2,
    });
    expect(reading.status).toBe('review');
  });

  it('increments semantic issues rather than decrementing them', () => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/ci.yml',
      `concurrency:
  group: ci
  cancel-in-progress: false
jobs:
  build:
    steps:
      - run: echo ok
`,
    );

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(reading.metrics).toMatchObject({ concurrency_semantic_issues: 1, incoherence_score: 1 });
    expect(reading.status).toBe('review');
  });

  it('keeps a score equal to the configured review limit in review', () => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/ci.yml',
      `concurrency:\n  group: ci\n  cancel-in-progress: false\njobs:\n  build:\n    steps:\n      - run: echo ok\n`,
    );

    const reading = senseHarnessCoherence({ repoRoot: root, maxReviewIncoherence: 1, now: NOW });
    expect(reading.metrics?.incoherence_score).toBe(1);
    expect(reading.status).toBe('review');
  });
});
