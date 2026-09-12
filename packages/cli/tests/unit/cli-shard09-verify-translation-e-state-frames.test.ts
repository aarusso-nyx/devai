// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { createSelfContainedRepositoryFixture } from '../helpers/self-contained-repository-fixture.js';

interface ProcessResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly isolation_applied: boolean;
}

const controls = vi.hoisted(() => ({
  append: vi.fn(),
  dropOk: true,
  evaluations: [] as Record<string, unknown>[],
  linuxResults: [] as ProcessResult[],
  platform: 'linux',
  provision: 'pass' as 'pass' | 'fail',
  removeFailures: 0,
  sandbox: { status: 0, signal: null, stdout: 'ok', stderr: '' },
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: () => controls.platform,
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    spawnSync(
      command: string,
      args: readonly string[],
      options: Parameters<typeof nodeSpawnSync>[2],
    ) {
      if (command === 'sandbox-exec') return { ...controls.sandbox };
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        if (controls.removeFailures > 0) {
          controls.removeFailures -= 1;
          return { status: 1, signal: null, stdout: '', stderr: 'controlled removal refusal' };
        }
        return nodeSpawnSync(command, [...args], options);
      }
      const writesWorktree =
        command === 'git' && args[0] === 'worktree' && (args[1] === 'add' || args[1] === 'prune');
      return writesWorktree
        ? nodeSpawnSync(command, [...args], options)
        : actual.spawnSync(command, [...args], options);
    },
  };
});

vi.mock('#runtime-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime-core.js')>();
  return {
    ...actual,
    appendVerbEvidence: (...args: unknown[]) => controls.append(...args),
    async dropValidationDatabase() {
      return { ok: controls.dropOk };
    },
    evaluateTranslationFrames(input: Record<string, unknown>) {
      controls.evaluations.push(structuredClone(input));
      const strategy = (input['witness'] as { strategy: string }).strategy;
      return {
        verdict: 'FAIL' as const,
        executed_test_refs: [],
        frames: [
          { name: 'witness-structure', status: 'PASS' as const, evidence_refs: [] },
          { name: 'no-op', status: 'PASS' as const, evidence_refs: [] },
          { name: 'red-proof', status: 'PASS' as const, evidence_refs: [] },
          {
            name: 'candidate-proof',
            status: strategy === 'structural' ? ('REVIEW' as const) : ('PASS' as const),
            evidence_refs: [],
            ...(strategy === 'structural'
              ? { finding: 'No trusted deterministic structural adapter is registered.' }
              : {}),
          },
          { name: 'scope', status: 'PASS' as const, evidence_refs: [] },
          { name: 'authority', status: 'PASS' as const, evidence_refs: [] },
          { name: 'test-weakening', status: 'PASS' as const, evidence_refs: [] },
          { name: 'inventory', status: 'PASS' as const, evidence_refs: [] },
          { name: 'effects', status: 'PASS' as const, evidence_refs: [] },
          { name: 'strategy-coverage', status: 'PASS' as const, evidence_refs: [] },
          {
            name: 'expected-diff',
            status: 'FAIL' as const,
            evidence_refs: [],
            finding: 'Observed state changes differ from the trusted manifest.',
          },
        ],
      };
    },
    async provisionValidationDatabase(input: { readonly validation_id: string }) {
      return controls.provision === 'pass'
        ? { ok: true, database: `devai_task_TV_${input.validation_id.slice(3)}` }
        : { ok: false, error: 'controlled provisioning refusal' };
    },
    async runLinuxIsolated() {
      return (
        controls.linuxResults.shift() ?? {
          exit_code: 0,
          stdout: 'ok',
          stderr: '',
          isolation_applied: true,
        }
      );
    },
  };
});

