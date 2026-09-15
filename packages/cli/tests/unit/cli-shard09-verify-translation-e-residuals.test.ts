// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { executeTranslationValidation } from '../../src/commands/verify/translation.js';
import { createSelfContainedRepositoryFixture } from '../helpers/self-contained-repository-fixture.js';

const controls = vi.hoisted(() => ({
  append: vi.fn(),
  evaluate: vi.fn(),
  provision: 'fail' as 'fail' | 'pass',
}));

vi.mock('#runtime-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime-core.js')>();
  return {
    ...actual,
    appendVerbEvidence: (...args: unknown[]) => controls.append(...args),
    async dropValidationDatabase() {
      return { ok: true };
    },
    async provisionValidationDatabase(input: { readonly validation_id: string }) {
      if (controls.provision === 'fail') return { ok: false, error: 'test database unavailable' };
      return { ok: true, database: `devai_task_TV_${input.validation_id.slice(3)}` };
    },
    evaluateTranslationFrames: (...args: unknown[]) => controls.evaluate(...args),
  };
});

const ROOT = resolve(import.meta.dirname, '../../../..');
const WITNESS_PATH = 'scratch/translation-e-residuals-witness.json';
const RECIPE_PATH = 'record/proofs/work/recipe-runs/devai-fix/test/2026-09-11T00-00-00-000Z.json';
const SOURCE_PATH = 'packages/cli/src/translation-e-residuals-fixture.ts';
const INVARIANT_ID = 'INV-DEMO-009';
const WITNESS_ID = 'TW-eeeeeeeeeeeeeeee';

let fixture: ReturnType<typeof createSelfContainedRepositoryFixture>;
let repository: string;
let witness: Record<string, unknown>;

