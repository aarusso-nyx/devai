import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { senseHarnessIdiomaticity } from '../../src/harness-idiomaticity.js';

const roots: string[] = [];
const NOW = '2026-09-08T12:00:00.000Z';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-wave30-harness-idiomaticity-'));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, content: string): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function workflow(uses: readonly string[]): string {
  return `name: fixture
jobs:
  check:
    steps:
${uses.map((use) => `      - uses: ${use}`).join('\n')}
`;
}

describe('harness idiomaticity axis population', () => {
  it('counts composite, reusable, and cache signals across every workflow', () => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/first.yml',
      workflow([
        './.github/actions/build',
        './.github/actions/test',
        './.github/workflows/reusable.yml@main',
        'actions/cache@v4',
      ]),
    );
    write(
      root,
      '.github/workflows/second.yml',
      workflow(['./.github/actions/deploy', './.github/workflows/reusable.yml@main']),
    );

    const reading = senseHarnessIdiomaticity({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'pass',
      timestamp: NOW,
      metrics: {
        workflow_count: 2,
        composite_action_uses: 3,
        reusable_workflow_uses: 2,
        cache_present: 1,
        idiomaticity_score: 3,
      },
    });
    expect(reading.findings).toEqual([]);
  });

  it('reports all absent axes as a failed populated observation', () => {
    const root = fixtureRoot();
    write(root, '.github/workflows/first.yml', workflow([]));
    write(root, '.github/workflows/second.yml', workflow([]));

    const reading = senseHarnessIdiomaticity({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'fail',
      metrics: {
        workflow_count: 2,
        composite_action_uses: 0,
        reusable_workflow_uses: 0,
        cache_present: 0,
        idiomaticity_score: 0,
      },
    });
    expect(reading.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'HARNESS_IDIOMATICITY_NO_COMPOSITE_ACTIONS' }),
        expect.objectContaining({ code: 'HARNESS_IDIOMATICITY_NO_REUSABLE_WORKFLOWS' }),
        expect.objectContaining({ code: 'HARNESS_IDIOMATICITY_NO_CACHE' }),
      ]),
    );
  });

  it('checks reusable workflows at the exact configured workflow-count boundary', () => {
    const root = fixtureRoot();
    write(
      root,
      '.github/workflows/first.yml',
      workflow(['./.github/actions/build', 'actions/cache@v4']),
    );
    write(
      root,
      '.github/workflows/second.yml',
      workflow(['./.github/actions/test', 'actions/cache@v4']),
    );

    const reading = senseHarnessIdiomaticity({
      repoRoot: root,
      minWorkflowsForReusableCheck: 2,
      now: NOW,
    });

    expect(reading).toMatchObject({
      status: 'review',
      metrics: {
        workflow_count: 2,
        composite_action_uses: 2,
        reusable_workflow_uses: 0,
        cache_present: 1,
        idiomaticity_score: 2,
      },
    });
    expect(reading.findings).toContainEqual(
      expect.objectContaining({ code: 'HARNESS_IDIOMATICITY_NO_REUSABLE_WORKFLOWS' }),
    );
  });
});