import { executeTranslationValidation } from '../../src/commands/verify/translation.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const WITNESS_PATH = 'scratch/translation-e-state-frames-witness.json';
const RECIPE_PATH = 'record/proofs/work/recipe-runs/devai-fix/test/2026-09-12T01-00-00-000Z.json';
const SOURCE_PATH = 'packages/cli/src/translation-e-state-frames-fixture.ts';
const TEST_REFS = [
  {
    suite: 'unit',
    path: 'packages/cli/tests/unit/translation-e-state-frames-first.test.js',
    names: ['first registered behavior'],
  },
  {
    suite: 'unit',
    path: 'packages/cli/tests/unit/translation-e-state-frames-second.test.js',
    names: ['second registered behavior'],
  },
] as const;
const CANONICAL_REFS = TEST_REFS.map((ref) => `${ref.suite}:${ref.path}:${ref.names[0]}`);
const REGRESSION_INVARIANT = 'INV-DEMO-011';
const STRUCTURAL_INVARIANT = 'INV-DEMO-012';

let fixture: ReturnType<typeof createSelfContainedRepositoryFixture>;
let repository: string;
let baseCommit: string;
let candidateCommit: string;
let witnessSequence = 0;

function writeText(path: string, value: string): void {
  const absolute = resolve(repository, path);
  mkdirSync(resolve(absolute, '..'), { recursive: true });
  writeFileSync(absolute, value);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function invariant(id: string, strategy: 'regression' | 'structural') {
  return {
    schemaVersion: '1.0.0',
    id,
    domain: 'DEMO',
    lifecycle: 'supported',
    severity: 'gate',
    type: 'validation',
    title: `${strategy} state and frame behavior`,
    statement: 'Translation state and frame evidence remains exact.',
    status: 'active',
    verification: {
      required_suites: ['unit'],
      oracle: strategy === 'regression' ? 'automated_tests' : 'static_analysis',
      strategy: {
        primary: strategy,
        deterministic_check_available: true,
        rationale: 'The fixture isolates result state and frame assembly.',
      },
    },
    authority_docs: { docs: [{ doc: 'README.md', anchor: 'testing' }] },
    scope: { components: ['cli'], code_areas: [SOURCE_PATH], modules: ['MOD-CLI'] },
    change_policy: {
      breaking_change_requires: ['test_update'],
      test_weakening_allowed: false,
      human_approval_required: false,
    },
  };
}

function makeWitness(strategy: 'regression' | 'structural'): Record<string, unknown> {
  witnessSequence += 1;
  const id = `TW-${witnessSequence.toString(16).padStart(16, '0')}`;
  const testBacked = strategy === 'regression';
  return {
    schemaVersion: '1.0.0',
    id,
    trust: 'untrusted-claim',
    task_id: 'TASK-9012',
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    stage: 'invariants-tests-to-code',
    base_sha: baseCommit,
    candidate_sha: candidateCommit,
    emitted_at: '2026-09-12T01:00:00.000Z',
    strategy,
    implements: [
      {
        invariant_id: testBacked ? REGRESSION_INVARIANT : STRUCTURAL_INVARIANT,
        criteria: [
          {
            claim: 'The report preserves exact state and frame evidence.',
            demonstrated_by: testBacked
              ? TEST_REFS.map((test_ref) => ({ kind: 'test', test_ref }))
              : [{ kind: 'structural', validator: 'check --only action-effects' }],
          },
        ],
      },
    ],
    ...(testBacked
      ? {
          red_green: TEST_REFS.map((test_ref) => ({
            test_ref,
            expected_at_base: 'assertion-fail',
            expected_at_candidate: 'pass',
          })),
        }
      : {}),
    touched: [SOURCE_PATH],
    frame: {
      authority_role: 'engineer',
      spec_edits: 'none',
      test_edits: 'none',
      inventory_delta_confined_to: ['MOD-CLI'],
      effects_claimed: ['fs:plant'],
    },
  };
}

async function validate(
  strategy: 'regression' | 'structural' = 'regression',
): Promise<Record<string, unknown>> {
  return validateWitness(makeWitness(strategy));
}

async function validateWitness(witness: Record<string, unknown>): Promise<Record<string, unknown>> {
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
      repoRoot: repository,
      databaseUrl: 'postgres://unused',
    }),
  );
}

