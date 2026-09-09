import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { executeTranslationValidation } from '../../src/commands/verify/translation.js';
import { createSelfContainedRepositoryFixture } from '../helpers/self-contained-repository-fixture.js';

const observations = vi.hoisted(() => ({ strategyCoverageStatuses: [] as string[] }));

vi.mock('#runtime-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime-core.js')>();
  return {
    ...actual,
    evaluateTranslationFrames(
      input: Parameters<typeof actual.evaluateTranslationFrames>[0],
    ): ReturnType<typeof actual.evaluateTranslationFrames> {
      observations.strategyCoverageStatuses.push(input.strategy_coverage.status);
      return actual.evaluateTranslationFrames(input);
    },
  };
});

const ROOT = resolve(import.meta.dirname, '../../../..');
const WITNESS_PATH = 'scratch/translation-feature-overlay-witness.json';
const RECIPE_PATH = 'record/proofs/work/recipe-runs/devai-fix/test/2026-07-27T00-00-00-000Z.json';
const TEST_PATH = 'packages/cli/tests/unit/translation-overlay.test.ts';
const SOURCE_PATH = 'packages/cli/src/translation-overlay.ts';
const TEST_REF = {
  suite: 'unit',
  path: TEST_PATH,
  names: ['overlay behavior', 'secondary behavior'],
} as const;

let fixture: ReturnType<typeof createSelfContainedRepositoryFixture>;
let repository: string;
let baseCommit: string;
let overlayCommit: string;
let candidateCommit: string;

