import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { executeTranslationValidation } from '../../src/commands/verify/translation.js';

const controls = vi.hoisted(() => ({
  provision: 'pass' as 'pass' | 'fail' | 'wrong-database',
  drop: 'pass' as 'pass' | 'fail',
  recovery: null as null | {
    status: 'pass' | 'fail';
    recovered: string[];
    findings: string[];
  },
}));

vi.mock('#runtime-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime-core.js')>();
  return {
    ...actual,
    async provisionValidationDatabase(input: { readonly validation_id: string }) {
      const suffix = input.validation_id.slice('VR-'.length);
      if (controls.provision === 'fail') return { ok: false, error: 'database unavailable' };
      return {
        ok: true,
        database:
          controls.provision === 'wrong-database'
            ? 'devai_task_TV_wrong'
            : `devai_task_TV_${suffix}`,
      };
    },
    async dropValidationDatabase() {
      return controls.drop === 'pass'
        ? { ok: true }
        : { ok: false, error: 'database cleanup refused' };
    },
    async recoverValidationLeases(input: Parameters<typeof actual.recoverValidationLeases>[0]) {
      return controls.recovery ?? actual.recoverValidationLeases(input);
    },
  };
});

const WITNESS_PATH = 'scratch/translation-orchestration-witness.json';
const RECIPE_PATH = 'record/proofs/work/recipe-runs/devai-fix/test/2026-07-28T00-00-00-000Z.json';
const TEST_PATH = 'packages/cli/tests/unit/translation-orchestration-fixture.test.js';
const SOURCE_PATH = 'packages/cli/src/translation-orchestration-fixture.js';
const TEST_REF = {
  suite: 'unit',
  path: TEST_PATH,
  names: ['translation changes behavior'],
} as const;

interface Harness {
  readonly root: string;
  readonly base: string;
  readonly candidate: string;
  readonly cleanup: () => void;
  readonly writeJson: (path: string, value: unknown) => void;
  readonly git: (args: readonly string[]) => string;
  readonly witness: (overrides?: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  readonly validate: (value?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'devai-translation-orchestration-'));
  const git = (args: readonly string[]): string => {
    const result = nodeSpawnSync('git', [...args], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout.trim();
  };
  git(['init', '--quiet']);
  git(['config', 'user.name', 'DEVAI Translation Test']);
  git(['config', 'user.email', 'translation-test@example.invalid']);
  const writeText = (path: string, value: string): void => {
    const absolute = resolve(root, path);
    mkdirSync(resolve(absolute, '..'), { recursive: true });
    writeFileSync(absolute, value);
  };
  const writeJson = (path: string, value: unknown): void => {
    writeText(path, `${JSON.stringify(value, null, 2)}\n`);
  };
  writeJson('law/invariants/INV-DEMO-003.json', {
    schemaVersion: '1.0.0',
    id: 'INV-DEMO-003',
    domain: 'DEMO',
    lifecycle: 'supported',
    severity: 'gate',
    type: 'validation',
    title: 'Translation orchestration behavior',
    statement: 'A registered test demonstrates the translated behavior.',
    status: 'active',
    verification: {
      required_suites: ['unit'],
      oracle: 'tests',
      strategy: {
        primary: 'regression',
        deterministic_check_available: true,
        rationale: 'The registered test is deterministic.',
      },
    },
    authority_docs: { docs: [{ doc: 'README.md', anchor: 'testing' }] },
    scope: { components: ['cli'], code_areas: [SOURCE_PATH], modules: ['MOD-CLI'] },
    change_policy: {
      breaking_change_requires: ['test_update'],
      test_weakening_allowed: false,
      human_approval_required: false,
    },
  });
  writeJson('law/trace.json', {
    schemaVersion: '1.0.0',
    version: '1.0.0',
    invariants: [{ id: 'INV-DEMO-003', tests: [TEST_REF], code_areas: [SOURCE_PATH] }],
    test_corpus: [],
  });
  writeText(
    TEST_PATH,
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { translated } from '../../../src/translation-orchestration-fixture.js';\ntest('translation changes behavior', () => assert.equal(translated, true));\n",
  );
  writeText(SOURCE_PATH, 'export const translated = false;\n');
  git([
    'add',
    '--force',
    '--',
    'law/invariants/INV-DEMO-003.json',
    'law/trace.json',
    TEST_PATH,
    SOURCE_PATH,
  ]);
  git(['commit', '--quiet', '-m', 'establish translation baseline']);
  const base = git(['rev-parse', 'HEAD']);
  writeText(SOURCE_PATH, 'export const translated = true;\n');
  git(['add', '--force', '--', SOURCE_PATH]);
  git(['commit', '--quiet', '-m', 'implement translated behavior']);
  const candidate = git(['rev-parse', 'HEAD']);

  writeJson('.devai/state/tasks/TASK-9003.json', {
    schemaVersion: '2.0.0',
    id: 'TASK-9003',
    round_id: 'R-0007',
    status: 'in_progress',
    discipline: 'engineer',
    title: 'Exercise translation orchestration',
    target_modules: ['MOD-CLI'],
    target_substrates: ['F2'],
    created_at: '2026-07-28T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'agent',
      runtime: 'codex-cli',
      model: 'model-primary',
      effort: 'high',
      selection: { mode: 'exact', registry_id: 'primary' },
      recipe_name: 'devai-fix',
      recipe_variant: 'test',
      prompt_composition_id: 'PC-0123456789abcdef',
      max_iterations: 1,
      capabilities: ['fs:workspace'],
    },
    intent_diff: { planned_files: [SOURCE_PATH] },
  });
  writeJson('record/proofs/chain.json', { head: null, records: [] });

