// Invariants: INV-SEC-002
// ADR-REL-0034 IA-004/005: real journal reducer, offline approved-host controls.
// These fixtures never authenticate a remote deployment or a live journal.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { senseHarnessCoherence } from '../../packages/sensors/src/harness-coherence.js';
import { jobEffectFacts } from '../../packages/sensors/src/harness/workflow-parser.js';
import type { SensorFinding, SensorReading } from '../../packages/sensors/src/sensor-reading.js';
const { publishPages } = await import('../../scripts/process/pages-publication.mjs');
const identity = () => ({
  repository: 'aarusso-nyx/devai',
  mode: 'site-only',
  tag: 'v1.8.0',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  siteSha256: 'c'.repeat(64),
  sourceRun: '101',
  controlCommit: 'd'.repeat(40),
});
function fixture(phase: 'intent' | 'submitted' | 'verified' | null = null) {
  const record = {
    schemaVersion: '1.0.0',
    identity: identity(),
    intentId: '11',
    artifactId: '21',
    pagesId: phase === 'intent' ? null : 'original-pages-id',
    phase,
  };
  const controls = {
    readJournal: vi.fn(async () => ({
      complete: true,
      migrationAudited: true,
      records: phase === null ? [] : [record],
    })),
    readEffect: vi.fn(async () => 'confirmed-missing'),
    createIntent: vi.fn(async () => '11'),
    submit: vi.fn(async () => 'new-pages-id'),
    recordSubmitted: vi.fn(async () => {}),
    observe: vi.fn(async () => 'succeeded'),
    verifyLiveBytes: vi.fn(async () => {}),
    recordVerified: vi.fn(async () => {}),
  };
  return { record, controls };
}
describe('Pages cancellation and exact journal resume (offline)', () => {
  it('resumes a known submission using its original Pages ID and artifact despite a rerun argument', async () => {
    const { controls } = fixture('submitted');
    const result = await publishPages({ identity: identity(), artifactId: '999', controls });
    expect(result).toMatchObject({
      outcome: 'verified',
      pagesId: 'original-pages-id',
      buildInvocations: 0,
    });
    expect(controls.observe).toHaveBeenCalledWith('original-pages-id');
    expect(controls.recordVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: '21',
        pagesId: 'original-pages-id',
        phase: 'verified',
      }),
    );
    expect(controls.submit).not.toHaveBeenCalled();
    expect(controls.createIntent).not.toHaveBeenCalled();
  });
  it.each(['matching', 'confirmed-missing', 'unknown'])(
    'preserves an unknown intent even when observed effect is %s',
    async (effect) => {
      const { controls } = fixture('intent');
      controls.readEffect.mockResolvedValue(effect);
      await expect(
        publishPages({ identity: identity(), artifactId: '21', controls }),
      ).rejects.toThrow('PAGES_PUBLICATION_SUBMISSION_UNKNOWN');
      expect(controls.submit).not.toHaveBeenCalled();
      expect(controls.recordVerified).not.toHaveBeenCalled();
    },
  );
  it.each(['cancelled', 'failed', 'unknown'])(
    'cannot promote %s observation to a verified record',
    async (outcome) => {
      const { controls } = fixture('submitted');
      controls.observe.mockResolvedValue(outcome);
      await expect(
        publishPages({ identity: identity(), artifactId: '21', controls }),
      ).rejects.toThrow('PAGES_PUBLICATION_DEPLOYMENT_UNRESOLVED');
      expect(controls.recordVerified).not.toHaveBeenCalled();
      expect(controls.submit).not.toHaveBeenCalled();
    },
  );
  it('propagates cancellation between observation and byte verification without manufacturing verified history', async () => {
    const { controls } = fixture('submitted');
    controls.verifyLiveBytes.mockRejectedValue(new Error('offline cancellation'));
    await expect(
      publishPages({ identity: identity(), artifactId: '21', controls }),
    ).rejects.toThrow('offline cancellation');
    expect(controls.recordVerified).not.toHaveBeenCalled();
  });
  it('preserves an independently verified predecessor across interruption', async () => {
    const { record, controls } = fixture('verified');
    controls.readEffect.mockResolvedValue('matching');
    expect(await publishPages({ identity: identity(), artifactId: '21', controls })).toMatchObject({
      outcome: 'no-op',
      buildInvocations: 0,
    });
    expect(record.phase).toBe('verified');
    expect(controls.recordVerified).not.toHaveBeenCalled();
    expect(controls.submit).not.toHaveBeenCalled();
  });
  it('refuses a cross-run predecessor rather than duplicating publication', async () => {
    const { record, controls } = fixture('submitted');
    record.identity.sourceRun = '100';
    await expect(
      publishPages({ identity: identity(), artifactId: '21', controls }),
    ).rejects.toThrow('PAGES_PUBLICATION_JOURNAL_INVALID');
    expect(controls.submit).not.toHaveBeenCalled();
    expect(controls.recordVerified).not.toHaveBeenCalled();
  });
  it('requires durable intent before the irreversible submission', async () => {
    const { controls } = fixture();
    await expect(
      publishPages({ identity: identity(), artifactId: '21', controls }),
    ).rejects.toThrow('PAGES_PUBLICATION_INTENT_NOT_DURABLE');
    expect(controls.submit).not.toHaveBeenCalled();
  });
  it('refuses incomplete or unaudited journal snapshots', async () => {
    for (const journal of [
      { complete: false, migrationAudited: true, records: [] },
      { complete: true, migrationAudited: false, records: [] },
    ]) {
      const { controls } = fixture();
      controls.readJournal.mockResolvedValue(journal);
      await expect(
        publishPages({ identity: identity(), artifactId: '21', controls }),
      ).rejects.toThrow('PAGES_PUBLICATION_JOURNAL_UNKNOWN');
      expect(controls.submit).not.toHaveBeenCalled();
    }
  });
});

