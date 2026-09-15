import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';

interface IsolatedResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly isolation_applied?: boolean;
}

const controls = vi.hoisted(() => ({
  isolated: [] as IsolatedResult[],
  linuxCalls: [] as { readonly repo_root: string; readonly argv: readonly string[] }[],
  droppedDatabases: [] as string[],
  dropFailure: false as false | true | string,
  spawnSync: vi.fn(),
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync: controls.spawnSync,
}));

vi.mock('#runtime-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime-core.js')>();
  return {
    ...actual,
    async provisionValidationDatabase(input: { readonly validation_id: string }) {
      return {
        ok: true,
        database: `devai_task_TV_${input.validation_id.slice('VR-'.length)}`,
      };
    },
    async dropValidationDatabase(input: { readonly database: string }) {
      controls.droppedDatabases.push(input.database);
      if (controls.dropFailure !== false) {
        return {
          ok: false,
          ...(typeof controls.dropFailure === 'string' ? { error: controls.dropFailure } : {}),
        };
      }
      return { ok: true };
    },
    async runLinuxIsolated(input: {
      readonly repo_root: string;
      readonly argv: readonly string[];
    }) {
      controls.linuxCalls.push({ repo_root: input.repo_root, argv: input.argv });
      const result = controls.isolated.shift();
      if (result === undefined) throw new Error('UNEXPECTED_ISOLATED_EXECUTION');
      return {
        exit_code: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        isolation_applied: result.isolation_applied ?? true,
      };
    },
  };
});

