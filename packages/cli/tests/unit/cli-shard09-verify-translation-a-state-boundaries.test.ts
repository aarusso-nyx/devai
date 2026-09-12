// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { createSelfContainedRepositoryFixture } from '../helpers/self-contained-repository-fixture.js';

type GitFault =
  | 'none'
  | 'ls-files-stderr'
  | 'ls-files-stdout'
  | 'ls-files-null-output'
  | 'remove-state-root'
  | 'trace-missing'
  | 'trace-invalid'
  | 'trace-null-stderr';
type StateMutation = 'none' | 'mixed' | 'tracked-boundaries';

const controls = vi.hoisted(() => ({
  gitFault: 'none' as GitFault,
  stateMutation: 'none' as StateMutation,
  repository: '',
  frameInputs: [] as Record<string, unknown>[],
  unsafeTrackedPath: '',
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  spawnSync(
    command: string,
    args: readonly string[],
    options: Parameters<typeof nodeSpawnSync>[2],
  ) {
    if (
      command === 'git' &&
      args[0] === 'ls-files' &&
      controls.gitFault === 'ls-files-null-output'
    ) {
      return {
        status: null,
        signal: null,
        stdout: null,
        stderr: null,
        error: new Error('spawn failed'),
      };
    }
    if (command === 'git' && args[0] === 'ls-files' && controls.gitFault.startsWith('ls-files')) {
      return controls.gitFault === 'ls-files-stderr'
        ? { status: 1, signal: null, stdout: '', stderr: ' sentinel ls stderr \n' }
        : { status: 1, signal: null, stdout: ' sentinel ls stdout \n', stderr: '' };
    }
    if (
      command === 'git' &&
      args[0] === 'cat-file' &&
      args[1] === 'blob' &&
      String(args[2]).endsWith(':law/trace.json')
    ) {
      if (controls.gitFault === 'trace-missing') {
        return {
          status: 1,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(' sentinel trace stderr \n'),
        };
      }
      if (controls.gitFault === 'trace-invalid') {
        return {
          status: 0,
          signal: null,
          stdout: Buffer.from('{invalid'),
          stderr: Buffer.alloc(0),
        };
      }
      if (controls.gitFault === 'trace-null-stderr') {
        return {
          status: null,
          signal: null,
          stdout: null,
          stderr: null,
          error: new Error('spawn failed'),
        };
      }
    }
    const result = nodeSpawnSync(command, [...args], options);
    if (
      command === 'git' &&
      args[0] === 'diff' &&
      args[1] === '--name-only' &&
      controls.gitFault === 'remove-state-root'
    ) {
      renameSync(
        resolve(controls.repository, '.devai/state'),
        resolve(controls.repository, '.devai/state-a-residual-backup'),
      );
    }
    if (
      command === 'git' &&
      args[0] === 'ls-files' &&
      controls.stateMutation === 'tracked-boundaries'
    ) {
      return {
        ...result,
        stdout: `${String(result.stdout)}${controls.unsafeTrackedPath}\0`,
      };
    }
    return result;
  },
}));

vi.mock('#runtime-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime-core.js')>();
  return {
    ...actual,
    appendVerbEvidence() {
      if (controls.stateMutation === 'mixed') {
        writeFileSync(resolve(controls.repository, '.devai/state/a-state/existing.txt'), 'after\n');
        unlinkSync(resolve(controls.repository, '.devai/state/a-state/retired.txt'));
        unlinkSync(resolve(controls.repository, '.devai/state/a-state/current-link'));
        symlinkSync(
          'target-after.txt',
          resolve(controls.repository, '.devai/state/a-state/current-link'),
        );
        writeFileSync(
          resolve(controls.repository, '.devai/state/a-state/created.txt'),
          'created\n',
        );
      } else if (controls.stateMutation === 'tracked-boundaries') {
        writeFileSync(
          resolve(controls.repository, SOURCE_PATH),
          'export const translationAState = 2;\n',
        );
        chmodSync(resolve(controls.repository, SPECIAL_PATH), 0o755);
        writeFileSync(resolve(controls.repository, MISSING_PATH), 'created after snapshot\n');
        writeFileSync(resolve(controls.repository, '..', controls.unsafeTrackedPath), 'outside\n');
      }
      return { ok: true, id: 'EV-aabbccddeeff0011' };
    },
    async provisionValidationDatabase(input: { readonly validation_id: string }) {
      return { ok: true, database: `devai_task_TV_${input.validation_id.slice(3)}` };
    },
    async dropValidationDatabase() {
      return { ok: true };
    },
    evaluateTranslationFrames(input: Parameters<typeof actual.evaluateTranslationFrames>[0]) {
      controls.frameInputs.push(structuredClone(input));
      return actual.evaluateTranslationFrames(input);
    },
  };
});

