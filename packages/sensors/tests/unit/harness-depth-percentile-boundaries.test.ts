import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { senseHarnessDepth } from '../../src/harness-depth.js';

const NOW = '2026-09-09T12:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-harness-depth-'));
  roots.push(value);
  return value;
}

function workflow(repo: string, body: string, name = 'main.yml'): void {
  const dir = join(repo, '.github', 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

function job(name: string, steps: number, matrix = false): string {
  const lines = [`  ${name}:`];
  if (matrix) {
    lines.push(
      '    strategy:',
      '      matrix:',
      '        os: [ubuntu, windows]',
      '        node: [18, 20, 22]',
    );
  }
  lines.push('    steps:');
  for (let index = 0; index < steps; index += 1) lines.push(`      - run: echo step-${index}`);
  return lines.join('\n');
}

describe('harness depth percentile boundaries', () => {
  it('fails distinctly for no workflows, no jobs, and a job with zero steps', () => {
    const noWorkflows = senseHarnessDepth({ repoRoot: root(), now: NOW });
    expect(noWorkflows).toMatchObject({
      status: 'fail',
      findings: [{ code: 'HARNESS_DEPTH_NO_JOBS', message: 'No workflows found.' }],
    });

    const noJobs = root();
    workflow(noJobs, 'name: empty\n');
    expect(senseHarnessDepth({ repoRoot: noJobs, now: NOW })).toMatchObject({
      status: 'fail',
      metrics: { workflow_count: 1, jobs_count: 0 },
      findings: [{ code: 'HARNESS_DEPTH_NO_JOBS', message: 'No jobs across all workflows.' }],
    });

    const zeroSteps = root();
    workflow(zeroSteps, 'name: empty-job\njobs:\n  build:\n    steps: []\n');
    expect(senseHarnessDepth({ repoRoot: zeroSteps, now: NOW })).toMatchObject({
      status: 'fail',
      metrics: { workflow_count: 1, jobs_count: 1, steps_p95: 0, steps_median: 0 },
      findings: [{ code: 'HARNESS_DEPTH_EMPTY', message: 'Workflows have effectively no steps.' }],
    });
  });

  it('sorts a nonlexical step population for nearest-rank median and p95 and counts matrix combinations', () => {
    const repo = root();
    const counts = [20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10];
    workflow(
      repo,
      [
        'name: depth',
        'jobs:',
        ...counts.map((count, index) => job(`job${index}`, count, index === 0)),
      ].join('\n'),
    );

    const reading = senseHarnessDepth({ repoRoot: repo, now: NOW });

    expect(reading).toMatchObject({
      status: 'pass',
      timestamp: NOW,
      command: 'devai sense-harness-depth',
      metrics: {
        workflow_count: 1,
        jobs_count: 20,
        steps_p95: 19,
        steps_median: 10,
        total_matrix_combinations: 6,
        threshold_pass: 3,
      },
      findings: [],
    });
  });

  it('honors a custom exact pass threshold while default threshold produces review', () => {
    const repo = root();
    workflow(repo, ['name: shallow', 'jobs:', job('build', 2)].join('\n'));

    expect(senseHarnessDepth({ repoRoot: repo, now: NOW })).toMatchObject({
      status: 'review',
      metrics: { steps_p95: 2, steps_median: 2, threshold_pass: 3 },
      findings: [
        {
          code: 'HARNESS_DEPTH_THIN',
          message: '95th-percentile step count 2 below PASS threshold 3.',
        },
      ],
    });
    expect(senseHarnessDepth({ repoRoot: repo, thresholds: { pass: 2 }, now: NOW })).toMatchObject({
      status: 'pass',
      metrics: { steps_p95: 2, threshold_pass: 2 },
      findings: [],
    });
  });
});
