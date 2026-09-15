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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { senseHarnessCoherence } from '../../src/harness-coherence.js';
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
    const root = fixtureRoot('harness-coherence');

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
    const root = fixtureRoot('harness-coherence');
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
    const root = fixtureRoot('harness-coherence');
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
    const root = fixtureRoot('harness-coherence');
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
    const root = fixtureRoot('harness-coherence');
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
    const root = fixtureRoot('harness-coherence');
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
    const root = fixtureRoot('harness-coherence');
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
      'name: setup\nruns:\n  using: composite\n  steps:\n    - run: pnpm install\n',
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
    const root = fixtureRoot('harness-coherence');
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
    const root = fixtureRoot('harness-coherence');
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
    const root = fixtureRoot('harness-coherence');
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
    const root = fixtureRoot('harness-coherence');
    write(root, '.github/workflows/ci.yml', workflow({ concurrency: 'concurrency: ci-inline' }));

    const reading = senseHarnessCoherence({ repoRoot: root, now: NOW });

    expect(reading.status).toBe('review');
    expect(codes(reading)).toEqual(['HARNESS_COHERENCE_CONCURRENCY_POLICY']);
    expect(reading.metrics?.concurrency_mixed).toBe(0);
    expect(reading.metrics?.concurrency_semantic_issues).toBe(1);
  });

  it('fails past the review budget and honours an explicit maxReviewIncoherence', () => {
    const root = fixtureRoot('harness-coherence');
    for (const name of ['a', 'b', 'c', 'd']) {
      write(root, `.github/workflows/${name}-ci.yml`, workflow({ concurrency: null }));
    }

    const strict = senseHarnessCoherence({ repoRoot: root, now: NOW });
    expect(strict.status).toBe('fail');
    expect(strict.metrics?.incoherence_score).toBe(4);
    expect(strict.metrics?.max_review_incoherence).toBe(3);

    const lenient = senseHarnessCoherence({ repoRoot: root, maxReviewIncoherence: 4, now: NOW });
    expect(lenient.status).toBe('review');
    expect(lenient.metrics?.max_review_incoherence).toBe(4);

    const zero = senseHarnessCoherence({ repoRoot: root, maxReviewIncoherence: 0, now: NOW });
    expect(zero.status).toBe('fail');
  });

  it('reads workflows from an explicit workflowDir', () => {
    const root = fixtureRoot('harness-coherence');
    write(root, '.github/workflows/ci.yml', workflow({ concurrency: null }));
    write(root, 'ci/flows/ci.yml', workflow());

    const reading = senseHarnessCoherence({ repoRoot: root, workflowDir: 'ci/flows', now: NOW });

    expect(reading.status).toBe('pass');
    expect(reading.metrics?.workflow_count).toBe(1);
  });

  it('stamps its own timestamp when none is supplied', () => {
    const root = fixtureRoot('harness-coherence');
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

    const relative = senseHarnessSecurity({ repoRoot: root, workflowDir: 'ci/flows', now: NOW });
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

    const leading = sensePlantCoherence({ repoRoot: root, sourceGlobs: ['*/src/**'], now: NOW });
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
