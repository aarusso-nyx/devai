/**
 * Behaviour coverage for three exported inventory sensors that read only the
 * filesystem: `harness_coherence` (F5×T3), `harness_security` (F5×T6) and
 * `plant_coherence` (F2×T3).
 *
 * None of the three reaches a host seam, so every case builds a real tree under
 * a per-case `mkdtemp` root and asserts the exact status, findings and metrics
 * of the returned SensorReading. The fixture writer refuses any path that
 * resolves outside its temporary root, and faults are injected by content or by
 * absence (missing directory, wrong extension, unparseable block) rather than
 * by changing file modes.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { senseHarnessCoherence } from '../../src/harness-coherence.js';
import { jobEffectFacts } from '../../src/harness/workflow-parser.js';
import { senseHarnessSecurity } from '../../src/harness-security.js';
import { sensePlantCoherence } from '../../src/plant-coherence.js';
import type { SensorFinding, SensorReading } from '../../src/sensor-reading.js';

const NOW = '2026-09-08T12:00:00.000Z';
/** A real 40-character lowercase hex object name. */
const SHA = 'a'.repeat(8) + 'b'.repeat(8) + '0'.repeat(8) + 'f'.repeat(8) + '9'.repeat(8);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `devai-${prefix}-`));
  roots.push(root);
  return root;
}