  const witness = (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
    schemaVersion: '1.0.0',
    id: 'TW-0011223344556677',
    trust: 'untrusted-claim',
    task_id: 'TASK-9003',
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    stage: 'invariants-tests-to-code',
    base_sha: base,
    candidate_sha: candidate,
    emitted_at: '2026-07-28T00:00:00.000Z',
    strategy: 'regression',
    implements: [
      {
        invariant_id: 'INV-DEMO-003',
        criteria: [
          {
            claim: 'The candidate changes the registered behavior.',
            demonstrated_by: [{ kind: 'test', test_ref: TEST_REF }],
          },
        ],
      },
    ],
    touched: [SOURCE_PATH],
    red_green: [
      {
        test_ref: TEST_REF,
        expected_at_base: 'assertion-fail',
        expected_at_candidate: 'pass',
      },
    ],
    frame: {
      authority_role: 'engineer',
      spec_edits: 'none',
      test_edits: 'none',
      inventory_delta_confined_to: ['MOD-CLI'],
      effects_claimed: ['fs:plant'],
    },
    ...overrides,
  });

  const validate = async (
    value: Record<string, unknown> = witness(),
  ): Promise<Record<string, unknown>> => {
    writeJson(WITNESS_PATH, value);
    writeJson(RECIPE_PATH, {
      recipe_name: 'devai-fix',
      recipe_variant: 'test',
      status: 'pass',
      evidence: { translation_witness: value },
    });
    return withAuthorityHostTestScope(() =>
      executeTranslationValidation({
        witness: WITNESS_PATH,
        repoRoot: root,
        databaseUrl: 'postgres://unused',
      }),
    );
  };

  return {
    root,
    base,
    candidate,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    writeJson,
    git,
    witness,
    validate,
  };
}

afterEach(() => {
  controls.provision = 'pass';
  controls.drop = 'pass';
  controls.recovery = null;
});