function frame(result: Record<string, unknown>, name: string): Record<string, unknown> {
  const found = (result['frames'] as Record<string, unknown>[]).find(
    (candidate) => candidate['name'] === name,
  );
  if (found === undefined) throw new Error(`missing ${name} frame`);
  return found;
}

function onlyPreliminaryEvaluation(): Record<string, unknown> {
  expect(controls.evaluations).toHaveLength(2);
  const evaluation = controls.evaluations[0];
  if (evaluation === undefined) throw new Error('preliminary evaluation missing');
  return evaluation;
}

beforeAll(() => {
  fixture = createSelfContainedRepositoryFixture(ROOT);
  repository = fixture.root;
  writeJson(
    `law/invariants/${REGRESSION_INVARIANT}.json`,
    invariant(REGRESSION_INVARIANT, 'regression'),
  );
  writeJson(
    `law/invariants/${STRUCTURAL_INVARIANT}.json`,
    invariant(STRUCTURAL_INVARIANT, 'structural'),
  );
  writeJson('law/trace.json', {
    schemaVersion: '1.0.0',
    version: '1.0.0',
    invariants: [
      { id: REGRESSION_INVARIANT, tests: TEST_REFS, code_areas: [SOURCE_PATH] },
      { id: STRUCTURAL_INVARIANT, tests: [], code_areas: [SOURCE_PATH] },
    ],
    test_corpus: [],
  });
  for (const ref of TEST_REFS) {
    writeText(ref.path, `import { test } from 'node:test';\ntest('${ref.names[0]}', () => {});\n`);
  }
  writeText(SOURCE_PATH, 'export const stateFrameBehavior = false;\n');
  fixture.git(['add', '--force', '--', 'law', 'packages']);
  fixture.git(['commit', '--quiet', '-m', 'establish state and frame baseline']);
  baseCommit = fixture.git(['rev-parse', 'HEAD']);
  writeText(SOURCE_PATH, 'export const stateFrameBehavior = true;\n');
  fixture.git(['add', '--force', '--', SOURCE_PATH]);
  fixture.git(['commit', '--quiet', '-m', 'implement state and frame behavior']);
  candidateCommit = fixture.git(['rev-parse', 'HEAD']);
  writeJson('.devai/state/tasks/TASK-9012.json', {
    schemaVersion: '2.0.0',
    id: 'TASK-9012',
    round_id: 'R-0007',
    status: 'in_progress',
    discipline: 'engineer',
    title: 'Exercise translation state and frame evidence',
    target_modules: ['MOD-CLI'],
    target_substrates: ['F2'],
    created_at: '2026-09-12T01:00:00.000Z',
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
});

beforeEach(() => {
  controls.append.mockReset();
  controls.append.mockReturnValue({ ok: true, id: 'EV-eeeeeeeeeeeeeeee' });
  controls.dropOk = true;
  controls.evaluations = [];
  controls.linuxResults = [];
  controls.platform = 'linux';
  controls.provision = 'pass';
  controls.removeFailures = 0;
  controls.sandbox = { status: 0, signal: null, stdout: 'ok', stderr: '' };
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => fixture?.cleanup());

describe('translation validation E state and frame boundaries', () => {
  it('filters exact infrastructure executions and preserves their ordered fallback finding', async () => {
    controls.platform = 'sunos';

    const result = await validate();

    expect(result['executions']).toEqual(
      [
        ...CANONICAL_REFS.map((test_ref) => ({ phase: 'base', test_ref })),
        ...CANONICAL_REFS.map((test_ref) => ({ phase: 'candidate', test_ref })),
      ].map((execution) => ({
        ...execution,
        outcome: 'crash',
        failure_mode: 'infrastructure',
        evidence_ref: 'EV-eeeeeeeeeeeeeeee',
      })),
    );
    expect(frame(result, 'infrastructure')).toEqual({
      name: 'infrastructure',
      status: 'FAIL',
      evidence_refs: ['EV-eeeeeeeeeeeeeeee'],
      finding: `Validation infrastructure failed: REGISTERED_EXECUTION_INFRASTRUCTURE_FAILURE:${[
        ...CANONICAL_REFS,
        ...CANONICAL_REFS,
      ].join(',')}`,
    });
    expect(frame(result, 'network-egress')).toEqual({
      name: 'network-egress',
      status: 'REVIEW',
      evidence_refs: ['EV-eeeeeeeeeeeeeeee'],
      finding: 'Native isolation is best-effort; network denial is not proven.',
    });
  });

  it('proves network denial only for successful Linux isolation proofs', async () => {
    const proven = await validate();
    expect(frame(proven, 'network-egress')).toEqual({
      name: 'network-egress',
      status: 'PASS',
      evidence_refs: ['EV-eeeeeeeeeeeeeeee'],
    });
    expect(proven['isolation']).toEqual({
      mode: 'linux-container-no-network',
      network_egress: 'denied',
      database: 'per-task-database',
      readiness_eligible: true,
    });

    controls.evaluations = [];
    const noExecution = await validate('structural');
    expect(frame(noExecution, 'network-egress')).toEqual({
      name: 'network-egress',
      status: 'REVIEW',
      evidence_refs: ['EV-eeeeeeeeeeeeeeee'],
      finding: 'Registered execution did not reach the Linux isolation boundary.',
    });
    expect(noExecution['executions']).toEqual([]);

    controls.evaluations = [];
    controls.linuxResults = Array.from({ length: 4 }, () => ({
      exit_code: 0,
      stdout: 'ran without an isolation receipt',
      stderr: '',
      isolation_applied: false,
    }));
    const unproven = await validate();
    expect(frame(unproven, 'network-egress')).toEqual({
      name: 'network-egress',
      status: 'REVIEW',
      evidence_refs: ['EV-eeeeeeeeeeeeeeee'],
      finding: 'Linux isolation proof is unavailable because validation infrastructure failed.',
    });
    expect(frame(unproven, 'infrastructure')).toEqual({
      name: 'infrastructure',
      status: 'FAIL',
      evidence_refs: ['EV-eeeeeeeeeeeeeeee'],
      finding: 'Validation infrastructure failed: LINUX_ISOLATION_NOT_APPLIED',
    });
  });

  it('withholds network proof when successful and failed Linux receipts are mixed', async () => {
    controls.linuxResults = [
      { exit_code: 0, stdout: 'isolated', stderr: '', isolation_applied: true },
      { exit_code: 0, stdout: 'unverified', stderr: '', isolation_applied: false },
      { exit_code: 0, stdout: 'isolated', stderr: '', isolation_applied: true },
      { exit_code: 0, stdout: 'unverified', stderr: '', isolation_applied: false },
    ];

    const mixed = await validate();

    expect(frame(mixed, 'infrastructure')).toEqual({
      name: 'infrastructure',
      status: 'FAIL',
      evidence_refs: ['EV-eeeeeeeeeeeeeeee'],
      finding: 'Validation infrastructure failed: LINUX_ISOLATION_NOT_APPLIED',
    });
    expect(frame(mixed, 'network-egress')).toEqual({
      name: 'network-egress',
      status: 'REVIEW',
      evidence_refs: ['EV-eeeeeeeeeeeeeeee'],
      finding: 'Linux isolation proof is unavailable because validation infrastructure failed.',
    });
    expect(mixed['isolation']).toEqual(
      expect.objectContaining({ network_egress: 'not-proven', readiness_eligible: false }),
    );
  });

  it('distinguishes native best effort from Linux zero-attempt infrastructure failure', async () => {
    controls.platform = 'darwin';
    const native = await validate('structural');
    expect(frame(native, 'network-egress')['finding']).toBe(
      'Native isolation is best-effort; network denial is not proven.',
    );

    controls.evaluations = [];
    controls.platform = 'linux';
    controls.provision = 'fail';
    const blocked = await validate();
    expect(frame(blocked, 'infrastructure')['finding']).toBe(
      'Validation infrastructure failed: controlled provisioning refusal',
    );
    expect(frame(blocked, 'network-egress')['finding']).toBe(
      'Registered execution did not reach the Linux isolation boundary.',
    );
  });

  it('requires both worktree and database cleanup before retiring the current lease', async () => {
    const clean = await validate();
    const cleanLease = (clean['cleanup'] as { lease_id: string }).lease_id;
    expect(frame(clean, 'cleanup')).toEqual({
      name: 'cleanup',
      status: 'PASS',
      evidence_refs: ['EV-eeeeeeeeeeeeeeee'],
    });
    expect(
      existsSync(
        resolve(repository, `.devai/state/translation-validation/leases/${cleanLease}.json`),
      ),
    ).toBe(false);

    controls.evaluations = [];
    controls.dropOk = false;
    const databaseOrphan = await validate();
    const databaseLease = (databaseOrphan['cleanup'] as { lease_id: string }).lease_id;
    expect(databaseOrphan['cleanup']).toEqual({
      lease_id: databaseLease,
      worktree: 'removed',
      database: 'orphan-fail',
      recovery_scan: 'clean',
    });
    expect(frame(databaseOrphan, 'cleanup')).toEqual({
      name: 'cleanup',
      status: 'FAIL',
      evidence_refs: ['EV-eeeeeeeeeeeeeeee'],
      finding: 'Exact worktree or database cleanup could not be verified.',
    });
    expect(
      existsSync(
        resolve(repository, `.devai/state/translation-validation/leases/${databaseLease}.json`),
      ),
    ).toBe(true);
    rmSync(
      resolve(repository, `.devai/state/translation-validation/leases/${databaseLease}.json`),
      { force: true },
    );

    controls.evaluations = [];
    controls.dropOk = true;
    controls.removeFailures = 2;
    const worktreeOrphan = await validate();
    const worktreeLease = (worktreeOrphan['cleanup'] as { lease_id: string }).lease_id;
    expect(worktreeOrphan['cleanup']).toEqual({
      lease_id: worktreeLease,
      worktree: 'orphan-fail',
      database: 'removed',
      recovery_scan: 'clean',
    });
    expect(frame(worktreeOrphan, 'cleanup')).toEqual({
      name: 'cleanup',
      status: 'FAIL',
      evidence_refs: ['EV-eeeeeeeeeeeeeeee'],
      finding: 'Exact worktree or database cleanup could not be verified.',
    });
    expect(
      existsSync(
        resolve(repository, `.devai/state/translation-validation/leases/${worktreeLease}.json`),
      ),
    ).toBe(true);
    const worktreeSuffix = worktreeLease.slice('TVL-'.length);
    fixture.git([
      'worktree',
      'remove',
      '--force',
      resolve(repository, `.devai/worktrees/WT-TV-${worktreeSuffix}`),
    ]);
    rmSync(
      resolve(repository, `.devai/state/translation-validation/leases/${worktreeLease}.json`),
      { force: true },
    );
  });

  it('passes exact expected and provisional observed lifecycle state into frame evaluation', async () => {
    const priorSuffix = 'abcdabcdabcdabcd';
    const priorLeaseId = `TVL-${priorSuffix}`;
    writeJson(`.devai/state/translation-validation/leases/${priorLeaseId}.json`, {
      schemaVersion: '1.0.0',
      id: priorLeaseId,
      task_id: 'TASK-9012',
      worktree_id: `WT-TV-${priorSuffix}`,
      worktree_path: `.devai/worktrees/WT-TV-${priorSuffix}`,
      database: `devai_task_TV_${priorSuffix}`,
      base_sha: baseCommit,
      created_at: '2026-09-12T00:00:00.000Z',
    });

    const result = await validate('structural');
    const evaluation = onlyPreliminaryEvaluation();
    const validationId = result['id'] as string;
    const leaseId = (result['cleanup'] as { lease_id: string }).lease_id;
    const witnessId = result['witness_id'] as string;
    const expected = [
      { path: `.devai/state/translation-validation/leases/${leaseId}.json`, operation: 'create' },
      { path: `.devai/state/translation-validation/leases/${leaseId}.json`, operation: 'retire' },
      {
        path: `.devai/state/translation-validation/leases/${priorLeaseId}.json`,
        operation: 'retire',
      },
      {
        path: `record/proofs/compliance/translation-validation/results/${validationId}.json`,
        operation: 'create',
      },
      {
        path: `record/proofs/compliance/translation-validation/witnesses/${witnessId}.json`,
        operation: 'create',
      },
      { path: RECIPE_PATH, operation: 'append' },
      { path: 'record/proofs/chain.json', operation: 'append' },
    ].sort((left, right) =>
      `${left.path}:${left.operation}`.localeCompare(`${right.path}:${right.operation}`),
    );
    const observed = [
      { path: `.devai/state/translation-validation/leases/${leaseId}.json`, operation: 'create' },
      { path: `.devai/state/translation-validation/leases/${leaseId}.json`, operation: 'retire' },
      {
        path: `.devai/state/translation-validation/leases/${priorLeaseId}.json`,
        operation: 'retire',
      },
      {
        path: `.devai/state/translation-validation/results/${validationId}.json`,
        operation: 'create',
      },
      {
        path: `.devai/state/translation-validation/witnesses/${witnessId}.json`,
        operation: 'create',
      },
      { path: RECIPE_PATH, operation: 'append' },
      { path: 'record/proofs/chain.json', operation: 'append' },
    ].sort((left, right) =>
      `${left.path}:${left.operation}`.localeCompare(`${right.path}:${right.operation}`),
    );

    expect(evaluation).toEqual({
      witness: {
        strategy: 'structural',
        touched: [SOURCE_PATH],
        frame: {
          authority_role: 'engineer',
          spec_edits: 'none',
          test_edits: 'none',
          inventory_delta_confined_to: ['MOD-CLI'],
          effects_claimed: ['fs:plant'],
        },
        red_green: [],
      },
      registered_test_refs: [],
      task_scope: [SOURCE_PATH],
      diff_paths: [SOURCE_PATH],
      base_executions: [],
      candidate_executions: [],
      weakening_clean: true,
      inventory_delta_modules: ['MOD-CLI'],
      inferred_effects: ['fs:plant'],
      expected_state_changes: expected,
      observed_state_changes: observed,
      strategy_coverage: { status: 'pass' },
    });
    expect(result['expected_diff']).toEqual({
      manifest_digest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      expected,
      observed: observed.filter((change) => change.path !== 'record/proofs/chain.json'),
      unexpected: [
        {
          path: `.devai/state/translation-validation/results/${validationId}.json`,
          operation: 'create',
        },
        {
          path: `.devai/state/translation-validation/witnesses/${witnessId}.json`,
          operation: 'create',
        },
      ],
    });
    expect(result['cleanup']).toEqual({
      lease_id: leaseId,
      worktree: 'not-created',
      database: 'removed',
      recovery_scan: 'recovered',
      recovered_lease_ids: [priorLeaseId],
    });
  });

  it('passes an empty module inventory to both frame evaluations for a no-op diff', async () => {
    const noOpWitness = {
      ...makeWitness('structural'),
      candidate_sha: baseCommit,
    };

    const result = await validateWitness(noOpWitness);

    expect(controls.evaluations).toHaveLength(2);
    expect(controls.evaluations.map((evaluation) => evaluation['inventory_delta_modules'])).toEqual(
      [[], []],
    );
    expect(result['executions']).toEqual([]);
    expect(result['cleanup']).toEqual(
      expect.objectContaining({ worktree: 'not-created', database: 'removed' }),
    );
  });

  it('requires both a successful evidence append and a concrete evidence identity', async () => {
    controls.append.mockReturnValueOnce({ ok: false, id: 'EV-partial', error: 'append rejected' });
    await expect(validate('structural')).rejects.toThrow('append rejected');

    controls.append.mockReturnValueOnce({ ok: true });
    await expect(validate('structural')).rejects.toThrow('VALIDATION_EVIDENCE_APPEND_FAILED');
  });
});