/** Write inside `root` only; a traversing relative path is refused outright. */
function write(root: string, rel: string, contents: string): string {
  const path = resolve(root, rel);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`fixture writer refused a path outside ${root}: ${rel}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

/** Complete candidate source for the ordinary observation command used below. */
function coherenceRoot(): string {
  const root = fixtureRoot('harness-coherence');
  write(
    root,
    'package.json',
    JSON.stringify({ private: true, scripts: { test: 'node scripts/read-only.cjs' } }),
  );
  write(
    root,
    'scripts/read-only.cjs',
    [
      "const { readFileSync } = require('node:fs');",
      "const { resolve } = require('node:path');",
      "const assert = require('node:assert/strict');",
      "const manifest = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));",
      'assert.equal(manifest.private, true);',
      "assert.equal(manifest.scripts.test, 'node scripts/read-only.cjs');",
      '',
    ].join('\n'),
  );
  return root;
}

function findings(reading: SensorReading): SensorFinding[] {
  return reading.findings ?? [];
}

function codes(reading: SensorReading): string[] {
  return findings(reading).map((f) => f.code);
}

interface WorkflowSpec {
  /** Trigger block body, indented two spaces. Default: a plain push trigger. */
  readonly on?: string;
  /** Top-level permissions block, or `null` for none. */
  readonly permissions?: string | null;
  /** Top-level concurrency block, or `null` for none. */
  readonly concurrency?: string | null;
  /** Step lines (already indented six spaces). */
  readonly steps?: readonly string[];
}

const SUPERSEDING = ['concurrency:', '  group: ci-${{ github.ref }}', '  cancel-in-progress: true'];
const SERIALIZED = [
  'concurrency:',
  '  group: release-${{ github.ref }}',
  '  cancel-in-progress: false',
];

function workflow(spec: WorkflowSpec = {}): string {
  const lines = ['name: ci', 'on:', spec.on ?? '  push:\n    branches: [main]'];
  if (spec.permissions !== null) lines.push(spec.permissions ?? 'permissions:\n  contents: read');
  if (spec.concurrency !== null) lines.push(spec.concurrency ?? SUPERSEDING.join('\n'));
  lines.push('jobs:', '  build:', '    runs-on: ubuntu-latest', '    steps:');
  lines.push(
    ...(spec.steps ?? [`      - uses: actions/checkout@${SHA}`, '      - run: pnpm test']),
  );
  return `${lines.join('\n')}\n`;
}

describe('senseHarnessCoherence', () => {
  it('reports the no-workflow reading when the workflow directory is absent', () => {
    const root = coherenceRoot();

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.command).toBe('devai sense-harness-coherence');
    expect(reading.sensor).toEqual({ name: 'harness-coherence', kind: 'harness_coherence' });
    expect(reading.tier).toBe('L0');
    expect(reading.deterministic).toBe(true);
    expect(reading.timestamp).toBe(NOW);
    expect(findings(reading)).toEqual([
      {
        severity: 'info',
        code: 'HARNESS_COHERENCE_NO_WORKFLOWS',
        message: 'No workflows found.',
      },
    ]);
    expect(reading.metrics).toEqual({ workflow_count: 0, incoherence_score: 0 });
  });

  it('passes a single coherent workflow and reports the full metric set', () => {
    const root = coherenceRoot();
    write(root, '.github/workflows/ci.yml', workflow());

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('pass');
    expect(findings(reading)).toEqual([]);
    expect(reading.metrics).toEqual({
      workflow_count: 1,
      action_version_drift_count: 0,
      permissions_mixed: 0,
      concurrency_mixed: 0,
      concurrency_semantic_issues: 0,
      incoherence_score: 0,
      max_review_incoherence: 3,
    });
  });

  it('accepts cancel-in-progress: false only where the workflow serializes', () => {
    const root = coherenceRoot();
    // A release path serializes; a plain observation path supersedes.
    write(root, '.github/workflows/release.yml', workflow({ concurrency: SERIALIZED.join('\n') }));
    write(root, '.github/workflows/ci.yml', workflow());

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('pass');
    expect(findings(reading)).toEqual([]);
    expect(reading.metrics?.workflow_count).toBe(2);
    expect(reading.metrics?.concurrency_semantic_issues).toBe(0);
  });

  it('flags a release workflow that cancels in-progress runs', () => {
    const root = coherenceRoot();
    write(root, '.github/workflows/release.yml', workflow());

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(findings(reading)).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
        message:
          '.github/workflows/release.yml must declare a non-empty concurrency group with cancel-in-progress: false (serialized).',
      },
    ]);
    expect(reading.metrics?.concurrency_semantic_issues).toBe(1);
    expect(reading.metrics?.incoherence_score).toBe(1);
  });

  it('treats a top-level schedule trigger as serializing', () => {
    const root = coherenceRoot();
    write(
      root,
      '.github/workflows/nightly.yml',
      workflow({
        on: "  schedule:\n    - cron: '0 3 * * *'",
        concurrency: SERIALIZED.join('\n'),
      }),
    );

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('pass');
    expect(findings(reading)).toEqual([]);
  });

  it('does not treat a deeply indented schedule input as serializing', () => {
    const root = coherenceRoot();
    write(
      root,
      '.github/workflows/dispatch.yml',
      workflow({
        on: '  workflow_dispatch:',
        steps: [
          `      - uses: actions/checkout@${SHA}`,
          '        with:',
          "          schedule: '0 3 * * *'",
        ],
      }),
    );

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });

    // Serialization is a top-level trigger property: a step input named
    // `schedule` at six spaces must not flip the expected cancel semantics.
    expect(reading.status).toBe('pass');
    expect(findings(reading)).toEqual([]);
  });

  it('reports action-version drift once per action and ignores local and unpinned-ref uses', () => {
    const root = coherenceRoot();
    write(
      root,
      '.github/workflows/a-ci.yml',
      workflow({
        steps: [
          '      - uses: actions/checkout@v3',
          '      - uses: ./.github/actions/setup',
          '      - uses: actions/setup-node',
        ],
      }),
    );
    write(
      root,
      '.github/workflows/b-ci.yml',
      workflow({ steps: ['      - uses: actions/checkout@v4'] }),
    );
    write(
      root,
      '.github/actions/setup/action.yml',
      'name: setup\nruns:\n  using: composite\n  steps:\n    - run: pnpm test\n',
    );

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(findings(reading)).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_ACTION_VERSION_DRIFT',
        message: 'Action actions/checkout pinned to multiple versions across workflows: v3, v4',
      },
    ]);
    expect(reading.metrics?.action_version_drift_count).toBe(1);
    expect(reading.metrics?.workflow_count).toBe(2);
    expect(reading.metrics?.incoherence_score).toBe(1);
  });

  it('reports mixed permissions discipline and counts it once', () => {
    const root = coherenceRoot();
    write(root, '.github/workflows/a-ci.yml', workflow());
    write(root, '.github/workflows/b-ci.yml', workflow({ permissions: null }));

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(findings(reading)).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_PERMISSIONS_MIXED',
        message: '1 workflows declare permissions, 1 do not.',
      },
    ]);
    expect(reading.metrics?.permissions_mixed).toBe(1);
    expect(reading.metrics?.incoherence_score).toBe(1);
  });

  it('reports mixed concurrency as info and the missing block as a policy warning', () => {
    const root = coherenceRoot();
    write(root, '.github/workflows/a-ci.yml', workflow());
    write(root, '.github/workflows/b-ci.yml', workflow({ concurrency: null }));

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(findings(reading)).toEqual([
      {
        severity: 'info',
        code: 'HARNESS_COHERENCE_CONCURRENCY_MIXED',
        message: '1 workflows declare concurrency, 1 do not.',
      },
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
        message:
          '.github/workflows/b-ci.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
      },
    ]);
    expect(reading.metrics).toEqual({
      workflow_count: 2,
      action_version_drift_count: 0,
      permissions_mixed: 0,
      concurrency_mixed: 1,
      concurrency_semantic_issues: 1,
      incoherence_score: 1,
      max_review_incoherence: 3,
    });
  });

  it('rejects a concurrency block with no group and one with no cancel-in-progress', () => {
    const root = coherenceRoot();
    write(
      root,
      '.github/workflows/a-ci.yml',
      workflow({ concurrency: 'concurrency:\n  cancel-in-progress: true' }),
    );
    write(
      root,
      '.github/workflows/b-ci.yml',
      workflow({ concurrency: 'concurrency:\n  group: ci-${{ github.ref }}' }),
    );

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(codes(reading)).toEqual([
      'HARNESS_COHERENCE_CONCURRENCY_POLICY',
      'HARNESS_COHERENCE_CONCURRENCY_POLICY',
    ]);
    expect(findings(reading).map((f) => f.message)).toEqual([
      '.github/workflows/a-ci.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
      '.github/workflows/b-ci.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
    ]);
    expect(reading.metrics?.concurrency_mixed).toBe(0);
    expect(reading.metrics?.concurrency_semantic_issues).toBe(2);
  });

  it('rejects an inline concurrency scalar that carries no group or cancel semantics', () => {
    const root = coherenceRoot();
    write(root, '.github/workflows/ci.yml', workflow({ concurrency: 'concurrency: ci-inline' }));

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(codes(reading)).toEqual(['HARNESS_COHERENCE_CONCURRENCY_POLICY']);
    expect(reading.metrics?.concurrency_mixed).toBe(0);
    expect(reading.metrics?.concurrency_semantic_issues).toBe(1);
  });

  it('fails past the review budget and honours an explicit maxReviewIncoherence', () => {
    const root = coherenceRoot();
    for (const name of ['a', 'b', 'c', 'd']) {
      write(root, `.github/workflows/${name}-ci.yml`, workflow({ concurrency: null }));
    }

    const strict = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(strict.status).toBe('fail');
    expect(strict.metrics?.incoherence_score).toBe(4);
    expect(strict.metrics?.max_review_incoherence).toBe(3);

    const lenient = senseHarnessCoherence({
      repoRoot: root,
      maxReviewIncoherence: 4,
      now: NOW,
    });
    expect(lenient.status).toBe('review');
    expect(lenient.metrics?.max_review_incoherence).toBe(4);

    const zero = senseHarnessCoherence({ repoRoot: root, maxReviewIncoherence: 0, now: NOW });
    expect(zero.status).toBe('fail');
  });

  it('reads workflows from an explicit workflowDir', () => {
    const root = coherenceRoot();
    write(root, '.github/workflows/ci.yml', workflow({ concurrency: null }));
    write(root, 'ci/flows/ci.yml', workflow());

    const reading = senseHarnessCoherence({
      repoRoot: root,
      workflowDir: 'ci/flows',
      now: NOW,
    });

    expect(reading.status).toBe('pass');
    expect(reading.metrics?.workflow_count).toBe(1);
  });

  it('stamps its own timestamp when none is supplied', () => {
    const root = coherenceRoot();
    write(root, '.github/workflows/ci.yml', workflow());

    const reading = senseHarnessCoherence({ repoRoot: root });

    expect(reading.timestamp).not.toBe(NOW);
    expect(Number.isNaN(Date.parse(reading.timestamp))).toBe(false);
  });
});

describe('senseHarnessSecurity', () => {
  it('reports review with the scanned directory when no workflows exist', () => {
    const root = fixtureRoot('harness-security');

    const { reading, perFile } = senseHarnessSecurity({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.command).toBe('devai sense-harness-security');
    expect(reading.sensor).toEqual({ name: 'harness-security', kind: 'harness_security' });
    expect(reading.tier).toBe('L0');
    expect(reading.deterministic).toBe(true);
    expect(reading.timestamp).toBe(NOW);
    expect(findings(reading)).toEqual([
      {
        severity: 'info',
        code: 'HARNESS_SECURITY_NO_WORKFLOWS',
        message: `No workflows found at ${resolve(root, '.github/workflows')}.`,
      },
    ]);
    expect(reading.metrics).toEqual({
      workflow_count: 0,
      unpinned_action_count: 0,
      missing_permissions_block_count: 0,
      pwn_request_count: 0,
    });
    expect(perFile).toEqual([]);
  });

  it('passes a SHA-pinned workflow that declares permissions', () => {
    const root = fixtureRoot('harness-security');
    write(root, '.github/workflows/ci.yml', workflow());

    const { reading, perFile } = senseHarnessSecurity({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('pass');
    expect(findings(reading)).toEqual([]);
    expect(reading.metrics).toEqual({
      workflow_count: 1,
      unpinned_action_count: 0,
      missing_permissions_block_count: 0,
      pwn_request_count: 0,
    });
    expect(perFile).toEqual([
      {
        file: '.github/workflows/ci.yml',
        unpinnedActions: [],
        missingPermissionsBlock: false,
        pullRequestTargetWithCheckout: false,
      },
    ]);
  });

  it('reports every ref that is not an exact 40-character lowercase hex pin', () => {
    const root = fixtureRoot('harness-security');
    write(
      root,
      '.github/workflows/ci.yml',
      workflow({
        steps: [
          '      - uses: actions/checkout@v4',
          `      - uses: actions/setup-node@${SHA}f`,
          `      - uses: actions/cache@${SHA.toUpperCase()}`,
          `      - uses: actions/upload-artifact@${SHA}`,
        ],
      }),
    );

    const { reading, perFile } = senseHarnessSecurity({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(findings(reading)).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_SECURITY_UNPINNED_ACTION',
        message: 'Action used without SHA pin: actions/checkout@v4',
        file: '.github/workflows/ci.yml',
        line: 14,
      },
      {
        severity: 'warning',
        code: 'HARNESS_SECURITY_UNPINNED_ACTION',
        message: `Action used without SHA pin: actions/setup-node@${SHA}f`,
        file: '.github/workflows/ci.yml',
        line: 15,
      },
      {
        severity: 'warning',
        code: 'HARNESS_SECURITY_UNPINNED_ACTION',
        // An uppercase object name is a real pin that this scanner reports
        // anyway: the scanner is conservative on purpose (see the sensor's
        // header note), so the over-report is the pinned behaviour.
        message: `Action used without SHA pin: actions/cache@${SHA.toUpperCase()}`,
        file: '.github/workflows/ci.yml',
        line: 16,
      },
    ]);
    expect(reading.metrics?.unpinned_action_count).toBe(3);
    expect(perFile[0]?.unpinnedActions).toEqual([
      { line: 14, ref: 'actions/checkout@v4' },
      { line: 15, ref: `actions/setup-node@${SHA}f` },
      { line: 16, ref: `actions/cache@${SHA.toUpperCase()}` },
    ]);
  });

  it('does not treat a local action reference as a supply-chain finding', () => {
    const root = fixtureRoot('harness-security');
    write(
      root,
      '.github/workflows/ci.yml',
      workflow({
        steps: [
          '      - uses: ./.github/actions/setup@v1',
          '      - uses: ./.github/actions/build',
        ],
      }),
    );

    const { reading, perFile } = senseHarnessSecurity({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('pass');
    expect(findings(reading)).toEqual([]);
    expect(perFile[0]?.unpinnedActions).toEqual([]);
  });

  it('fails on the pull_request_target + checkout pwn-request pattern', () => {
    const root = fixtureRoot('harness-security');
    write(
      root,
      '.github/workflows/pr.yml',
      workflow({ on: '  pull_request_target:\n    types: [opened]' }),
    );

    const { reading, perFile } = senseHarnessSecurity({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('fail');
    expect(findings(reading)).toEqual([
      {
        severity: 'critical',
        code: 'HARNESS_SECURITY_PWN_REQUEST_PATTERN',
        message:
          'pull_request_target + actions/checkout in same workflow: pwn-request CVE pattern.',
        file: '.github/workflows/pr.yml',
      },
    ]);
    expect(reading.metrics?.pwn_request_count).toBe(1);
    expect(perFile[0]?.pullRequestTargetWithCheckout).toBe(true);
  });

  it('recognises the list form of the pull_request_target trigger', () => {
    const root = fixtureRoot('harness-security');
    write(root, '.github/workflows/pr.yml', workflow({ on: '  - pull_request_target\n  - push' }));

    const { reading } = senseHarnessSecurity({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('fail');
    expect(codes(reading)).toEqual(['HARNESS_SECURITY_PWN_REQUEST_PATTERN']);
    expect(reading.metrics?.pwn_request_count).toBe(1);
  });

  it('does not fail on pull_request_target without a checkout step', () => {
    const root = fixtureRoot('harness-security');
    write(
      root,
      '.github/workflows/pr.yml',
      workflow({
        on: '  pull_request_target:\n    types: [labeled]',
        steps: [`      - uses: actions/labeler@${SHA}`],
      }),
    );

    const { reading, perFile } = senseHarnessSecurity({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('pass');
    expect(findings(reading)).toEqual([]);
    expect(reading.metrics?.pwn_request_count).toBe(0);
    expect(perFile[0]?.pullRequestTargetWithCheckout).toBe(false);
  });

  it('reports a workflow with no permissions block per file', () => {
    const root = fixtureRoot('harness-security');
    write(root, '.github/workflows/a-ci.yml', workflow());
    write(root, '.github/workflows/b-ci.yml', workflow({ permissions: null }));

    const { reading, perFile } = senseHarnessSecurity({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(findings(reading)).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_SECURITY_MISSING_PERMISSIONS',
        message: 'Workflow has no top-level permissions block (defaults to repo-wide write).',
        file: '.github/workflows/b-ci.yml',
      },
    ]);
    expect(reading.metrics).toEqual({
      workflow_count: 2,
      unpinned_action_count: 0,
      missing_permissions_block_count: 1,
      pwn_request_count: 0,
    });
    expect(perFile.map((f) => f.missingPermissionsBlock)).toEqual([false, true]);
  });

  it('scans .yml and .yaml in sorted order and ignores other entries', () => {
    const root = fixtureRoot('harness-security');
    write(root, '.github/workflows/b-second.yaml', workflow());
    write(root, '.github/workflows/a-first.yml', workflow());
    write(root, '.github/workflows/README.md', '# not a workflow\n');
    write(root, '.github/workflows/notes.txt', 'uses: actions/checkout@v4\n');
    write(root, '.github/workflows/nested/deep.yml', workflow({ permissions: null }));

    const { reading, perFile } = senseHarnessSecurity({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('pass');
    expect(perFile.map((f) => f.file)).toEqual([
      '.github/workflows/a-first.yml',
      '.github/workflows/b-second.yaml',
    ]);
    expect(reading.metrics?.workflow_count).toBe(2);
  });

  it('accepts a relative workflowDir and an absolute one outside the repo root', () => {
    const root = fixtureRoot('harness-security');
    const outside = fixtureRoot('harness-security-out');
    write(root, 'ci/flows/ci.yml', workflow({ permissions: null }));
    const absolute = write(outside, 'flows/ci.yml', workflow());

    const relative = senseHarnessSecurity({
      repoRoot: root,
      workflowDir: 'ci/flows',
      now: NOW,
    });
    expect(relative.reading.status).toBe('review');
    expect(relative.perFile.map((f) => f.file)).toEqual(['ci/flows/ci.yml']);

    const external = senseHarnessSecurity({
      repoRoot: root,
      workflowDir: join(outside, 'flows'),
      now: NOW,
    });
    expect(external.reading.status).toBe('pass');
    // Outside the repo root there is nothing to strip: the path stays absolute.
    expect(external.perFile.map((f) => f.file)).toEqual([absolute]);
  });

  it('stamps its own timestamp when none is supplied', () => {
    const root = fixtureRoot('harness-security');
    write(root, '.github/workflows/ci.yml', workflow());

    const { reading } = senseHarnessSecurity({ repoRoot: root });

    expect(reading.timestamp).not.toBe(NOW);
    expect(Number.isNaN(Date.parse(reading.timestamp))).toBe(false);
  });
});

describe('sensePlantCoherence', () => {
  it('reports review when no source directory matches the globs', () => {
    const root = fixtureRoot('plant-coherence');

    const reading = sensePlantCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.command).toBe('devai sense-plant-coherence');
    expect(reading.sensor).toEqual({ name: 'plant-coherence', kind: 'plant_coherence' });
    expect(reading.tier).toBe('L0');
    expect(reading.deterministic).toBe(true);
    expect(reading.timestamp).toBe(NOW);
    expect(findings(reading)).toEqual([
      {
        severity: 'info',
        code: 'PLANT_COHERENCE_NO_DIRS',
        message: 'No source directories matched globs: packages/*/src/**',
      },
    ]);
    expect(reading.metrics).toEqual({
      dirs_scanned: 0,
      incoherent_dirs: 0,
      max_review_incoherent: 3,
    });
  });

  it('lists every configured glob in the no-directory finding', () => {
    const root = fixtureRoot('plant-coherence');

    const reading = sensePlantCoherence({
      repoRoot: root,
      sourceGlobs: ['apps/*/src/**', 'libs/*'],
      now: NOW,
    });

    expect(findings(reading)).toEqual([
      {
        severity: 'info',
        code: 'PLANT_COHERENCE_NO_DIRS',
        message: 'No source directories matched globs: apps/*/src/**, libs/*',
      },
    ]);
  });

  it('passes a tree whose directories each use one casing convention', () => {
    const root = fixtureRoot('plant-coherence');
    write(root, 'packages/alpha/src/sensor-reading.ts', 'export const a = 1;\n');
    write(root, 'packages/alpha/src/run-command.ts', 'export const b = 2;\n');
    write(root, 'packages/beta/src/components/UserCard.tsx', 'export const C = 3;\n');
    write(root, 'packages/beta/src/components/AdminCard.tsx', 'export const D = 4;\n');

    const reading = sensePlantCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('pass');
    expect(findings(reading)).toEqual([]);
    expect(reading.metrics).toEqual({
      dirs_scanned: 2,
      incoherent_dirs: 0,
      max_review_incoherent: 3,
    });
  });

  it('flags a directory that mixes two casing conventions', () => {
    const root = fixtureRoot('plant-coherence');
    write(root, 'packages/alpha/src/sensor-reading.ts', 'export const a = 1;\n');
    write(root, 'packages/alpha/src/sensorReading.ts', 'export const b = 2;\n');

    const reading = sensePlantCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.metrics).toEqual({
      dirs_scanned: 1,
      incoherent_dirs: 1,
      max_review_incoherent: 3,
    });
    const [finding] = findings(reading);
    expect(finding?.severity).toBe('warning');
    expect(finding?.code).toBe('PLANT_COHERENCE_MIXED_CASING');
    expect(finding?.file).toBe('packages/alpha/src');
    // The bucket order inside the message follows directory-read order, so the
    // pair is asserted as a set; the rest of the message is exact.
    const match = /^Directory packages\/alpha\/src mixes (.+) casing across 2 files\.$/u.exec(
      finding?.message ?? '',
    );
    expect(match).not.toBeNull();
    expect(new Set(match?.[1]?.split(' + '))).toEqual(new Set(['kebab', 'camel']));
  });

  it('separates pascal, snake, camel and kebab and ignores unclassifiable stems', () => {
    const root = fixtureRoot('plant-coherence');
    write(root, 'packages/a/src/pascal/kebab-case.ts', 'export const a = 1;\n');
    write(root, 'packages/a/src/pascal/PascalCase.ts', 'export const B = 2;\n');
    write(root, 'packages/a/src/snake/kebab-case.ts', 'export const c = 3;\n');
    write(root, 'packages/a/src/snake/snake_case.ts', 'export const d = 4;\n');
    write(root, 'packages/a/src/camel/kebab-case.ts', 'export const e = 5;\n');
    write(root, 'packages/a/src/camel/camelCase.ts', 'export const f = 6;\n');
    write(root, 'packages/a/src/other/kebab-case.ts', 'export const g = 7;\n');
    write(root, 'packages/a/src/other/kebab-case.test.ts', 'export const h = 8;\n');
    write(root, 'packages/a/src/other/Mixed_Weird.ts', 'export const i = 9;\n');

    const reading = sensePlantCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.metrics?.dirs_scanned).toBe(4);
    expect(reading.metrics?.incoherent_dirs).toBe(3);
    expect(
      findings(reading)
        .map((f) => f.file)
        ?.sort(),
    ).toEqual(['packages/a/src/camel', 'packages/a/src/pascal', 'packages/a/src/snake']);
  });

  it('counts only source files and skips declarations and non-source extensions', () => {
    const root = fixtureRoot('plant-coherence');
    write(root, 'packages/a/src/sensor-reading.ts', 'export const a = 1;\n');
    write(root, 'packages/a/src/sensorReading.tsx', 'export const b = 2;\n');
    write(root, 'packages/a/src/legacy.d.ts', 'export declare const c: number;\n');
    write(root, 'packages/a/src/README.md', '# notes\n');
    write(root, 'packages/a/src/config.json', '{}\n');

    const reading = sensePlantCoherence({ repoRoot: root, now: NOW });

    expect(reading.metrics?.dirs_scanned).toBe(1);
    expect(findings(reading)[0]?.message).toContain('casing across 2 files.');
  });

  it('recurses into nested directories and counts only those holding source files', () => {
    const root = fixtureRoot('plant-coherence');
    write(root, 'packages/a/src/deep/nested/leaf-one.ts', 'export const a = 1;\n');
    write(root, 'packages/a/src/deep/nested/leafTwo.ts', 'export const b = 2;\n');
    write(root, 'packages/a/src/deep/other/only-kebab.ts', 'export const c = 3;\n');
    // `packages/a/src` and `packages/a/src/deep` hold no source file of their own.
    mkdirSync(join(root, 'packages/a/src/empty'), { recursive: true });

    const reading = sensePlantCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(reading.metrics?.dirs_scanned).toBe(2);
    expect(reading.metrics?.incoherent_dirs).toBe(1);
    expect(findings(reading).map((f) => f.file)).toEqual(['packages/a/src/deep/nested']);
  });

  it('skips node_modules, .git, dist and build subtrees', () => {
    const root = fixtureRoot('plant-coherence');
    write(root, 'packages/a/src/only-kebab.ts', 'export const a = 1;\n');
    for (const skipped of ['node_modules', '.git', 'dist', 'build']) {
      write(root, `packages/a/src/${skipped}/mixed-case.ts`, 'export const b = 2;\n');
      write(root, `packages/a/src/${skipped}/mixedCase.ts`, 'export const c = 3;\n');
    }

    const reading = sensePlantCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('pass');
    expect(findings(reading)).toEqual([]);
    expect(reading.metrics?.dirs_scanned).toBe(1);
  });

  it('expands a single wildcard segment across siblings', () => {
    const root = fixtureRoot('plant-coherence');
    write(root, 'packages/alpha/src/one-file.ts', 'export const a = 1;\n');
    write(root, 'packages/beta/src/twoFile.ts', 'export const b = 2;\n');
    write(root, 'packages/beta/src/two-file.ts', 'export const c = 3;\n');
    write(root, 'packages/gamma/lib/ignored-file.ts', 'export const d = 4;\n');

    const reading = sensePlantCoherence({ repoRoot: root, now: NOW });

    expect(reading.metrics?.dirs_scanned).toBe(2);
    expect(reading.metrics?.incoherent_dirs).toBe(1);
    expect(findings(reading).map((f) => f.file)).toEqual(['packages/beta/src']);
  });

  it('accepts a leading wildcard, a wildcard-free glob and an absolute glob', () => {
    const root = fixtureRoot('plant-coherence');
    write(root, 'alpha/src/one-file.ts', 'export const a = 1;\n');
    write(root, 'lib/two-file.ts', 'export const b = 2;\n');

    const leading = sensePlantCoherence({
      repoRoot: root,
      sourceGlobs: ['*/src/**'],
      now: NOW,
    });
    expect(leading.status).toBe('pass');
    expect(leading.metrics?.dirs_scanned).toBe(1);

    const plain = sensePlantCoherence({ repoRoot: root, sourceGlobs: ['lib'], now: NOW });
    expect(plain.status).toBe('pass');
    expect(plain.metrics?.dirs_scanned).toBe(1);

    const absolute = sensePlantCoherence({
      repoRoot: root,
      sourceGlobs: [join(root, 'alpha/src/*')],
      now: NOW,
    });
    expect(absolute.status).toBe('pass');
    expect(absolute.metrics?.dirs_scanned).toBe(1);
  });

  it('reports no directories when the segment before the wildcard is missing', () => {
    const root = fixtureRoot('plant-coherence');
    write(root, 'packages/alpha/src/one-file.ts', 'export const a = 1;\n');

    const reading = sensePlantCoherence({
      repoRoot: root,
      sourceGlobs: ['apps/*/src/**'],
      now: NOW,
    });

    expect(reading.status).toBe('review');
    expect(codes(reading)).toEqual(['PLANT_COHERENCE_NO_DIRS']);
    expect(reading.metrics?.dirs_scanned).toBe(0);
  });

  it('recursively counts nested source directories selected by supported prefixes', () => {
    const root = fixtureRoot('plant-coherence');
    write(root, 'packages/alpha/src/nested/one-file.ts', 'export const a = 1;\n');

    // `/**` then `/*` are stripped in turn, so all three globs reduce to
    // `packages/*/src`; the walk below that prefix is always recursive.
    for (const glob of ['packages/*/src/**', 'packages/*/src/*', 'packages/*/src/*/**']) {
      const reading = sensePlantCoherence({ repoRoot: root, sourceGlobs: [glob], now: NOW });
      expect(reading.status).toBe('pass');
      expect(reading.metrics?.dirs_scanned).toBe(1);
    }
  });

  it('fails past the review budget and honours an explicit maxReviewIncoherent', () => {
    const root = fixtureRoot('plant-coherence');
    for (const name of ['a', 'b', 'c', 'd']) {
      write(root, `packages/${name}/src/one-file.ts`, 'export const a = 1;\n');
      write(root, `packages/${name}/src/oneFile.ts`, 'export const b = 2;\n');
    }

    const strict = sensePlantCoherence({ repoRoot: root, now: NOW });
    expect(strict.status).toBe('fail');
    expect(strict.metrics?.incoherent_dirs).toBe(4);
    expect(strict.metrics?.max_review_incoherent).toBe(3);

    const lenient = sensePlantCoherence({ repoRoot: root, maxReviewIncoherent: 4, now: NOW });
    expect(lenient.status).toBe('review');
    expect(lenient.metrics?.max_review_incoherent).toBe(4);

    const zero = sensePlantCoherence({ repoRoot: root, maxReviewIncoherent: 0, now: NOW });
    expect(zero.status).toBe('fail');
  });

  it('stamps its own timestamp when none is supplied', () => {
    const root = fixtureRoot('plant-coherence');
    write(root, 'packages/a/src/one-file.ts', 'export const a = 1;\n');

    const reading = sensePlantCoherence({ repoRoot: root });

    expect(reading.timestamp).not.toBe(NOW);
    expect(Number.isNaN(Date.parse(reading.timestamp))).toBe(false);
  });
});

// Trace annotation deferred to Architect TASK-06216: no exact canonical concurrency invariant.
// ADR-REL-0034 derives effects from arbitrary jobs and recursively reachable local calls.
describe('generic publication effect concurrency (offline)', () => {
  const writer = `jobs:
  arbitrary:
    permissions:
      contents: read
      pages: write
      deployments: write
      id-token: write
    environment: github-pages
    concurrency:
      group: devai-pages-publication
      cancel-in-progress: false
    steps:
      - run: node scripts/process/publish-site.mjs
`;
  it('accepts an arbitrary filename when every effectful job has the noncancelling shared lock', () => {
    const root = fixtureRoot('job-effects');
    write(root, 'scripts/process/publish-site.mjs', "import './leaf.mjs';\n");
    write(root, 'scripts/process/leaf.mjs', "export const value = 'contained offline source';\n");
    write(root, '.github/workflows/not-site.yml', writer);
    expect(senseHarnessCoherence({ repoRoot: root, now: NOW }).metrics).toMatchObject({
      concurrency_semantic_issues: 0,
    });
  });
  it.each(['cancelled-lock', 'case-alias', 'missing-lock', 'unknown-call'])(
    'refuses %s independently of the workflow filename',
    (fault) => {
      const root = fixtureRoot('job-effects');
      write(root, 'scripts/process/publish-site.mjs', "import './leaf.mjs';\n");
      write(root, 'scripts/process/leaf.mjs', "export const value = 'contained offline source';\n");
      let source = writer;
      if (fault === 'cancelled-lock')
        source = source.replace('cancel-in-progress: false', 'cancel-in-progress: true');
      if (fault === 'case-alias')
        source = source
          .replace('group: devai-pages-publication', 'group: DEVAI-PAGES-PUBLICATION')
          .replace('cancel-in-progress: false', 'cancel-in-progress: true');
      if (fault === 'missing-lock')
        source = source.replace(
          '    concurrency:\n      group: devai-pages-publication\n      cancel-in-progress: false\n',
          '',
        );
      if (fault === 'unknown-call')
        source = source.replace(
          'node scripts/process/publish-site.mjs',
          'node scripts/process/unknown-write.mjs',
        );
      write(root, '.github/workflows/not-site.yml', source);
      expect(
        senseHarnessCoherence({ repoRoot: root, now: NOW }).metrics?.concurrency_semantic_issues,
      ).toBeGreaterThan(0);
    },
  );
  it('resolves publication effects reached through a local reusable workflow', () => {
    const root = fixtureRoot('job-effects');
    write(root, 'scripts/process/publish-site.mjs', "import './leaf.mjs';\n");
    write(root, 'scripts/process/leaf.mjs', "export const value = 'contained offline source';\n");
    write(
      root,
      '.github/workflows/caller.yml',
      `jobs:\n  looks_read_only:\n    uses: ./.github/workflows/callee.yml\n`,
    );
    write(
      root,
      '.github/workflows/callee.yml',
      writer.replace('cancel-in-progress: false', 'cancel-in-progress: true'),
    );
    expect(
      senseHarnessCoherence({ repoRoot: root, now: NOW }).metrics?.concurrency_semantic_issues,
    ).toBeGreaterThan(0);
  });
});

const ADMITTED_CODE = 'HARNESS_COHERENCE_UNPROVED_EFFECT_ADMITTED';
type AdmissionGround = 'serialized-publisher' | 'read-only-capability-bound';
function admittedFinding(file: string, job: string, ground: AdmissionGround): SensorFinding {
  return {
    severity: 'info',
    code: ADMITTED_CODE,
    message: `.github/workflows/${file}#${job}: unknown effect admitted as ${ground}`,
  };
}
/** The single unknown-effect job is admitted, reported by name and ground, and counted. */
function expectAdmitted(
  reading: SensorReading,
  file: string,
  job: string,
  ground: AdmissionGround,
): void {
  expect(reading.status).toBe('pass');
  expect(findings(reading)).toEqual([admittedFinding(file, job, ground)]);
  expect(reading.metrics?.concurrency_semantic_issues).toBe(0);
  expect(reading.metrics?.incoherence_score).toBe(0);
  expect(reading.metrics?.unproved_effect_admitted).toBe(1);
}
// Unknown effects whose job keeps the declared contents: read bound (no secret, environment,
// credential input, deploy action or unresolved call) are admitted by the amendment.
const BOUND_ADMITTED_FAULTS = new Set([
  'missing-direct',
  'missing-import',
  'inline-executable',
  'composite-missing-import',
  'import-cycle',
  'import-escape',
]);
const BOUND_ADMITTED_INPUTS = new Set<string>([
  'checkout github-server-url',
  'checkout ssh-strict false',
  'setup-node mirror',
  'cache restore over scripts',
  'input-free artifact download',
  'undeclared input on a branch ref',
]);