function writeJson(path: string, value: unknown): void {
  const absolute = resolve(repository, path);
  mkdirSync(resolve(absolute, '..'), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function bindWitness(): void {
  writeJson(WITNESS_PATH, witness);
  writeJson(RECIPE_PATH, {
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    status: 'pass',
    evidence: { translation_witness: witness },
  });
}

function frameEvaluation(expectedDiff: 'PASS' | 'FAIL') {
  return {
    verdict: 'REVIEW' as const,
    executed_test_refs: [],
    frames: [
      { name: 'witness-structure', status: 'PASS' as const, evidence_refs: [] },
      { name: 'no-op', status: 'PASS' as const, evidence_refs: [] },
      { name: 'red-proof', status: 'PASS' as const, evidence_refs: [] },
      {
        name: 'candidate-proof',
        status: 'REVIEW' as const,
        evidence_refs: [],
        finding: 'No trusted deterministic structural adapter is registered.',
      },
      { name: 'scope', status: 'PASS' as const, evidence_refs: [] },
      { name: 'authority', status: 'PASS' as const, evidence_refs: [] },
      { name: 'test-weakening', status: 'PASS' as const, evidence_refs: [] },
      { name: 'inventory', status: 'PASS' as const, evidence_refs: [] },
      { name: 'effects', status: 'PASS' as const, evidence_refs: [] },
      { name: 'strategy-coverage', status: 'PASS' as const, evidence_refs: [] },
      {
        name: 'expected-diff',
        status: expectedDiff,
        evidence_refs: [],
        ...(expectedDiff === 'FAIL'
          ? { finding: 'Observed state changes differ from the trusted manifest.' }
          : {}),
      },
    ],
  };
}

async function validate(): Promise<Record<string, unknown>> {
  bindWitness();
  return withAuthorityHostTestScope(() =>
    executeTranslationValidation({
      witness: WITNESS_PATH,
      repoRoot: repository,
      databaseUrl: 'postgres://unused',
    }),
  );
}

beforeAll(() => {
  fixture = createSelfContainedRepositoryFixture(ROOT);
  repository = fixture.root;
  writeJson(`law/invariants/${INVARIANT_ID}.json`, {
    schemaVersion: '1.0.0',
    id: INVARIANT_ID,
    domain: 'DEMO',
    lifecycle: 'supported',
    severity: 'gate',
    type: 'validation',
    title: 'Translation report evidence boundary',
    statement: 'A structural validator may return a review-only translation result.',
    status: 'active',
    verification: {
      required_suites: ['unit'],
      oracle: 'static_analysis',
      strategy: {
        primary: 'structural',
        deterministic_check_available: true,
        rationale: 'The fixture isolates report-only result assembly.',
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
    invariants: [{ id: INVARIANT_ID, tests: [], code_areas: [SOURCE_PATH] }],
    test_corpus: [],
  });
  fixture.git(['add', '--force', '--', `law/invariants/${INVARIANT_ID}.json`, 'law/trace.json']);
  fixture.git(['commit', '--quiet', '-m', 'add structural translation strategy']);
  const base = fixture.git(['rev-parse', 'HEAD']);
  writeJson(SOURCE_PATH, 'export const translationResidual = true;\n');
  fixture.git(['add', '--force', '--', SOURCE_PATH]);
  fixture.git(['commit', '--quiet', '-m', 'add translation residual fixture']);
  const candidate = fixture.git(['rev-parse', 'HEAD']);
  witness = {
    schemaVersion: '1.0.0',
    id: WITNESS_ID,
    trust: 'untrusted-claim',
    task_id: 'TASK-9009',
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    stage: 'invariants-tests-to-code',
    base_sha: base,
    candidate_sha: candidate,
    emitted_at: '2026-09-11T00:00:00.000Z',
    strategy: 'structural',
    implements: [
      {
        invariant_id: INVARIANT_ID,
        criteria: [
          {
            claim: 'The report-only translation result preserves its evidence boundary.',
            demonstrated_by: [{ kind: 'structural', validator: 'check --only action-effects' }],
          },
        ],
      },
    ],
    touched: [SOURCE_PATH],
    frame: {
      authority_role: 'engineer',
      spec_edits: 'none',
      test_edits: 'none',
      inventory_delta_confined_to: ['MOD-CLI'],
      effects_claimed: ['fs:plant'],
    },
  };
  writeJson('.devai/state/tasks/TASK-9009.json', {
    schemaVersion: '2.0.0',
    id: 'TASK-9009',
    round_id: 'R-0007',
    status: 'in_progress',
    discipline: 'engineer',
    title: 'Exercise translation report evidence boundary',
    target_modules: ['MOD-CLI'],
    target_substrates: ['F2'],
    created_at: '2026-09-11T00:00:00.000Z',
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
    intent_diff: { planned_files: ['packages/cli/src/**'] },
  });
  writeJson('record/proofs/chain.json', { head: null, records: [] });
});

beforeEach(() => {
  controls.provision = 'fail';
  controls.append.mockReset();
  controls.append.mockReturnValue({ ok: true, id: 'EV-0123456789abcdef' });
  controls.evaluate.mockReset();
  controls.evaluate.mockImplementation(() => frameEvaluation('FAIL'));
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => fixture?.cleanup());

describe('translation validation E residuals', () => {
  it('binds a failed preliminary verdict, immutable report-only notes, and result artifact to evidence', async () => {
    const result = await validate();
    expect(result['verdict']).toBe('FAIL');
    expect(result['report_only']).toBe(true);
    expect(result['readiness_eligible']).toBe(false);
    expect(result['evidence_chain_refs']).toEqual(['EV-0123456789abcdef']);
    expect(controls.append).toHaveBeenCalledTimes(1);
    expect(controls.append).toHaveBeenCalledWith({
      repoRoot: repository,
      action: 'verify.translation',
      status: 'failed',
      artifacts: [
        {
          path: expect.stringMatching(
            /^\.devai\/state\/translation-validation\/results\/VR-[a-f0-9]{16}\.json$/u,
          ),
          sha256: null,
          kind: 'validation-result',
        },
      ],
      notes: [
        `witness=${WITNESS_ID}`,
        'verdict=FAIL',
        'report_only=true',
        'readiness_eligible=false',
      ],
    });
  });

  it('records a completed evidence event for a review-only preliminary result before final schema reconciliation', async () => {
    controls.provision = 'pass';
    controls.evaluate.mockImplementation(() => frameEvaluation('PASS'));
    await expect(validate()).rejects.toThrow('VALIDATION_RESULT_INVALID');
    expect(controls.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ strategy_coverage: { status: 'pass' } }),
    );
    expect(controls.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'verify.translation',
        status: 'completed',
        notes: expect.arrayContaining(['verdict=REVIEW', 'report_only=true']),
      }),
    );
  });

  it('fails closed with the evidence error or stable fallback when the append is refused', async () => {
    controls.append.mockReturnValueOnce({ ok: false, error: 'certificate append denied' });
    await expect(validate()).rejects.toThrow('certificate append denied');

    controls.append.mockReturnValueOnce({ ok: false });
    await expect(validate()).rejects.toThrow('VALIDATION_EVIDENCE_APPEND_FAILED');
  });
});