// INV-SEC-002 exact release identity clause only. The site-only concurrency/
// interruption cases above need separate Architect trace adjudication.
describe('release publication component binds exact candidate/tree identities (offline)', () => {
  it.each(['commit', 'tree', 'controlCommit', 'manifestSha256'] as const)(
    'refuses a near-match release %s before resubmission',
    async (field) => {
      const { record, controls } = fixture('submitted');
      const release = {
        repository: 'aarusso-nyx/devai',
        tag: 'v1.8.0',
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        controlCommit: 'd'.repeat(40),
        siteSha256: 'c'.repeat(64),
        manifestSha256: 'f'.repeat(64),
        rehearsalRun: '101',
        rehearsalAttempt: '1',
      };
      const near = { ...release, [field]: 'e'.repeat(field === 'manifestSha256' ? 64 : 40) };
      controls.readJournal.mockResolvedValue({
        complete: true,
        migrationAudited: true,
        records: [{ ...record, identity: near }],
      } as never);
      await expect(publishPages({ identity: release, artifactId: '21', controls })).rejects.toThrow(
        'PAGES_PUBLICATION_JOURNAL_INVALID',
      );
      expect(controls.submit).not.toHaveBeenCalled();
      expect(controls.recordVerified).not.toHaveBeenCalled();
    },
  );
});

// Trace annotation deferred to Architect TASK-06216: no exact canonical concurrency invariant.
// ADR-REL-0034 Amendment 2026-10-03 (CMP0006-OD-COHERENCE-20261003), ground 1: an unknown-effect
// job is admitted only as the exact noncancellable main-only manual publisher.
const NOW = '2026-10-03T12:00:00.000Z';
const ADMITTED_CODE = 'HARNESS_COHERENCE_UNPROVED_EFFECT_ADMITTED';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function publisherRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-publisher-admission-'));
  roots.push(root);
  const path = resolve(root, 'scripts/process/unproved-publisher.mjs');
  if (!path.startsWith(root + sep)) throw new Error('fixture path escaped root');
  mkdirSync(dirname(path), { recursive: true });
  // Child-process execution has no proof: the parser keeps the publisher unknown.
  writeFileSync(
    path,
    "import { spawnSync } from 'node:child_process';\nspawnSync('make', ['publish']);\n",
  );
  return root;
}
const MAIN_GUARD = "    if: ${{ github.ref == 'refs/heads/main' }}\n";
const DISPATCH = 'on:\n  workflow_dispatch: {}\n';
const LOCK =
  '    concurrency:\n      group: devai-pages-publication\n      cancel-in-progress: false\n';