import { executeTranslationValidation } from '../../src/commands/verify/translation.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const WITNESS_PATH = 'scratch/translation-a-state-witness.json';
const RECIPE_PATH = 'record/proofs/work/recipe-runs/devai-fix/test/2026-09-12T04-00-00-000Z.json';
const SOURCE_PATH = 'packages/cli/src/translation-a-state-fixture.ts';
const SPECIAL_PATH = 'packages/cli/src/translation-a-state-special.txt';
const MISSING_PATH = 'packages/cli/src/translation-a-state-missing.txt';
const A_RESIDUAL_FINGERPRINTS = [
  0, 13, 67, 68, 69, 70, 71, 72, 73, 84, 86, 87, 88, 96, 99, 109, 111, 112, 113, 114, 123, 124, 126,
  127, 130, 131, 132, 133, 134, 137, 138, 139, 140, 141, 143, 145, 146, 150, 151, 152, 153, 154,
  155, 156, 157, 158, 159, 160, 161, 165, 173, 176, 178, 179, 200, 202, 205, 206,
] as const;

let fixture: ReturnType<typeof createSelfContainedRepositoryFixture>;
let repository: string;
let base: string;
let candidate: string;

function writeText(path: string, value: string): void {
  const absolute = resolve(repository, path);
  mkdirSync(resolve(absolute, '..'), { recursive: true });
  writeFileSync(absolute, value);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createWitness(id = 'TW-aaaaaaaaaaaaaaaa'): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id,
    trust: 'untrusted-claim',
    task_id: 'TASK-9013',
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    stage: 'invariants-tests-to-code',
    base_sha: base,
    candidate_sha: candidate,
    emitted_at: '2026-09-12T04:00:00.000Z',
    strategy: 'structural',
    implements: [
      {
        invariant_id: 'INV-DEMO-013',
        criteria: [
          {
            claim: 'Translation A state boundaries remain deterministic.',
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
}

async function validate(id?: string): Promise<Record<string, unknown>> {
  const witness = createWitness(id);
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

beforeAll(() => {
  fixture = createSelfContainedRepositoryFixture(ROOT);
  repository = fixture.root;
  controls.repository = repository;
  writeJson('law/invariants/INV-DEMO-013.json', {
    schemaVersion: '1.0.0',
    id: 'INV-DEMO-013',
    domain: 'DEMO',
    lifecycle: 'supported',
    severity: 'gate',
    type: 'validation',
    title: 'Translation A state boundaries',
    statement: 'State snapshots retain exact file identity and lifecycle operations.',
    status: 'active',
    verification: {
      required_suites: ['unit'],
      oracle: 'automated_tests',
      strategy: {
        primary: 'structural',
        deterministic_check_available: true,
        rationale: 'A controlled state fixture exposes exact snapshot changes.',
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
    invariants: [{ id: 'INV-DEMO-013', tests: [], code_areas: [SOURCE_PATH] }],
    test_corpus: [],
  });
  writeText(SOURCE_PATH, 'export const translationAState = false;\n');
  writeText(SPECIAL_PATH, 'regular before snapshot\n');
  writeText(MISSING_PATH, 'present in Git\n');
  writeText('.devai/state/a-state/existing.txt', 'before\n');
  writeText('.devai/state/a-state/retired.txt', 'retire me\n');
  writeText('.devai/state/a-state/target-before.txt', 'before target\n');
  writeText('.devai/state/a-state/target-after.txt', 'after target\n');
  symlinkSync('target-before.txt', resolve(repository, '.devai/state/a-state/current-link'));
  fixture.git([
    'add',
    '--force',
    '--',
    'law',
    SOURCE_PATH,
    SPECIAL_PATH,
    MISSING_PATH,
    '.devai/state/a-state',
  ]);
  fixture.git(['commit', '--quiet', '-m', 'establish A state snapshot base']);
  base = fixture.git(['rev-parse', 'HEAD']);
  writeText(SOURCE_PATH, 'export const translationAState = true;\n');
  fixture.git(['add', '--force', '--', SOURCE_PATH]);
  fixture.git(['commit', '--quiet', '-m', 'implement A state candidate']);
  candidate = fixture.git(['rev-parse', 'HEAD']);
  writeJson('.devai/state/tasks/TASK-9013.json', {
    schemaVersion: '2.0.0',
    id: 'TASK-9013',
    round_id: 'R-0007',
    status: 'in_progress',
    discipline: 'engineer',
    title: 'Exercise translation A state boundaries',
    target_modules: ['MOD-CLI'],
    target_substrates: ['F2'],
    created_at: '2026-09-12T04:00:00.000Z',
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
  controls.gitFault = 'none';
  controls.stateMutation = 'none';
  controls.frameInputs = [];
  controls.unsafeTrackedPath = `translation-a-unsafe-${process.pid}.txt`;
});

afterEach(() => {
  controls.gitFault = 'none';
  controls.stateMutation = 'none';
  rmSync(resolve(repository, '..', controls.unsafeTrackedPath), { force: true });
  writeText(SOURCE_PATH, 'export const translationAState = true;\n');
  rmSync(resolve(repository, SPECIAL_PATH), { recursive: true, force: true });
  writeText(SPECIAL_PATH, 'regular before snapshot\n');
  writeText(MISSING_PATH, 'present in Git\n');
  if (!existsSync(resolve(repository, '.devai/state/a-state/retired.txt'))) {
    writeText('.devai/state/a-state/retired.txt', 'retire me\n');
  }
  writeText('.devai/state/a-state/existing.txt', 'before\n');
  if (existsSync(resolve(repository, '.devai/state/a-state/created.txt'))) {
    rmSync(resolve(repository, '.devai/state/a-state/created.txt'));
  }
  if (lstatSync(resolve(repository, '.devai/state/a-state/current-link')).isSymbolicLink()) {
    unlinkSync(resolve(repository, '.devai/state/a-state/current-link'));
  }
  symlinkSync('target-before.txt', resolve(repository, '.devai/state/a-state/current-link'));
  rmSync(resolve(repository, '.devai/state/translation-validation'), {
    recursive: true,
    force: true,
  });
});

afterAll(() => fixture?.cleanup());

describe('verify translation A state and Git boundaries', () => {
  it('binds this test wave to all 58 exact non-killed A residual fingerprints', () => {
    expect(A_RESIDUAL_FINGERPRINTS).toHaveLength(58);
    expect(new Set(A_RESIDUAL_FINGERPRINTS).size).toBe(58);
  });

  it.each([
    ['ls-files-stderr', 'sentinel ls stderr'],
    ['ls-files-stdout', 'sentinel ls stdout'],
  ] as const)(
    'propagates trimmed %s output from the tracked-state Git boundary',
    async (fault, output) => {
      controls.gitFault = fault;
      await expect(validate()).rejects.toThrow(
        `VALIDATION_TRACKED_STATE_SNAPSHOT_FAILED: ${output}`,
      );
    },
  );

  it('normalizes null stdout and stderr from a failed tracked-state Git spawn', async () => {
    controls.gitFault = 'ls-files-null-output';
    await expect(validate()).rejects.toMatchObject({
      message: 'VALIDATION_TRACKED_STATE_SNAPSHOT_FAILED: ',
    });
  });

  it('preserves the exact commit-blob error and its stderr normalization', async () => {
    controls.gitFault = 'trace-missing';
    await expect(validate()).rejects.toThrow(
      'TRANSLATION_TRACE_OBJECT_INVALID: sentinel trace stderr',
    );
  });

  it('normalizes null stderr from a failed commit-blob Git spawn', async () => {
    controls.gitFault = 'trace-null-stderr';
    await expect(validate()).rejects.toMatchObject({
      message: 'TRANSLATION_TRACE_OBJECT_INVALID: ',
    });
  });

  it('normalizes malformed commit JSON without swallowing the requested error code', async () => {
    controls.gitFault = 'trace-invalid';
    await expect(validate()).rejects.toThrow('TRANSLATION_TRACE_OBJECT_INVALID: invalid JSON');
  });

  it('accepts an absent state root at the snapshot boundary', async () => {
    controls.gitFault = 'remove-state-root';
    try {
      const result = await validate('TW-dddddddddddddddd');
      expect(result['id']).toMatch(/^VR-[a-f0-9]{16}$/u);
    } finally {
      controls.gitFault = 'none';
      rmSync(resolve(repository, '.devai/state'), { recursive: true, force: true });
      renameSync(
        resolve(repository, '.devai/state-a-residual-backup'),
        resolve(repository, '.devai/state'),
      );
    }
  });

  it('parses the NUL-delimited tracked inventory and rejects an escaping path', async () => {
    rmSync(resolve(repository, SPECIAL_PATH));
    mkdirSync(resolve(repository, SPECIAL_PATH));
    chmodSync(resolve(repository, SPECIAL_PATH), 0o700);
    unlinkSync(resolve(repository, MISSING_PATH));
    controls.stateMutation = 'tracked-boundaries';

    const result = await validate('TW-eeeeeeeeeeeeeeee');
    const observed = (
      result['expected_diff'] as {
        readonly observed: readonly { readonly path: string; readonly operation: string }[];
      }
    ).observed;

    expect(observed).toEqual(
      expect.arrayContaining([
        { path: SOURCE_PATH, operation: 'append' },
        { path: SPECIAL_PATH, operation: 'append' },
        { path: MISSING_PATH, operation: 'create' },
      ]),
    );
    expect(observed).not.toContainEqual({
      path: `../${controls.unsafeTrackedPath}`,
      operation: 'create',
    });
  });

  it('classifies nested file, symlink, creation, append, and retirement changes exactly', async () => {
    controls.stateMutation = 'mixed';
    const result = await validate('TW-bbbbbbbbbbbbbbbb');
    const changes = result['expected_diff'] as {
      readonly observed: readonly { readonly path: string; readonly operation: string }[];
    };
    const observed = changes.observed;

    expect(observed).toEqual(
      expect.arrayContaining([
        { path: '.devai/state/a-state/created.txt', operation: 'create' },
        { path: '.devai/state/a-state/current-link', operation: 'append' },
        { path: '.devai/state/a-state/existing.txt', operation: 'append' },
        { path: '.devai/state/a-state/retired.txt', operation: 'retire' },
      ]),
    );
    expect(observed.filter((change) => change.path.startsWith('.devai/state/a-state/'))).toEqual([
      { path: '.devai/state/a-state/created.txt', operation: 'create' },
      { path: '.devai/state/a-state/current-link', operation: 'append' },
      { path: '.devai/state/a-state/existing.txt', operation: 'append' },
      { path: '.devai/state/a-state/retired.txt', operation: 'retire' },
    ]);
    expect(readlinkSync(resolve(repository, '.devai/state/a-state/current-link'))).toBe(
      'target-after.txt',
    );
  });

  it('deduplicates and sorts lifecycle changes while retaining exact create/retire custody', async () => {
    const result = await validate('TW-cccccccccccccccc');
    const observed = (result['expected_diff'] as { readonly observed: readonly unknown[] })
      .observed;
    const keys = observed.map((change) => JSON.stringify(change));

    expect(new Set(keys).size).toBe(keys.length);
    expect(observed).toEqual(
      [...observed].sort((left, right) => {
        const a = `${(left as { path: string }).path}:${(left as { operation: string }).operation}`;
        const b = `${(right as { path: string }).path}:${(right as { operation: string }).operation}`;
        return a < b ? -1 : a > b ? 1 : 0;
      }),
    );
    expect(result['cleanup']).toEqual(
      expect.objectContaining({ worktree: 'not-created', database: 'removed' }),
    );
  });
});