describe('causal candidate effect concurrency regressions (offline)', () => {
  function complete(root: string): string {
    write(root, 'scripts/process/publish-site.mjs', "import './leaf.mjs';\n");
    write(root, 'scripts/process/leaf.mjs', "export const value = 'contained read-only source';\n");
    write(
      root,
      '.github/actions/local/action.yml',
      'name: local\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: node scripts/process/publish-site.mjs\n',
    );
    return `permissions:\n  contents: read\njobs:\n  inspect:\n    concurrency:\n      group: inspect-${'${{ github.ref }}'}\n      cancel-in-progress: true\n    steps:\n      - run: node scripts/process/publish-site.mjs\n`;
  }
  function observe(root: string, source: string) {
    write(root, '.github/workflows/neutral.yml', source);
    return senseHarnessCoherence({ repoRoot: root, now: NOW });
  }
  it.each([
    'missing-direct',
    'missing-import',
    'inline-executable',
    'composite-effect',
    'composite-missing-import',
    'source-substitution',
    'import-cycle',
    'import-escape',
  ])('refuses %s causally after the same complete candidate passes', (fault) => {
    const root = fixtureRoot('candidate-concurrency');
    let source = complete(root);
    if (fault.startsWith('composite-'))
      source = source.replace(
        'run: node scripts/process/publish-site.mjs',
        'uses: ./.github/actions/local',
      );
    const control = observe(root, source);
    expect(control.status).toBe('pass');
    expect(control.metrics?.concurrency_semantic_issues).toBe(0);
    expect(codes(control)).toEqual([]);
    if (fault === 'missing-direct') rmSync(join(root, 'scripts/process/publish-site.mjs'));
    if (fault === 'missing-import' || fault === 'composite-missing-import')
      rmSync(join(root, 'scripts/process/leaf.mjs'));
    if (fault === 'inline-executable')
      source = source.replace(
        'node scripts/process/publish-site.mjs',
        'node -e \'fetch("https://example.invalid",{method:"POST"})\'',
      );
    if (fault === 'composite-effect' || fault === 'source-substitution')
      write(
        root,
        'scripts/process/leaf.mjs',
        'fetch("https://example.invalid",{method:"POST"});\n',
      );
    if (fault === 'import-cycle')
      write(root, 'scripts/process/leaf.mjs', "import './publish-site.mjs';\n");
    if (fault === 'import-escape')
      write(root, 'scripts/process/leaf.mjs', "import '../../../outside.mjs';\n");
    const rejected = observe(root, source);
    // CMP0006-OD-COHERENCE-20261003: the unproved job holds a declared read-only bound.
    if (BOUND_ADMITTED_FAULTS.has(fault))
      expectAdmitted(rejected, 'neutral.yml', 'inspect', 'read-only-capability-bound');
    else {
      expect(rejected.status).toBe('review');
      expect(rejected.metrics?.concurrency_semantic_issues).toBe(1);
      expect(codes(rejected)).toEqual(['HARNESS_COHERENCE_CONCURRENCY_POLICY']);
    }
    // A complete effectful candidate becomes acceptable only with the required publication lock.
    if (fault === 'composite-effect' || fault === 'source-substitution') {
      const locked = source
        .replace('inspect-${{ github.ref }}', 'devai-pages-publication')
        .replace('cancel-in-progress: true', 'cancel-in-progress: false');
      expect(observe(root, locked).metrics?.concurrency_semantic_issues).toBe(0);
    }
  });
  // WHOLE19-REV-002/-012: an action input or restore that selects the executed bytes, the
  // runtime, the fetch server or a credential invalidates the analysed script proof.
  it.each([
    [
      'checkout github-server-url',
      `actions/checkout@${SHA}`,
      ['github-server-url: https://evil.example'],
    ],
    ['checkout non-ambient token', `actions/checkout@${SHA}`, ['token: ${{ secrets.PAT }}']],
    ['checkout ssh-strict false', `actions/checkout@${SHA}`, ['ssh-strict: false']],
    ['setup-node mirror', `actions/setup-node@${SHA}`, ['mirror: https://evil.example/node']],
    [
      'foreign artifact download',
      `actions/download-artifact@${SHA}`,
      [
        'repository: other/repo',
        "run-id: '123'",
        'github-token: ${{ secrets.PAT }}',
        'path: scripts',
      ],
    ],
    ['cache restore over scripts', `actions/cache@${SHA}`, ['path: scripts', 'key: anything']],
    ['input-free artifact download', `actions/download-artifact@${SHA}`, []],
    ['undeclared input on a branch ref', 'actions/checkout@main', ["schedule: '0 3 * * *'"]],
  ] as const)(
    'refuses %s before the proved script after the pinned control passes',
    (_n, use, inputs) => {
      const root = fixtureRoot('candidate-concurrency');
      const source = complete(root);
      function before(step: string): string {
        return source.replace('    steps:\n', `    steps:\n${step}\n`);
      }
      const pinned = [
        `      - uses: actions/checkout@${SHA}`,
        '        with:',
        "          schedule: '0 3 * * *'",
      ];
      const control = observe(root, before(pinned.join('\n')));
      expect(control.status).toBe('pass');
      expect(control.metrics?.concurrency_semantic_issues).toBe(0);
      expect(codes(control)).toEqual([]);
      const step = [`      - uses: ${use}`];
      if (inputs.length) step.push('        with:', ...inputs.map((input) => `          ${input}`));
      const rejected = observe(root, before(step.join('\n')));
      // CMP0006-OD-COHERENCE-20261003: a non-credential selector leaves the read-only bound intact.
      if (BOUND_ADMITTED_INPUTS.has(_n))
        expectAdmitted(rejected, 'neutral.yml', 'inspect', 'read-only-capability-bound');
      else {
        expect(rejected.status).toBe('review');
        expect(rejected.metrics?.concurrency_semantic_issues).toBe(1);
        expect(codes(rejected)).toEqual(['HARNESS_COHERENCE_CONCURRENCY_POLICY']);
      }
    },
  );
  it.each([
    ['secrets inherit', 'secrets: inherit'],
    ['with inputs', 'with:\n      ref: refs/heads/other'],
  ])(
    'refuses a reusable workflow call forwarding %s after the plain call passes',
    (_name, forwarded) => {
      const root = fixtureRoot('candidate-concurrency');
      write(
        root,
        '.github/workflows/reuse.yml',
        complete(root).replace(
          'permissions:\n',
          'on:\n  workflow_call:\n    inputs:\n      ref:\n        type: string\npermissions:\n',
        ),
      );
      const caller = `permissions:\n  contents: read\njobs:\n  call:\n    concurrency:\n      group: call-${'${{ github.ref }}'}\n      cancel-in-progress: true\n    uses: ./.github/workflows/reuse.yml\n`;
      const control = observe(root, caller);
      expect(control.status).toBe('pass');
      expect(control.metrics?.concurrency_semantic_issues).toBe(0);
      expect(codes(control)).toEqual([]);
      const rejected = observe(root, `${caller}    ${forwarded}\n`);
      // CMP0006-OD-COHERENCE-20261003: forwarded data to a resolved bounded callee is admitted;
      // forwarded secrets are a credential flow beyond the ambient token and stay refused.
      if (_name === 'with inputs')
        expectAdmitted(rejected, 'neutral.yml', 'call', 'read-only-capability-bound');
      else {
        expect(rejected.status).toBe('review');
        expect(rejected.metrics?.concurrency_semantic_issues).toBe(1);
        expect(codes(rejected)).toEqual(['HARNESS_COHERENCE_CONCURRENCY_POLICY']);
      }
    },
  );
});