describe('translation validation orchestration depth', () => {
  let harness: Harness;

  beforeAll(() => {
    harness = createHarness();
  });

  afterAll(() => harness.cleanup());

  it('refuses an unapproved registered-test process and removes isolated resources', async () => {
    expect(JSON.parse(harness.git(['show', `${harness.candidate}:law/trace.json`]))).toEqual(
      expect.objectContaining({ schemaVersion: '1.0.0' }),
    );
    const result = await harness.validate();
    expect(result['verdict']).toBe('FAIL');
    expect(result['executions']).toEqual([]);
    expect(result['isolation']).toEqual({
      mode: 'macos-best-effort',
      network_egress: 'not-proven',
      database: 'per-task-database',
      readiness_eligible: false,
    });
    expect(result['cleanup']).toEqual(
      expect.objectContaining({ worktree: 'not-created', database: 'removed' }),
    );
    expect(result['frames']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'infrastructure',
          status: 'FAIL',
          finding: expect.stringContaining('AUTHORITY_TEST_PROCESS_NOT_READ_ONLY'),
        }),
        expect.objectContaining({ name: 'network-egress', status: 'REVIEW' }),
        expect.objectContaining({ name: 'cleanup', status: 'PASS' }),
      ]),
    );
  });

  it('reports provision and cleanup failures without executing candidate commands', async () => {
    controls.provision = 'wrong-database';
    const provisionFailure = await harness.validate();
    expect(provisionFailure['verdict']).toBe('FAIL');
    expect(provisionFailure['executions']).toEqual([]);
    expect(provisionFailure['frames']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'infrastructure',
          finding: expect.stringContaining('VALIDATION_DATABASE_PROVISION_FAILED'),
        }),
      ]),
    );
    controls.provision = 'pass';
    controls.drop = 'fail';
    const cleanupFailure = await harness.validate();
    expect(cleanupFailure['verdict']).toBe('FAIL');
    expect(cleanupFailure['cleanup']).toEqual(
      expect.objectContaining({ worktree: 'not-created', database: 'orphan-fail' }),
    );
    expect(cleanupFailure['frames']).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'cleanup', status: 'FAIL' })]),
    );
    const cleanup = cleanupFailure['cleanup'] as { readonly lease_id: string };
    rmSync(
      resolve(harness.root, `.devai/state/translation-validation/leases/${cleanup.lease_id}.json`),
      { force: true },
    );
  });

  it('fails before provisioning when lease recovery cannot prove cleanup', async () => {
    controls.recovery = {
      status: 'fail',
      recovered: [],
      findings: ['TVL-deadbeef: database retained', 'TVL-feedface: invalid lease'],
    };
    await expect(harness.validate()).rejects.toThrow(
      'VALIDATION_RECOVERY_FAILED: TVL-deadbeef: database retained; TVL-feedface: invalid lease',
    );
  });

  it('reports missing and mismatched strategy authorities as explicit frame failures', async () => {
    const structural = (invariantId: string): Record<string, unknown> =>
      harness.witness({
        strategy: 'structural',
        red_green: undefined,
        implements: [
          {
            invariant_id: invariantId,
            criteria: [
              {
                claim: 'A structural validator demonstrates the behavior.',
                demonstrated_by: [{ kind: 'structural', validator: 'check --only schema' }],
              },
            ],
          },
        ],
      });

    controls.provision = 'fail';
    const missing = await harness.validate(structural('INV-ABSENT-003'));
    expect(missing['frames']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'strategy-coverage',
          status: 'FAIL',
          finding: expect.stringContaining('INV-ABSENT-003: STRATEGY_INVARIANT_MISSING'),
        }),
      ]),
    );

    const mismatch = await harness.validate(structural('INV-DEMO-003'));
    expect(mismatch['frames']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'strategy-coverage',
          status: 'FAIL',
          finding: expect.stringContaining('INV-DEMO-003: STRATEGY_PRIMARY_MISMATCH'),
        }),
      ]),
    );
  });

  it('retires an invalid prior lease only when recovery reports its exact identity', async () => {
    const recoveredLeaseId = 'TVL-0123456789abcdef';
    const leasePath = `.devai/state/translation-validation/leases/${recoveredLeaseId}.json`;
    harness.writeJson(leasePath, { invalid: true });
    controls.recovery = { status: 'pass', recovered: [recoveredLeaseId], findings: [] };
    controls.provision = 'fail';
    const result = await harness.validate(
      harness.witness({
        strategy: 'structural',
        red_green: undefined,
        implements: [
          {
            invariant_id: 'INV-DEMO-003',
            criteria: [
              {
                claim: 'A structural validator demonstrates the behavior.',
                demonstrated_by: [{ kind: 'structural', validator: 'check --only schema' }],
              },
            ],
          },
        ],
      }),
    );
    expect(result['cleanup']).toEqual(
      expect.objectContaining({
        recovery_scan: 'recovered',
        recovered_lease_ids: [recoveredLeaseId],
      }),
    );
    expect(existsSync(resolve(harness.root, leasePath))).toBe(false);
  });

  it('rejects a candidate that does not descend from its declared base', async () => {
    const tree = harness.git(['rev-parse', `${harness.base}^{tree}`]);
    const sibling = harness.git([
      'commit-tree',
      tree,
      '-p',
      harness.base,
      '-m',
      'independent translation candidate',
    ]);
    const value = harness.witness({
      strategy: 'structural',
      red_green: undefined,
      base_sha: harness.candidate,
      candidate_sha: sibling,
      implements: [
        {
          invariant_id: 'INV-DEMO-003',
          criteria: [
            {
              claim: 'A structural validator demonstrates the behavior.',
              demonstrated_by: [{ kind: 'structural', validator: 'check --only schema' }],
            },
          ],
        },
      ],
    });
    await expect(harness.validate(value)).rejects.toThrow('CANDIDATE_NOT_DESCENDANT_OF_BASE');
  });

  it('rejects a candidate whose committed trace fails the trace contract', async () => {
    harness.writeJson('law/trace.json', { schemaVersion: '1.0.0', invalid: true });
    harness.git(['add', '--force', '--', 'law/trace.json']);
    harness.git(['commit', '--quiet', '-m', 'record malformed trace candidate']);
    const malformedCandidate = harness.git(['rev-parse', 'HEAD']);
    await expect(
      harness.validate(harness.witness({ candidate_sha: malformedCandidate })),
    ).rejects.toThrow('TRANSLATION_TRACE_INVALID');
  });
});