function writeText(path: string, value: string): void {
  const absolute = resolve(repository, path);
  mkdirSync(resolve(absolute, '..'), { recursive: true });
  writeFileSync(absolute, value);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function task(
  plannedFiles: readonly string[] | undefined = [SOURCE_PATH],
): Record<string, unknown> {
  return {
    schemaVersion: '2.0.0',
    id: 'TASK-9002',
    round_id: 'R-0007',
    status: 'in_progress',
    discipline: 'engineer',
    title: 'Exercise feature overlay validation',
    target_modules: ['MOD-CLI'],
    target_substrates: ['F2'],
    created_at: '2026-07-27T00:00:00.000Z',
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
    intent_diff: plannedFiles === undefined ? {} : { planned_files: plannedFiles },
  };
}

function witness(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id: 'TW-fedcba9876543210',
    trust: 'untrusted-claim',
    task_id: 'TASK-9002',
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    stage: 'invariants-tests-to-code',
    base_sha: baseCommit,
    test_overlay_sha: overlayCommit,
    candidate_sha: candidateCommit,
    emitted_at: '2026-07-27T00:00:00.000Z',
    strategy: 'feature-overlay',
    implements: [
      {
        invariant_id: 'INV-DEMO-001',
        criteria: [
          {
            claim: 'The candidate preserves the registered overlay behavior.',
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
      test_edits: 'declared',
      inventory_delta_confined_to: ['MOD-CLI'],
      effects_claimed: ['fs:plant'],
    },
    ...overrides,
  };
}

function bindWitness(value: Record<string, unknown>): void {
  writeJson(WITNESS_PATH, value);
  writeJson(RECIPE_PATH, {
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    status: 'pass',
    evidence: { translation_witness: value },
  });
}

async function validate(value: Record<string, unknown>): Promise<Record<string, unknown>> {
  bindWitness(value);
  return withAuthorityHostTestScope(() =>
    executeTranslationValidation({
      witness: WITNESS_PATH,
      repoRoot: repository,
      databaseUrl: 'postgres://127.0.0.1:1/postgres?connect_timeout=1',
    }),
  );
}

beforeAll(() => {
  fixture = createSelfContainedRepositoryFixture(ROOT);
  repository = fixture.root;
  writeJson('law/invariants/INV-DEMO-001.json', {
    schemaVersion: '1.0.0',
    id: 'INV-DEMO-001',
    domain: 'DEMO',
    lifecycle: 'supported',
    severity: 'gate',
    type: 'validation',
    title: 'Registered overlay behavior',
    statement: 'The registered overlay test must exercise the candidate behavior.',
    status: 'active',
    verification: {
      required_suites: ['unit'],
      oracle: 'tests',
      strategy: {
        primary: 'feature-overlay',
        deterministic_check_available: true,
        rationale: 'The registered overlay test is deterministic.',
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
    invariants: [
      { id: 'INV-DEMO-001', tests: [TEST_REF], code_areas: [SOURCE_PATH] },
      { id: 'INV-OTHER-002', tests: [], code_areas: ['packages/other/**'] },
    ],
    test_corpus: [],
  });
  fixture.git(['add', '--force', '--', 'law/invariants/INV-DEMO-001.json', 'law/trace.json']);
  fixture.git(['commit', '--quiet', '-m', 'add registered translation strategy']);
  baseCommit = fixture.git(['rev-parse', 'HEAD']);

  writeText(
    TEST_PATH,
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('overlay behavior', () => assert.equal(1, 1));",
      "test('secondary behavior', () => assert.equal(2, 2));",
      '',
    ].join('\n'),
  );
  fixture.git(['add', '--force', '--', TEST_PATH]);
  fixture.git(['commit', '--quiet', '-m', 'add test overlay']);
  overlayCommit = fixture.git(['rev-parse', 'HEAD']);

  writeText(SOURCE_PATH, 'export const overlayBehavior = true;\n');
  fixture.git(['add', '--force', '--', SOURCE_PATH]);
  fixture.git(['commit', '--quiet', '-m', 'implement overlay behavior']);
  candidateCommit = fixture.git(['rev-parse', 'HEAD']);
  writeJson('.devai/state/tasks/TASK-9002.json', task());
  writeJson('record/proofs/chain.json', { head: null, records: [] });
});

afterAll(() => fixture?.cleanup());

beforeEach(() => {
  observations.strategyCoverageStatuses.length = 0;
});

describe('translation feature-overlay validation', () => {
  it('reaches valid strategy-frame evaluation through the sanctioned read-only rev-list scope', async () => {
    await expect(validate(witness())).rejects.toThrow('VALIDATION_RESULT_INVALID');
    expect(observations.strategyCoverageStatuses).toEqual(['pass', 'pass']);
  });

  it('refuses a same-length test ref when only one registered name matches', async () => {
    const changedRef = { ...TEST_REF, names: ['overlay behavior', 'different behavior'] };
    const value = witness({
      red_green: [
        {
          test_ref: changedRef,
          expected_at_base: 'assertion-fail',
          expected_at_candidate: 'pass',
        },
      ],
      implements: [
        {
          invariant_id: 'INV-DEMO-001',
          criteria: [
            {
              claim: 'A differently named test is not the registered test.',
              demonstrated_by: [{ kind: 'test', test_ref: changedRef }],
            },
          ],
        },
      ],
    });

    await expect(validate(value)).rejects.toThrow(
      'TRANSLATION_TEST_REF_UNREGISTERED: ' +
        'unit:packages/cli/tests/unit/translation-overlay.test.ts:' +
        'overlay behavior > different behavior',
    );
  });

  it('refuses malformed task state, absent task scope, and substituted recipe evidence', async () => {
    const value = witness();
    bindWitness(value);
    writeJson('.devai/state/tasks/TASK-9002.json', { id: 'TASK-9002' });
    await expect(
      withAuthorityHostTestScope(() =>
        executeTranslationValidation({
          witness: WITNESS_PATH,
          repoRoot: repository,
          databaseUrl: 'postgres://unused',
        }),
      ),
    ).rejects.toThrow('TRANSLATION_TASK_INVALID');

    writeJson('.devai/state/tasks/TASK-9002.json', task([]));
    await expect(validate(value)).rejects.toThrow('TRANSLATION_TASK_SCOPE_MISSING');

    writeJson('.devai/state/tasks/TASK-9002.json', task());
    bindWitness(value);
    writeJson(RECIPE_PATH, {
      recipe_name: 'devai-fix',
      recipe_variant: 'test',
      status: 'pass',
      evidence: { translation_witness: { ...value, candidate_sha: '0'.repeat(40) } },
    });
    await expect(
      withAuthorityHostTestScope(() =>
        executeTranslationValidation({
          witness: WITNESS_PATH,
          repoRoot: repository,
          databaseUrl: 'postgres://unused',
        }),
      ),
    ).rejects.toThrow('TRANSLATION_RECIPE_RECORD_WITNESS_MISMATCH');
  });

  it('refuses missing exact base and overlay objects before ancestry evaluation', async () => {
    await expect(validate(witness({ base_sha: '0'.repeat(40) }))).rejects.toThrow(
      'BASE_OBJECT_INVALID',
    );
    await expect(validate(witness({ test_overlay_sha: '0'.repeat(40) }))).rejects.toThrow(
      'TEST_OVERLAY_OBJECT_INVALID',
    );
  });
});