const PUBLISHER = [
  'name: pages',
  DISPATCH.trimEnd(),
  'permissions:',
  '  contents: read',
  'jobs:',
  '  publish:',
  MAIN_GUARD.trimEnd(),
  '    runs-on: ubuntu-latest',
  '    environment: github-pages',
  '    permissions:',
  '      contents: read',
  '      pages: write',
  '      deployments: write',
  '      id-token: write',
  LOCK.trimEnd(),
  '    steps:',
  '      - run: node scripts/process/unproved-publisher.mjs',
  '',
].join('\n');
function senseFixture(root: string, source: string): SensorReading {
  const file = join(root, '.github/workflows/pages.yml');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  // Parser classification is unchanged by the amendment: the publisher stays unknown.
  expect(jobEffectFacts(readFileSync(file, 'utf8'), root, 'publish').effect).toBe('unknown');
  return senseHarnessCoherence({ repoRoot: root, now: NOW });
}
function replaced(source: string, from: string, to: string): string {
  expect(source.split(from)).toHaveLength(2);
  return source.replace(from, to);
}
function admitted(file: string, job: string, ground: string): SensorFinding {
  return {
    severity: 'info',
    code: ADMITTED_CODE,
    message: `.github/workflows/${file}#${job}: unknown effect admitted as ${ground}`,
  };
}
function expectPublisherAdmitted(reading: SensorReading): void {
  expect(reading.status).toBe('pass');
  expect(reading.findings ?? []).toEqual([
    admitted('pages.yml', 'publish', 'serialized-publisher'),
  ]);
  expect(reading.metrics?.concurrency_semantic_issues).toBe(0);
  expect(reading.metrics?.incoherence_score).toBe(0);
  expect(reading.metrics?.unproved_effect_admitted).toBe(1);
}

