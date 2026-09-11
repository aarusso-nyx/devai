import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { executeTranslationValidation } from '../../src/commands/verify/translation.js';
import { createSelfContainedRepositoryFixture } from '../helpers/self-contained-repository-fixture.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const WITNESS_PATH = 'scratch/translation-shard-c-witness.json';
const RECIPE_PATH = 'record/proofs/work/recipe-runs/devai-fix/test/2026-09-11T01-00-00-000Z.json';
const TEST_PATH = 'packages/cli/tests/unit/translation-shard-c-primary.test.ts';
const SECONDARY_TEST_PATH = 'packages/cli/tests/unit/translation-shard-c-secondary.test.ts';
const LEGACY_TEST_PATH = 'packages/cli/tests/unit/translation-shard-c-legacy.test.ts';
const UNREGISTERED_TEST_PATH = 'packages/cli/tests/unit/translation-shard-c-unregistered.test.ts';
const SYMLINK_TEST_PATH = 'packages/cli/tests/unit/translation-shard-c-linked.test.ts';
const SOURCE_PATH = 'packages/cli/src/translation-shard-c-fixture.ts';
const TEST_REF = { suite: 'unit', path: TEST_PATH, names: ['primary behavior'] } as const;
const SECONDARY_TEST_REF = {
  suite: 'unit',
  path: SECONDARY_TEST_PATH,
  names: ['secondary behavior'],
} as const;
const SYMLINK_TEST_REF = {
  suite: 'unit',
  path: SYMLINK_TEST_PATH,
  names: ['linked behavior'],
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

function task(): Record<string, unknown> {
  return {
    schemaVersion: '2.0.0',
    id: 'TASK-9010',
    round_id: 'R-0007',
    status: 'in_progress',
    discipline: 'engineer',
    title: 'Exercise translation overlay boundaries',
    target_modules: ['MOD-CLI'],
    target_substrates: ['F2'],
    created_at: '2026-09-11T01:00:00.000Z',
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
  };
}

function witness(
  refs: readonly (typeof TEST_REF | typeof SECONDARY_TEST_REF | typeof SYMLINK_TEST_REF)[] = [
    TEST_REF,
  ],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id: 'TW-aabbccddeeff0011',
    trust: 'untrusted-claim',
    task_id: 'TASK-9010',
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    stage: 'invariants-tests-to-code',
    base_sha: baseCommit,
    test_overlay_sha: overlayCommit,
    candidate_sha: candidateCommit,
    emitted_at: '2026-09-11T01:00:00.000Z',
    strategy: 'feature-overlay',
    implements: [
      {
        invariant_id: 'INV-DEMO-010',
        criteria: [
          {
            claim: 'The overlay demonstrates the translated behavior.',
            demonstrated_by: refs.map((test_ref) => ({ kind: 'test', test_ref })),
          },
        ],
      },
    ],
    touched: [SOURCE_PATH],
    red_green: refs.map((test_ref) => ({
      test_ref,
      expected_at_base: 'assertion-fail',
      expected_at_candidate: 'pass',
    })),
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

async function validate(
  refs: readonly (typeof TEST_REF | typeof SECONDARY_TEST_REF | typeof SYMLINK_TEST_REF)[] = [
    TEST_REF,
  ],
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const value = witness(refs, overrides);
  bindWitness(value);
  return withAuthorityHostTestScope(() =>
    executeTranslationValidation({
      witness: WITNESS_PATH,
      repoRoot: repository,
      databaseUrl: 'postgres://unused',
    }),
  );
}

function beginOverlay(): void {
  rmSync(resolve(repository, RECIPE_PATH), { force: true });
  fixture.git(['checkout', '--quiet', '--detach', baseCommit]);
  writeText(TEST_PATH, "import { test } from 'node:test';\ntest('primary behavior', () => {});\n");
}

function finishScenario(message: string): void {
  fixture.git(['add', '--all', '--', 'packages/cli/tests/unit']);
  fixture.git(['commit', '--quiet', '-m', `${message} overlay`]);
  overlayCommit = fixture.git(['rev-parse', 'HEAD']);
  writeText(SOURCE_PATH, 'export const translated = true;\n');
  fixture.git(['add', '--', SOURCE_PATH]);
  fixture.git(['commit', '--quiet', '-m', `${message} candidate`]);
  candidateCommit = fixture.git(['rev-parse', 'HEAD']);
}

function finishTwoParentOverlayScenario(message: string): void {
  fixture.git(['add', '--all', '--', 'packages/cli/tests/unit']);
  fixture.git(['commit', '--quiet', '-m', `${message} overlay parent`]);
  const overlayParent = fixture.git(['rev-parse', 'HEAD']);
  fixture.git(['checkout', '--quiet', '--detach', baseCommit]);
  fixture.git(['merge', '--quiet', '--no-ff', '--no-commit', overlayParent]);
  fixture.git(['commit', '--quiet', '-m', `${message} two-parent overlay`]);
  overlayCommit = fixture.git(['rev-parse', 'HEAD']);
  writeText(SOURCE_PATH, 'export const translated = true;\n');
  fixture.git(['add', '--', SOURCE_PATH]);
  fixture.git(['commit', '--quiet', '-m', `${message} candidate`]);
  candidateCommit = fixture.git(['rev-parse', 'HEAD']);
}

function finishEmptyOverlay(message: string): void {
  fixture.git(['commit', '--quiet', '--allow-empty', '-m', `${message} overlay`]);
  overlayCommit = fixture.git(['rev-parse', 'HEAD']);
  writeText(SOURCE_PATH, 'export const translated = true;\n');
  fixture.git(['add', '--', SOURCE_PATH]);
  fixture.git(['commit', '--quiet', '-m', `${message} candidate`]);
  candidateCommit = fixture.git(['rev-parse', 'HEAD']);
}

function finishScenarioWithNonTestOverlayPath(message: string): void {
  writeText('README.md', 'This is not a test overlay path.\n');
  fixture.git(['add', '--all', '--', 'packages/cli/tests/unit', 'README.md']);
  fixture.git(['commit', '--quiet', '-m', `${message} overlay`]);
  overlayCommit = fixture.git(['rev-parse', 'HEAD']);
  writeText(SOURCE_PATH, 'export const translated = true;\n');
  fixture.git(['add', '--', SOURCE_PATH]);
  fixture.git(['commit', '--quiet', '-m', `${message} candidate`]);
  candidateCommit = fixture.git(['rev-parse', 'HEAD']);
}

beforeAll(() => {
  fixture = createSelfContainedRepositoryFixture(ROOT);
  repository = fixture.root;
  writeJson('law/invariants/INV-DEMO-010.json', {
    schemaVersion: '1.0.0',
    id: 'INV-DEMO-010',
    domain: 'DEMO',
    lifecycle: 'supported',
    severity: 'gate',
    type: 'validation',
    title: 'Translation overlay boundaries',
    statement: 'Only registered regular test files may form the test overlay.',
    status: 'active',
    verification: {
      required_suites: ['unit'],
      oracle: 'tests',
      strategy: {
        primary: 'feature-overlay',
        deterministic_check_available: true,
        rationale: 'The overlay boundary is determined by committed Git objects.',
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
  const registered = [
    TEST_REF,
    SECONDARY_TEST_REF,
    { suite: 'unit', path: LEGACY_TEST_PATH, names: ['legacy behavior'] },
    SYMLINK_TEST_REF,
  ];
  writeJson('law/trace.json', {
    schemaVersion: '1.0.0',
    version: '1.0.0',
    invariants: [{ id: 'INV-DEMO-010', tests: registered, code_areas: [SOURCE_PATH] }],
    test_corpus: [],
  });
  writeText(
    LEGACY_TEST_PATH,
    "import { test } from 'node:test';\ntest('legacy behavior', () => {});\n",
  );
  writeText(SOURCE_PATH, 'export const translated = false;\n');
  fixture.git([
    'add',
    '--force',
    '--',
    'law/invariants/INV-DEMO-010.json',
    'law/trace.json',
    LEGACY_TEST_PATH,
    SOURCE_PATH,
  ]);
  fixture.git(['commit', '--quiet', '-m', 'establish overlay boundary baseline']);
  baseCommit = fixture.git(['rev-parse', 'HEAD']);
  writeJson('.devai/state/tasks/TASK-9010.json', task());
  writeJson('record/proofs/chain.json', { head: null, records: [] });
});

afterAll(() => fixture?.cleanup());

describe('CLI shard 09 verify translation C overlay boundaries', () => {
  it('enforces database, task authority, and explicit task scope before Git intake', async () => {
    beginOverlay();
    finishScenario('intake preconditions');
    const value = witness();
    bindWitness(value);
    await expect(
      withAuthorityHostTestScope(() =>
        executeTranslationValidation({ witness: WITNESS_PATH, repoRoot: repository }),
      ),
    ).rejects.toThrow('DATABASE_URL_REQUIRED');
    await expect(
      withAuthorityHostTestScope(() =>
        executeTranslationValidation({
          witness: WITNESS_PATH,
          repoRoot: repository,
          databaseUrl: '',
        }),
      ),
    ).rejects.toThrow('DATABASE_URL_REQUIRED');

    writeJson('.devai/state/tasks/TASK-9010.json', { ...task(), discipline: 'architect' });
    await expect(validate()).rejects.toThrow('TRANSLATION_TASK_AUTHORITY_MISMATCH');

    writeJson('.devai/state/tasks/TASK-9010.json', { ...task(), id: 'TASK-9011' });
    await expect(validate()).rejects.toThrow('TRANSLATION_TASK_AUTHORITY_MISMATCH');

    writeJson('.devai/state/tasks/TASK-9010.json', { ...task(), intent_diff: {} });
    await expect(validate()).rejects.toThrow('TRANSLATION_TASK_SCOPE_MISSING');
    writeJson('.devai/state/tasks/TASK-9010.json', task());
  });

  it('rejects schema-invalid test-reference strategy pairings before validation', async () => {
    beginOverlay();
    finishScenario('strategy reference preconditions');
    await expect(validate([TEST_REF], { strategy: 'regression', red_green: [] })).rejects.toThrow(
      /TRANSLATION_WITNESS_INVALID:.*"keyword":"minItems"/u,
    );
    await expect(validate([TEST_REF], { strategy: 'structural' })).rejects.toThrow(
      /TRANSLATION_WITNESS_INVALID:.*"keyword":"(?:const|enum)"/u,
    );
  });

  it('rejects an unregistered cited test before accepting the overlay', async () => {
    beginOverlay();
    finishScenario('unregistered cited test');
    await expect(
      validate([TEST_REF], {
        red_green: [
          {
            test_ref: {
              suite: 'unit',
              path: UNREGISTERED_TEST_PATH,
              names: ['unregistered behavior'],
            },
            expected_at_base: 'assertion-fail',
            expected_at_candidate: 'pass',
          },
        ],
      }),
    ).rejects.toThrow('TRANSLATION_TEST_REF_UNREGISTERED');
  });

  it('requires a single overlay parent bound to the declared base', async () => {
    beginOverlay();
    finishScenario('wrong overlay parent');
    await expect(validate([TEST_REF], { test_overlay_sha: candidateCommit })).rejects.toThrow(
      'TEST_OVERLAY_PARENT_MISMATCH',
    );
  });

  it('rejects a two-parent overlay even when its first parent is the declared base', async () => {
    beginOverlay();
    finishTwoParentOverlayScenario('two-parent overlay');
    await expect(validate()).rejects.toThrow('TEST_OVERLAY_PARENT_MISMATCH');
  });

  it('requires the candidate to descend from the test overlay', async () => {
    beginOverlay();
    finishScenario('candidate ancestry');
    fixture.git(['checkout', '--quiet', '--detach', baseCommit]);
    writeText(SOURCE_PATH, 'export const translated = "unrelated";\n');
    fixture.git(['add', '--', SOURCE_PATH]);
    fixture.git(['commit', '--quiet', '-m', 'unrelated candidate']);
    const unrelatedCandidate = fixture.git(['rev-parse', 'HEAD']);
    await expect(validate([TEST_REF], { candidate_sha: unrelatedCandidate })).rejects.toThrow(
      'CANDIDATE_NOT_DESCENDANT_OF_TEST_OVERLAY',
    );
  });

  it('rejects an empty overlay even when candidate code changes are valid', async () => {
    beginOverlay();
    finishEmptyOverlay('empty overlay');
    await expect(validate()).rejects.toThrow('TEST_OVERLAY_SCOPE_INVALID');
  });

  it('rejects a non-test path in the overlay', async () => {
    beginOverlay();
    finishScenarioWithNonTestOverlayPath('non-test overlay path');
    await expect(validate()).rejects.toThrow('TEST_OVERLAY_SCOPE_INVALID');
  });

  it('passes a regular-file overlay through boundary checks before final result validation', async () => {
    beginOverlay();
    finishScenario('regular-file overlay');
    await expect(validate()).rejects.toThrow('VALIDATION_RESULT_INVALID');
  });

  it('passes an executable regular-file overlay through boundary checks before final result validation', async () => {
    beginOverlay();
    chmodSync(resolve(repository, TEST_PATH), 0o755);
    finishScenario('executable overlay');
    await expect(validate()).rejects.toThrow('VALIDATION_RESULT_INVALID');
  });

  it('rejects an overlay containing an unregistered test even when the cited test is present', async () => {
    beginOverlay();
    writeText(
      UNREGISTERED_TEST_PATH,
      "import { test } from 'node:test';\ntest('unregistered behavior', () => {});\n",
    );
    finishScenario('unregistered test');
    await expect(validate()).rejects.toThrow('TEST_OVERLAY_SCOPE_INVALID');
  });

  it('rejects a registered cited test that is absent from a nonempty overlay', async () => {
    beginOverlay();
    finishScenario('missing cited test');
    await expect(validate([TEST_REF, SECONDARY_TEST_REF])).rejects.toThrow(
      'TEST_OVERLAY_SCOPE_INVALID',
    );
  });

  it('rejects deletion of a registered test after the complete scope check passes', async () => {
    beginOverlay();
    rmSync(resolve(repository, LEGACY_TEST_PATH));
    finishScenario('deleted registered test');
    await expect(validate()).rejects.toThrow('TEST_OVERLAY_DELETES_TEST');
  });

  it('rejects a registered test symlink after validating every raw diff record', async () => {
    beginOverlay();
    rmSync(resolve(repository, TEST_PATH));
    symlinkSync('translation-shard-c-primary.test.ts', resolve(repository, SYMLINK_TEST_PATH));
    finishScenario('symlink test');
    await expect(validate([SYMLINK_TEST_REF])).rejects.toThrow('TEST_OVERLAY_FILE_MODE_INVALID');
  });
});