// Trace annotation deferred to Architect TASK-06216: no exact canonical concurrency invariant.
// ADR-REL-0034 Amendment 2026-10-03 (CMP0006-OD-COHERENCE-20261003), ground 2: a cancellable
// unknown-effect job is admitted only under an explicit read-only capability bound.
describe('read-only capability bound admission of unknown effects (offline)', () => {
  const BOUND_POLICY: SensorFinding = {
    severity: 'warning',
    code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
    message:
      '.github/workflows/bounded.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
  };
  const BOUNDED = [
    'name: bounded',
    'on:',
    '  push:',
    '    branches: [main]',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  inspect:',
    '    runs-on: ubuntu-latest',
    '    concurrency:',
    `      group: inspect-${'${{ github.ref }}'}`,
    '      cancel-in-progress: true',
    '    steps:',
    `      - uses: actions/checkout@${SHA}`,
    '        with:',
    '          persist-credentials: false',
    '      - run: node scripts/unproved.mjs',
    '',
  ].join('\n');
  const WORKFLOW_READ = 'permissions:\n  contents: read\n';
  const JOB_HEAD = '  inspect:\n    runs-on: ubuntu-latest\n';
  const RUN = '      - run: node scripts/unproved.mjs\n';
  const CHECKOUT_WITH = `      - uses: actions/checkout@${SHA}\n        with:\n`;
  function boundRoot(): string {
    const root = fixtureRoot('bound-admission');
    // Child-process execution has no read-only proof: the parser keeps this job unknown.
    write(
      root,
      'scripts/unproved.mjs',
      "import { spawnSync } from 'node:child_process';\nspawnSync('make', ['all']);\n",
    );
    return root;
  }
  function sense(root: string, source: string, job = 'inspect'): SensorReading {
    const file = write(root, '.github/workflows/bounded.yml', source);
    // Parser classification is unchanged by the amendment: the job stays unknown.
    expect(jobEffectFacts(readFileSync(file, 'utf8'), root, job).effect).toBe('unknown');
    return senseHarnessCoherence({ repoRoot: root, now: NOW });
  }
  function replaced(source: string, from: string, to: string): string {
    expect(source.split(from)).toHaveLength(2);
    return source.replace(from, to);
  }
  function expectRefused(reading: SensorReading): void {
    expect(reading.status).toBe('review');
    expect(findings(reading)).toEqual([BOUND_POLICY]);
    expect(reading.metrics?.concurrency_semantic_issues).toBe(1);
    expect(reading.metrics?.unproved_effect_admitted).toBe(undefined);
  }

  it('admits and reports a cancellable unknown job under workflow contents: read', () => {
    const reading = sense(boundRoot(), BOUNDED);
    expectAdmitted(reading, 'bounded.yml', 'inspect', 'read-only-capability-bound');
    expect(reading.metrics).toEqual({
      workflow_count: 1,
      action_version_drift_count: 0,
      permissions_mixed: 0,
      concurrency_mixed: 0,
      concurrency_semantic_issues: 0,
      incoherence_score: 0,
      max_review_incoherence: 3,
      unproved_effect_admitted: 1,
    });
  });

  // Each admitted variant keeps every bound clause; persist-credentials: true persists only the
  // read-scoped ambient token, which is not a write credential (spec reading recorded in evidence).
  it.each([
    ['workflow read-all', (s: string) => replaced(s, WORKFLOW_READ, 'permissions: read-all\n')],
    [
      'read and none scopes',
      (s: string) => replaced(s, WORKFLOW_READ, `${WORKFLOW_READ}  actions: none\n`),
    ],
    [
      'job-level contents: read without workflow permissions',
      (s: string) =>
        replaced(
          replaced(s, WORKFLOW_READ, ''),
          JOB_HEAD,
          `${JOB_HEAD}    permissions:\n      contents: read\n`,
        ),
    ],
    [
      'job-level contents: read overriding workflow write-all',
      (s: string) =>
        replaced(
          replaced(s, WORKFLOW_READ, 'permissions: write-all\n'),
          JOB_HEAD,
          `${JOB_HEAD}    permissions:\n      contents: read\n`,
        ),
    ],
    [
      'ambient token references only',
      (s: string) =>
        replaced(
          replaced(s, CHECKOUT_WITH, `${CHECKOUT_WITH}          token: ${'${{ github.token }}'}\n`),
          RUN,
          `${RUN}        env:\n          GH_TOKEN: ${'${{ secrets.GITHUB_TOKEN }}'}\n`,
        ),
    ],
    [
      'persisted read-scoped ambient credential',
      (s: string) => replaced(s, 'persist-credentials: false', 'persist-credentials: true'),
    ],
    [
      'run-scoped artifact upload and cache save',
      (s: string) =>
        `${s}      - uses: actions/upload-artifact@${SHA}\n        with:\n          name: report\n          path: out\n      - uses: actions/cache@${SHA}\n        with:\n          path: .cache\n          key: bounded\n`,
    ],
    [
      'workflow-level superseding lock',
      (s: string) =>
        replaced(
          replaced(
            s,
            `    concurrency:\n      group: inspect-${'${{ github.ref }}'}\n      cancel-in-progress: true\n`,
            '',
          ),
          'jobs:\n',
          `concurrency:\n  group: bounded-${'${{ github.ref }}'}\n  cancel-in-progress: true\njobs:\n`,
        ),
    ],
  ] as const)('admits and reports the bound with %s', (_name, mutate) => {
    const root = boundRoot();
    expectAdmitted(sense(root, BOUNDED), 'bounded.yml', 'inspect', 'read-only-capability-bound');
    expectAdmitted(
      sense(root, mutate(BOUNDED)),
      'bounded.yml',
      'inspect',
      'read-only-capability-bound',
    );
  });

  it.each([
    ['omitted permissions', (s: string) => replaced(s, WORKFLOW_READ, '')],
    [
      'contents: write',
      (s: string) => replaced(s, WORKFLOW_READ, 'permissions:\n  contents: write\n'),
    ],
    ['write-all', (s: string) => replaced(s, WORKFLOW_READ, 'permissions: write-all\n')],
    [
      'id-token: write beside contents: read',
      (s: string) => replaced(s, WORKFLOW_READ, `${WORKFLOW_READ}  id-token: write\n`),
    ],
    [
      'job-level contents: write overriding workflow read',
      (s: string) => replaced(s, JOB_HEAD, `${JOB_HEAD}    permissions:\n      contents: write\n`),
    ],
    ['an environment', (s: string) => replaced(s, JOB_HEAD, `${JOB_HEAD}    environment: ci\n`)],
    [
      'a secret in step env',
      (s: string) =>
        replaced(s, RUN, `${RUN}        env:\n          TOKEN: ${'${{ secrets.DEPLOY_TOKEN }}'}\n`),
    ],
    [
      'a secret in a run script',
      (s: string) =>
        replaced(
          s,
          RUN,
          `      - run: node scripts/unproved.mjs "${'${{ secrets.DEPLOY_TOKEN }}'}"\n`,
        ),
    ],
    [
      'a secret-backed checkout token',
      (s: string) =>
        replaced(s, CHECKOUT_WITH, `${CHECKOUT_WITH}          token: ${'${{ secrets.PAT }}'}\n`),
    ],
    [
      'a non-ambient credential input',
      (s: string) =>
        replaced(s, CHECKOUT_WITH, `${CHECKOUT_WITH}          token: ${'${{ vars.BOT_TOKEN }}'}\n`),
    ],
    ['a deploy-pages step', (s: string) => `${s}      - uses: actions/deploy-pages@${SHA}\n`],
    [
      'a release action step',
      (s: string) => `${s}      - uses: softprops/action-gh-release@${SHA}\n`,
    ],
    [
      'an unresolved local composite',
      (s: string) => `${s}      - uses: ./.github/actions/absent\n`,
    ],
    [
      'a local composite that violates the bound',
      (s: string) => `${s}      - uses: ./.github/actions/leaky\n`,
    ],
  ] as const)('refuses the bound with %s after the bounded control is admitted', (_n, mutate) => {
    const root = boundRoot();
    write(
      root,
      '.github/actions/leaky/action.yml',
      `name: leaky\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: node scripts/unproved.mjs "${'${{ secrets.DEPLOY_TOKEN }}'}"\n`,
    );
    expectAdmitted(sense(root, BOUNDED), 'bounded.yml', 'inspect', 'read-only-capability-bound');
    expectRefused(sense(root, mutate(BOUNDED)));
  });

  it('refuses an unresolved local reusable call after the bounded control is admitted', () => {
    const root = boundRoot();
    expectAdmitted(sense(root, BOUNDED), 'bounded.yml', 'inspect', 'read-only-capability-bound');
    const call = BOUNDED.slice(0, BOUNDED.indexOf(JOB_HEAD)).concat(
      `  inspect:\n    concurrency:\n      group: inspect-${'${{ github.ref }}'}\n      cancel-in-progress: true\n    uses: ./.github/workflows/absent.yml\n`,
    );
    expectRefused(sense(root, call));
  });

  it('keeps the finding for a refused job beside an admitted job in the same workflow', () => {
    const root = boundRoot();
    expectAdmitted(sense(root, BOUNDED), 'bounded.yml', 'inspect', 'read-only-capability-bound');
    const twoJobs = `${BOUNDED}  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    concurrency:\n      group: deploy-${'${{ github.ref }}'}\n      cancel-in-progress: true\n    steps:\n      - run: node scripts/unproved.mjs\n`;
    const reading = sense(root, twoJobs, 'deploy');
    expect(reading.status).toBe('review');
    const byCode = (a: SensorFinding, b: SensorFinding) => a.code.localeCompare(b.code);
    expect([...findings(reading)].sort(byCode)).toEqual(
      [BOUND_POLICY, admittedFinding('bounded.yml', 'inspect', 'read-only-capability-bound')].sort(
        byCode,
      ),
    );
    expect(reading.metrics?.concurrency_semantic_issues).toBe(1);
    expect(reading.metrics?.unproved_effect_admitted).toBe(1);
  });
});