describe('serialized publisher admission of unknown effects (offline)', () => {
  it.each([
    ['github.ref only', MAIN_GUARD],
    [
      'manual event and github.ref',
      "    if: ${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' }}\n",
    ],
  ])('admits and reports the exact main-only manual publisher guarded by %s', (_name, guard) => {
    const reading = senseFixture(publisherRoot(), replaced(PUBLISHER, MAIN_GUARD, guard));
    expectPublisherAdmitted(reading);
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

  it.each([
    [
      'cancel-in-progress true',
      (s: string) => replaced(s, 'cancel-in-progress: false', 'cancel-in-progress: true'),
      false,
    ],
    [
      'cancel-in-progress as an expression',
      (s: string) =>
        replaced(
          s,
          'cancel-in-progress: false',
          "cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
        ),
      false,
    ],
    [
      'a noncancelling workflow-level concurrency block',
      (s: string) =>
        replaced(
          s,
          'jobs:\n',
          'concurrency:\n  group: devai-pages-publication\n  cancel-in-progress: false\njobs:\n',
        ),
      false,
    ],
    [
      'an added push trigger',
      (s: string) => replaced(s, DISPATCH, `${DISPATCH}  push:\n    branches: [main]\n`),
      false,
    ],
    [
      'an added schedule trigger',
      (s: string) => replaced(s, DISPATCH, `${DISPATCH}  schedule:\n    - cron: '0 3 * * *'\n`),
      true,
    ],
    [
      'dispatch inputs',
      (s: string) =>
        replaced(
          s,
          DISPATCH,
          'on:\n  workflow_dispatch:\n    inputs:\n      ref:\n        type: string\n',
        ),
      false,
    ],
    ['a missing guard', (s: string) => replaced(s, MAIN_GUARD, ''), false],
    [
      'a guard that admits another ref',
      (s: string) =>
        replaced(
          s,
          MAIN_GUARD,
          "    if: ${{ github.ref == 'refs/heads/main' || github.ref == 'refs/heads/next' }}\n",
        ),
      false,
    ],
    [
      'a guard that excludes one ref only',
      (s: string) => replaced(s, MAIN_GUARD, "    if: ${{ github.ref != 'refs/heads/next' }}\n"),
      false,
    ],
    [
      'a guard without a ref',
      (s: string) =>
        replaced(s, MAIN_GUARD, "    if: ${{ github.event_name == 'workflow_dispatch' }}\n"),
      false,
    ],
    [
      'a case-variant group alias',
      (s: string) =>
        replaced(s, 'group: devai-pages-publication', 'group: DEVAI-PAGES-PUBLICATION'),
      false,
    ],
    [
      'a different group',
      (s: string) =>
        replaced(s, 'group: devai-pages-publication', 'group: devai-pages-publication-staging'),
      false,
    ],
  ] as const)(
    'refuses the publisher with %s after the exact publisher is admitted',
    (_name, mutate, serialized) => {
      const root = publisherRoot();
      expectPublisherAdmitted(senseFixture(root, PUBLISHER));
      const reading = senseFixture(root, mutate(PUBLISHER));
      expect(reading.status).toBe('review');
      expect(reading.findings ?? []).toEqual([
        {
          severity: 'warning',
          code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
          message: `.github/workflows/pages.yml must declare a non-empty concurrency group with cancel-in-progress: ${serialized ? 'false (serialized)' : 'true (superseding)'}.`,
        },
      ]);
      expect(reading.metrics?.concurrency_semantic_issues).toBe(1);
      expect(reading.metrics?.unproved_effect_admitted).toBe(undefined);
    },
  );
});

// Real-repository pin: the literal amended rule over the repository's own workflows. The
// environment- and secret-bearing unknown jobs of the release and ledger-verification workflows
// satisfy neither ground, so those two workflows keep their finding (reported, not hidden).
describe('repository workflow coherence under the serialize-or-bound amendment', () => {
  it('admits exactly the bounded and serialized jobs and reports the remaining findings', () => {
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    const reading = senseHarnessCoherence({ repoRoot, now: NOW });
    const byMessage = (a: SensorFinding, b: SensorFinding) => a.message.localeCompare(b.message);
    const of = (code: string) =>
      (reading.findings ?? []).filter((finding) => finding.code === code).sort(byMessage);
    expect(of(ADMITTED_CODE)).toEqual([
      admitted('pull-request-checks.yml', 'preflight', 'read-only-capability-bound'),
      admitted('release.yml', 'control-commit-summary', 'read-only-capability-bound'),
      admitted('site-publish.yml', 'prepare-site', 'read-only-capability-bound'),
      admitted('site-publish.yml', 'publish-site', 'serialized-publisher'),
    ]);
    expect(of('HARNESS_COHERENCE_CONCURRENCY_POLICY')).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
        message:
          '.github/workflows/devai-ledger-verify.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
      },
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
        message:
          '.github/workflows/release.yml must declare a non-empty concurrency group with cancel-in-progress: false (serialized).',
      },
    ]);
    expect(of('HARNESS_COHERENCE_CONCURRENCY_MIXED')).toEqual([
      {
        severity: 'info',
        code: 'HARNESS_COHERENCE_CONCURRENCY_MIXED',
        message: '3 workflows declare concurrency, 1 do not.',
      },
    ]);
    expect(reading.findings).toHaveLength(7);
    expect(reading.metrics).toEqual({
      workflow_count: 4,
      action_version_drift_count: 0,
      permissions_mixed: 0,
      concurrency_mixed: 1,
      concurrency_semantic_issues: 2,
      incoherence_score: 2,
      max_review_incoherence: 3,
      unproved_effect_admitted: 4,
    });
    expect(reading.status).toBe('review');
  });
});