import { executeTranslationValidation } from '../../src/commands/verify/translation.js';

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
  readonly validate: () => Promise<Record<string, unknown>>;
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'devai-translation-execution-'));
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

  const witness = {
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
  };

  const validate = async (): Promise<Record<string, unknown>> => {
    writeJson(WITNESS_PATH, witness);
    writeJson(RECIPE_PATH, {
      recipe_name: 'devai-fix',
      recipe_variant: 'test',
      status: 'pass',
      evidence: { translation_witness: witness },
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
    validate,
  };
}

const assertionFailure: IsolatedResult = {
  status: 1,
  signal: null,
  stdout: '',
  stderr: 'AssertionError: expected false to equal true',
  isolation_applied: true,
};
const passing: IsolatedResult = {
  status: 0,
  signal: null,
  stdout: 'one registered test passed',
  stderr: '',
  isolation_applied: true,
};

describe('CLI shard 09 verify translation recovery and execution', () => {
  let harness: Harness;

  beforeAll(() => {
    harness = createHarness();
  });

  beforeEach(() => {
    controls.isolated = [assertionFailure, passing];
    controls.linuxCalls = [];
    controls.droppedDatabases = [];
    controls.dropFailure = false;
    controls.spawnSync.mockImplementation(
      (command: string, args: readonly string[], options: Parameters<typeof nodeSpawnSync>[2]) => {
        if (command === 'sandbox-exec') {
          const result = controls.isolated.shift();
          if (result === undefined) throw new Error('UNEXPECTED_ISOLATED_EXECUTION');
          return result;
        }
        return nodeSpawnSync(command, [...args], options);
      },
    );
  });

  afterEach(() => {
    controls.spawnSync.mockReset();
  });

  afterAll(() => harness.cleanup());

  it('executes base and candidate in disposable worktrees and reports exact cleanup custody', async () => {
    const result = await harness.validate();

    expect(result['executions']).toEqual([
      {
        phase: 'base',
        test_ref:
          'unit:packages/cli/tests/unit/translation-orchestration-fixture.test.js:translation changes behavior',
        outcome: 'fail',
        failure_mode: 'assertion',
        evidence_ref: expect.stringMatching(/^EV-[a-f0-9]{16}$/u),
      },
      {
        phase: 'candidate',
        test_ref:
          'unit:packages/cli/tests/unit/translation-orchestration-fixture.test.js:translation changes behavior',
        outcome: 'pass',
        failure_mode: 'none',
        evidence_ref: expect.stringMatching(/^EV-[a-f0-9]{16}$/u),
      },
    ]);
    expect(result['cleanup']).toEqual({
      lease_id: expect.stringMatching(/^TVL-[a-f0-9]{16}$/u),
      worktree: 'removed',
      database: 'removed',
      recovery_scan: 'clean',
    });
    expect(result['frames']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'red-proof', status: 'PASS' }),
        expect.objectContaining({ name: 'infrastructure', status: 'PASS' }),
        expect.objectContaining({ name: 'cleanup', status: 'PASS' }),
      ]),
    );
    expect(result['isolation']).toEqual(
      platform() === 'linux'
        ? {
            mode: 'linux-container-no-network',
            network_egress: 'denied',
            database: 'per-task-database',
            readiness_eligible: true,
          }
        : {
            mode: 'macos-best-effort',
            network_egress: 'not-proven',
            database: 'per-task-database',
            readiness_eligible: false,
          },
    );
    expect(result['verdict']).toBe('FAIL');
    expect(existsSync(resolve(harness.root, '.devai/worktrees'))).toBe(true);
    const leaseId = (result['cleanup'] as { lease_id: string }).lease_id;
    expect((result['expected_diff'] as { observed: unknown }).observed).toEqual(
      expect.arrayContaining([
        { path: `.devai/state/translation-validation/leases/${leaseId}.json`, operation: 'create' },
        { path: `.devai/state/translation-validation/leases/${leaseId}.json`, operation: 'retire' },
        { path: RECIPE_PATH, operation: 'append' },
      ]),
    );
    expect(
      existsSync(
        resolve(harness.root, `.devai/state/translation-validation/leases/${leaseId}.json`),
      ),
    ).toBe(false);

    if (platform() === 'linux') {
      expect(controls.linuxCalls).toHaveLength(2);
      expect(controls.linuxCalls.map((call) => call.argv)).toEqual([
        ['node', '--test', '--test-name-pattern', 'translation changes behavior', TEST_PATH],
        ['node', '--test', '--test-name-pattern', 'translation changes behavior', TEST_PATH],
      ]);
      expect(controls.linuxCalls[0]?.repo_root).toMatch(/\.devai\/worktrees\/WT-TV-/u);
    }
  });

  it('recovers exact prior lease resources before provisioning the current validation', async () => {
    const suffix = '0123456789abcdef';
    const leasePath = `.devai/state/translation-validation/leases/TVL-${suffix}.json`;
    harness.writeJson(leasePath, {
      schemaVersion: '1.0.0',
      id: `TVL-${suffix}`,
      task_id: 'TASK-9003',
      worktree_id: `WT-TV-${suffix}`,
      worktree_path: `.devai/worktrees/WT-TV-${suffix}`,
      database: `devai_task_TV_${suffix}`,
      base_sha: harness.base,
      created_at: '2026-09-07T00:00:00.000Z',
    });

    const result = await harness.validate();

    expect(result['cleanup']).toEqual({
      lease_id: expect.stringMatching(/^TVL-[a-f0-9]{16}$/u),
      worktree: 'removed',
      database: 'removed',
      recovery_scan: 'recovered',
      recovered_lease_ids: [`TVL-${suffix}`],
    });
    expect(controls.droppedDatabases).toEqual([
      `devai_task_TV_${suffix}`,
      expect.stringMatching(/^devai_task_TV_[a-f0-9]{16}$/u),
    ]);
    expect(existsSync(resolve(harness.root, leasePath))).toBe(false);
  });

  it('preserves explicit and fallback database recovery failures without retiring the lease', async () => {
    const suffix = 'fedcba9876543210';
    const leasePath = `.devai/state/translation-validation/leases/TVL-${suffix}.json`;
    const writePriorLease = (): void =>
      harness.writeJson(leasePath, {
        schemaVersion: '1.0.0',
        id: `TVL-${suffix}`,
        task_id: 'TASK-9003',
        worktree_id: `WT-TV-${suffix}`,
        worktree_path: `.devai/worktrees/WT-TV-${suffix}`,
        database: `devai_task_TV_${suffix}`,
        base_sha: harness.base,
        created_at: '2026-09-07T00:00:00.000Z',
      });

    writePriorLease();
    controls.dropFailure = 'prior cleanup refused';
    await expect(harness.validate()).rejects.toThrow(
      `VALIDATION_RECOVERY_FAILED: TVL-${suffix}: RECOVERY_FAILED: prior cleanup refused`,
    );
    expect(existsSync(resolve(harness.root, leasePath))).toBe(true);

    controls.dropFailure = true;
    await expect(harness.validate()).rejects.toThrow(
      `VALIDATION_RECOVERY_FAILED: TVL-${suffix}: RECOVERY_FAILED: VALIDATION_DATABASE_DROP_FAILED`,
    );
    expect(controls.droppedDatabases).toEqual([
      `devai_task_TV_${suffix}`,
      `devai_task_TV_${suffix}`,
    ]);
    expect(existsSync(resolve(harness.root, leasePath))).toBe(true);
    rmSync(resolve(harness.root, leasePath), { force: true });
  });
});
