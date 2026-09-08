import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthorityDecisionIssuer, runWithAuthorityHostEffects } from '@devai-nyx/authority';
import { validators } from '@devai-nyx/schemas';
import { canonicalJson } from '@devai-nyx/utils';
import {
  buildExpectedDiffManifest,
  classifyTranslationPath,
  evaluateTranslationFrames,
  recordMutationCandidate,
  recordMutationEvidenceCommit,
  resolveRecipeRecordPath,
  runLinuxIsolated,
  validateInvariantStrategies,
  type TranslationAuthorityRole,
} from '../../src/translation-validation/index.js';

type Data = Record<string, unknown>;
const EMITTED_AT = '2026-09-07T00:00:00.000Z';
const EVIDENCE_AT = '2026-09-07T00:01:00.000Z';
const INTENT_ID = 'MI-0123456789abcdef';
const TEMP_INDEX = `.devai/state/r28-index-${INTENT_ID}`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function example(name: string): Data {
  const schema = JSON.parse(
    readFileSync(join(process.cwd(), 'law/schemas', `${name}.schema.json`), 'utf8'),
  ) as { examples: Data[] };
  if (!schema.examples[0]) throw new Error('missing schema fixture');
  return structuredClone(schema.examples[0]);
}
function put(root: string, path: string, value: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}
function putJson(root: string, path: string, value: unknown): void {
  put(root, path, JSON.stringify(value));
}
function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return result.stdout.trim();
}
function candidateRefs(root: string): string {
  return git(root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28');
}

function fixture(sourcePaths: readonly string[] = ['packages/core/src/example.ts']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-translation-runtime-')));
  roots.push(root);
  const task = example('task');
  const invariant = example('invariant');
  const claim = example('translation-witness');
  const intent = example('mutation-intent');
  const implementation = structuredClone(claim['implements']) as Data[];
  if (!implementation[0]) throw new Error('missing implementation fixture');
  implementation[0]['invariant_id'] = invariant['id'];
  Object.assign(intent, {
    declared_touched: [...sourcePaths],
    task_id: task['id'],
    strategy: 'regression',
    implements: implementation,
    red_green: claim['red_green'],
  });
  task['intent_diff'] = { planned_files: ['packages/core/src/*.ts'] };
  expect(validators.task(task)).toBe(true);
  expect(validators.invariant(invariant)).toBe(true);
  putJson(root, `.devai/state/tasks/${String(task['id'])}.json`, task);
  putJson(root, `law/invariants/${String(invariant['id'])}.json`, invariant);
  put(root, '.gitignore', '.devai/state/r28-index-*\n');
  for (const path of sourcePaths) put(root, path, 'export const value = 1;\n');
  git(root, 'init', '-b', 'fixture');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture base');
  intent['base_sha'] = git(root, 'rev-parse', 'HEAD');
  expect(validators.mutationIntent(intent)).toBe(true);
  return { root, intent, task, sourcePaths };
}

// A trusted unit-fixture adapter executes real Git only inside this disposable
// repository. It tests recorder behavior, not installed policy authorization.
async function runRecorder<T>(root: string, callback: () => Promise<T>): Promise<T> {
  let ordinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'translation-runtime-fixture',
    issuer_version: '1.0.0',
    invocation_id: 'fixture-invocation',
    canonicalSha256: (value: unknown) =>
      createHash('sha256').update(canonicalJson(value)).digest('hex'),
    randomId: () => `fixture-${++ordinal}`,
    now: () => EMITTED_AT,
    receipt_ttl_ms: 30000,
  });
  const verbs = new Set([
    'rev-parse',
    'cat-file',
    'diff',
    'ls-files',
    'symbolic-ref',
    'for-each-ref',
    'show-ref',
    'read-tree',
    'add',
    'write-tree',
    'commit-tree',
    'clean',
    'diff-tree',
    'update-ref',
  ]);
  try {
    return await runWithAuthorityHostEffects(
      {
        action_id: 'fixture record',
        invocation_id: 'fixture-invocation',
        effect: 'local-write',
        receipt_store: issuer,
        apply_effect(request, apply) {
          expect(request.kind).toBe('process');
          const [executable, args, options] = request.arguments;
          expect(executable).toBe('git');
          expect(options).toMatchObject({ cwd: root, shell: false });
          const argv = args as string[];
          expect(verbs.has(argv[0] ?? '')).toBe(true);
          return apply();
        },
      },
      callback,
    );
  } finally {
    issuer.dispose();
  }
}

describe('candidate declared-path reconciliation', () => {
  it('reconciles an unsorted declared population against the sorted changed population', async () => {
    const f = fixture(['packages/core/src/beta.ts', 'packages/core/src/alpha.ts']);
    const result = await runRecorder(f.root, () =>
      recordMutationCandidate({
        repo_root: f.root,
        intent: f.intent,
        emitted_at: EMITTED_AT,
        run: async () => {
          for (const path of f.sourcePaths) put(f.root, path, 'export const value = 2;\n');
        },
      }),
    );
    expect(f.intent['declared_touched']).toEqual([
      'packages/core/src/beta.ts',
      'packages/core/src/alpha.ts',
    ]);
    expect(result.touched).toEqual(['packages/core/src/alpha.ts', 'packages/core/src/beta.ts']);
    expect(result.witness['touched']).toEqual(result.touched);
    expect(
      git(f.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.candidate_sha),
    ).toBe('packages/core/src/alpha.ts\npackages/core/src/beta.ts');
  });

  it.each([
    ['substituted', ['packages/core/src/alpha.ts', 'packages/core/src/gamma.ts']],
    ['unwritten', ['packages/core/src/alpha.ts', 'packages/core/src/beta.ts']],
  ] as const)(
    'refuses a %s declared path even when another declared path matches exactly',
    async (kind, declared) => {
      const f = fixture(['packages/core/src/alpha.ts', 'packages/core/src/beta.ts']);
      f.intent['declared_touched'] = [...declared];
      expect(validators.mutationIntent(f.intent)).toBe(true);
      const index = readFileSync(join(f.root, '.git/index'));
      await expect(
        runRecorder(f.root, () =>
          recordMutationCandidate({
            repo_root: f.root,
            intent: f.intent,
            emitted_at: EMITTED_AT,
            run: async () => {
              put(f.root, 'packages/core/src/alpha.ts', 'export const value = 2;\n');
              if (kind === 'substituted')
                put(f.root, 'packages/core/src/beta.ts', 'export const value = 2;\n');
            },
          }),
        ),
      ).rejects.toThrow('MUTATION_UNDECLARED_PATH');
      expect(candidateRefs(f.root)).toBe('');
      expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.intent['base_sha']);
      expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
      expect(existsSync(join(f.root, TEMP_INDEX))).toBe(false);
    },
  );
});

describe('interrupted recorder effect reconciliation', () => {
  it('surfaces the index failure itself and preserves the interrupted run lock, worktree and refs', async () => {
    const f = fixture();
    const lock = `${TEMP_INDEX}.lock`;
    const index = readFileSync(join(f.root, '.git/index'));
    let failure: unknown;
    try {
      await runRecorder(f.root, () =>
        recordMutationCandidate({
          repo_root: f.root,
          intent: f.intent,
          emitted_at: EMITTED_AT,
          run: async () => {
            put(f.root, 'packages/core/src/example.ts', 'export const value = 2;\n');
            put(f.root, lock, 'interrupted recorder lock');
          },
        }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toMatch(/^MUTATION_READ_TREE_FAILED: \S/u);
    expect(readFileSync(join(f.root, lock), 'utf8')).toBe('interrupted recorder lock');
    expect(existsSync(join(f.root, TEMP_INDEX))).toBe(false);
    expect(candidateRefs(f.root)).toBe('');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.intent['base_sha']);
    expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
    expect(readFileSync(join(f.root, 'packages/core/src/example.ts'), 'utf8')).toBe(
      'export const value = 2;\n',
    );
  });
});

async function evidenceFixture(recipeStatus = 'pass') {
  const f = fixture();
  const candidate = await runRecorder(f.root, () =>
    recordMutationCandidate({
      repo_root: f.root,
      intent: f.intent,
      emitted_at: EMITTED_AT,
      run: async () => {
        put(f.root, 'packages/core/src/example.ts', 'export const value = 2;\n');
      },
    }),
  );
  const witness = candidate.witness;
  const witnessPath = `record/proofs/compliance/translation-validation/witnesses/${String(witness['id'])}.json`;
  const recipePath = 'record/proofs/work/recipe-runs/devai-fix/test/run.json';
  const taskPath = `.devai/state/tasks/${String(f.intent['task_id'])}.json`;
  const agent = example('agent-run');
  agent['started_at'] = EMITTED_AT;
  agent['ended_at'] = EVIDENCE_AT;
  agent['caller'] = { kind: 'recipe', name: 'devai-fix' };
  agent['files_written'] = [recipePath, witnessPath];
  const agentPath = `record/proofs/work/agent-runs/${String(agent['run_id'])}.json`;
  putJson(f.root, agentPath, hashed(agent));
  putJson(f.root, witnessPath, witness);
  putJson(f.root, recipePath, {
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    status: recipeStatus,
    evidence: { translation_witness: witness },
  });
  const inputs = {
    repo_root: f.root,
    intent_id: INTENT_ID,
    candidate_sha: candidate.candidate_sha,
    timestamp: EVIDENCE_AT,
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    witness,
    state_paths: [witnessPath, recipePath, agentPath, taskPath],
  };
  return { ...f, candidate, inputs, witnessPath, recipePath, agentPath, taskPath };
}
function hashed(agent: Data): Data {
  const { manifest_hash: _previous, ...draft } = agent;
  return {
    ...agent,
    manifest_hash: createHash('sha256').update(canonicalJson(draft)).digest('hex'),
  };
}
function recipeRecord(witness: unknown, status = 'pass'): Data {
  return {
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    status,
    evidence: { translation_witness: witness },
  };
}

describe('recorded commit identity', () => {
  it('binds the candidate and evidence commits to the recorder identity, intent and emission instants', async () => {
    const f = await evidenceFixture('review');
    const evidence = await runRecorder(f.root, async () => recordMutationEvidenceCommit(f.inputs));
    const format = '%s%n%an%n%ae%n%cn%n%ce%n%at%n%ct';
    expect(git(f.root, 'show', '-s', `--format=${format}`, f.candidate.candidate_sha)).toBe(
      [
        `R28 candidate ${INTENT_ID}`,
        'DEVAI R28 Recorder',
        'r28-recorder@devai.invalid',
        'DEVAI R28 Recorder',
        'r28-recorder@devai.invalid',
        String(Math.floor(Date.parse(EMITTED_AT) / 1000)),
        String(Math.floor(Date.parse(EMITTED_AT) / 1000)),
      ].join('\n'),
    );
    expect(git(f.root, 'show', '-s', `--format=${format}`, evidence.evidence_sha)).toBe(
      [
        `R28 evidence ${INTENT_ID}`,
        'DEVAI R28 Recorder',
        'r28-recorder@devai.invalid',
        'DEVAI R28 Recorder',
        'r28-recorder@devai.invalid',
        String(Math.floor(Date.parse(EVIDENCE_AT) / 1000)),
        String(Math.floor(Date.parse(EVIDENCE_AT) / 1000)),
      ].join('\n'),
    );
    expect(git(f.root, 'rev-parse', evidence.evidence_ref)).toBe(evidence.evidence_sha);
    expect(existsSync(join(f.root, TEMP_INDEX))).toBe(false);
  });
});

describe('evidence identity and population reconciliation', () => {
  it('refuses a task record whose identity disagrees with the witness task path', async () => {
    const f = await evidenceFixture();
    const relabelled = { ...f.task, id: 'TASK-7002' };
    expect(validators.task(relabelled)).toBe(true);
    putJson(f.root, f.taskPath, relabelled);
    await expect(
      runRecorder(f.root, async () => recordMutationEvidenceCommit(f.inputs)),
    ).rejects.toThrow('MUTATION_EVIDENCE_TASK_MISMATCH');
    expect(candidateRefs(f.root)).toContain('refs/devai/r28/candidates/');
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
  });

  it('refuses a task record that no longer satisfies its schema', async () => {
    const f = await evidenceFixture();
    putJson(f.root, f.taskPath, {});
    await expect(
      runRecorder(f.root, async () => recordMutationEvidenceCommit(f.inputs)),
    ).rejects.toThrow('MUTATION_EVIDENCE_TASK_INVALID');
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
  });

  it('refuses a second recipe-run state path even when exactly one embeds the witness', async () => {
    const f = await evidenceFixture();
    const extra = 'record/proofs/work/recipe-runs/devai-fix/test/unrelated.json';
    putJson(f.root, extra, recipeRecord({ ...f.inputs.witness, id: 'TW-fedcba9876543210' }));
    await expect(
      runRecorder(f.root, async () =>
        recordMutationEvidenceCommit({
          ...f.inputs,
          state_paths: [...f.inputs.state_paths, extra],
        }),
      ),
    ).rejects.toThrow('MUTATION_EVIDENCE_RECIPE_STATE_NOT_EXACT');
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
  });

  it('refuses a recipe record that embeds a different witness identity', async () => {
    const f = await evidenceFixture();
    putJson(f.root, f.recipePath, recipeRecord({ ...f.inputs.witness, id: 'TW-fedcba9876543210' }));
    await expect(
      runRecorder(f.root, async () => recordMutationEvidenceCommit(f.inputs)),
    ).rejects.toThrow('MUTATION_EVIDENCE_RECIPE_RECORD_NOT_UNIQUE');
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
  });

  it.each(['fail', 'pending'])('refuses an ineligible %s recipe record', async (status) => {
    const f = await evidenceFixture(status);
    await expect(
      runRecorder(f.root, async () => recordMutationEvidenceCommit(f.inputs)),
    ).rejects.toThrow('MUTATION_EVIDENCE_RECIPE_RECORD_NOT_ELIGIBLE');
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
  });

  it('refuses a second attributed agent run rather than choosing one', async () => {
    const f = await evidenceFixture();
    const extra = 'record/proofs/work/agent-runs/AR-019e384d-257c-7fde-ba4f-5ccb7243843e.json';
    const second = example('agent-run');
    second['run_id'] = 'AR-019e384d-257c-7fde-ba4f-5ccb7243843e';
    second['caller'] = { kind: 'recipe', name: 'devai-fix' };
    second['files_written'] = [f.recipePath, f.witnessPath];
    putJson(f.root, extra, hashed(second));
    await expect(
      runRecorder(f.root, async () =>
        recordMutationEvidenceCommit({
          ...f.inputs,
          state_paths: [...f.inputs.state_paths, extra],
        }),
      ),
    ).rejects.toThrow('MUTATION_EVIDENCE_AGENT_RUN_NOT_UNIQUE');
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
  });

  it('refuses an agent manifest that carries an honest hash over an invalid schema', async () => {
    const f = await evidenceFixture();
    const agent = JSON.parse(readFileSync(join(f.root, f.agentPath), 'utf8')) as Data;
    const forged = hashed({ ...agent, unexpected_field: 'not in the governed manifest' });
    expect(validators.agentRun(forged)).toBe(false);
    const { manifest_hash: hash, ...manifest } = forged;
    expect(createHash('sha256').update(canonicalJson(manifest)).digest('hex')).toBe(hash);
    putJson(f.root, f.agentPath, forged);
    await expect(
      runRecorder(f.root, async () => recordMutationEvidenceCommit(f.inputs)),
    ).rejects.toThrow('MUTATION_EVIDENCE_AGENT_RUN_INVALID');
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
  });

  it('refuses a leftover working-tree path that the candidate never recorded', async () => {
    const f = await evidenceFixture();
    put(f.root, 'packages/core/src/leftover.ts', 'export const leftover = true;\n');
    await expect(
      runRecorder(f.root, async () => recordMutationEvidenceCommit(f.inputs)),
    ).rejects.toThrow('MUTATION_EVIDENCE_UNEXPECTED_PATH');
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
    expect(readFileSync(join(f.root, 'packages/core/src/leftover.ts'), 'utf8')).toBe(
      'export const leftover = true;\n',
    );
  });
});

describe('recorder identifier binding', () => {
  const base = {
    repo_root: '/nonexistent-translation-root',
    intent_id: INTENT_ID,
    candidate_sha: 'a'.repeat(40),
    timestamp: EVIDENCE_AT,
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    witness: {},
    state_paths: [],
  };
  it.each([
    ['intent_id', 'xMI-0123456789abcdef', 'MUTATION_INTENT_ID_INVALID'],
    ['intent_id', 'MI-0123456789abcdef0', 'MUTATION_INTENT_ID_INVALID'],
    ['recipe_name', 'devai-fix-extra', 'RECIPE NAME_INVALID'],
    ['recipe_name', 'xdevai-fix', 'RECIPE NAME_INVALID'],
    ['recipe_variant', 'test/../evil', 'RECIPE VARIANT_INVALID'],
  ] as const)('refuses evidence recorded under %s %j', (key, value, error) => {
    expect(() => recordMutationEvidenceCommit({ ...base, [key]: value })).toThrow(error);
  });

  it.each([
    ['recipe_name', 'devai-fix-extra', 'RECIPE NAME_INVALID'],
    ['recipe_variant', 'test/../evil', 'RECIPE VARIANT_INVALID'],
    ['witness_id', 'xTW-0123456789abcdef', 'WITNESS ID_INVALID'],
    ['witness_id', 'TW-0123456789abcdef0', 'WITNESS ID_INVALID'],
  ] as const)('refuses recipe record selection under %s %j', (key, value, error) => {
    expect(() =>
      resolveRecipeRecordPath({
        repo_root: '/nonexistent-translation-root',
        recipe_name: 'devai-fix',
        recipe_variant: 'test',
        witness_id: 'TW-0123456789abcdef',
        [key]: value,
      }),
    ).toThrow(error);
  });

  const manifest = {
    validation_id: 'VR-0123456789abcdef',
    witness_id: 'TW-fedcba9876543210',
    lease_id: 'TVL-aaaaaaaaaaaaaaaa',
    recipe_name: 'devai-verify',
    recipe_variant: 'default',
    recipe_record_path: 'record/proofs/work/recipe-runs/devai-verify/default/run.json',
  };
  it.each([
    ['validation_id', 'xVR-0123456789abcdef', 'VALIDATION ID_INVALID'],
    ['witness_id', 'xTW-fedcba9876543210', 'WITNESS ID_INVALID'],
    ['witness_id', 'TW-fedcba9876543210f', 'WITNESS ID_INVALID'],
    ['lease_id', 'xTVL-aaaaaaaaaaaaaaaa', 'LEASE ID_INVALID'],
    ['lease_id', 'TVL-aaaaaaaaaaaaaaaaa', 'LEASE ID_INVALID'],
    ['recipe_name', 'devai-verify-extra', 'RECIPE NAME_INVALID'],
    ['recipe_variant', 'default/../evil', 'RECIPE VARIANT_INVALID'],
  ] as const)('refuses an expected-diff manifest under %s %j', (key, value, error) => {
    expect(() => buildExpectedDiffManifest({ ...manifest, [key]: value })).toThrow(error);
  });

  it('refuses a record filename that only begins as a governed JSON record', () => {
    expect(() =>
      buildExpectedDiffManifest({
        ...manifest,
        recipe_record_path: 'record/proofs/work/recipe-runs/devai-verify/default/run.json.bak',
      }),
    ).toThrow('RECIPE_RECORD_PATH_INVALID');
  });

  it('does not let a shadow record filename conceal the exact governed record', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-translation-selection-')));
    roots.push(root);
    const witness = example('translation-witness');
    const directory = 'record/proofs/work/recipe-runs/devai-fix/test';
    putJson(root, `${directory}/selected.json`, recipeRecord(witness));
    putJson(root, `${directory}/selected.json.bak`, recipeRecord(witness));
    expect(
      resolveRecipeRecordPath({
        repo_root: root,
        recipe_name: 'devai-fix',
        recipe_variant: 'test',
        witness_id: String(witness['id']),
      }),
    ).toBe(`${directory}/selected.json`);
  });
});

const ROLES: readonly TranslationAuthorityRole[] = [
  'owner',
  'architect',
  'inspector',
  'engineer',
  'auditor',
];
describe('runtime path authority boundaries', () => {
  it.each([
    ['.devai', 'fs:f5-config'],
    ['record', 'fs:proofs'],
    ['scratch', 'fs:worktree-admin'],
    ['work', 'fs:architect-spec'],
    ['work/notes.md', 'fs:architect-spec'],
    ['work/roundsx/plan.md', 'fs:architect-spec'],
  ] as const)('denies every role the governed root %s', (path, effect) => {
    for (const role of ROLES)
      expect(classifyTranslationPath(role, path)).toEqual({ allowed: false, effect });
  });

  it.each(['work/rounds', 'work/rounds/R-0001/plan.md', '.changeset/soft-rats-shout.md'])(
    'keeps architect authority over %s',
    (path) => {
      for (const role of ROLES)
        expect(classifyTranslationPath(role, path)).toEqual({
          allowed: role === 'architect',
          effect: 'fs:architect-spec',
        });
    },
  );

  it.each([
    'packages/a/src/main.test.ts',
    'packages/a/src/main.spec.cjs',
    'vitest.config.mjs',
    'vitest.node.config.ts',
  ])('keeps inspector test authority over %s', (path) => {
    for (const role of ROLES)
      expect(classifyTranslationPath(role, path)).toEqual({
        allowed: role === 'inspector',
        effect: 'fs:tests',
      });
  });

  it.each(['packages/a/src/main.test.ts.bak', 'vitest.config.ts.bak', 'packages/a/src/testing.ts'])(
    'does not extend test authority to %s',
    (path) => {
      expect(classifyTranslationPath('engineer', path)).toEqual({
        allowed: true,
        effect: 'fs:plant',
      });
    },
  );
});

type FrameInput = Parameters<typeof evaluateTranslationFrames>[0];
describe('validation frame findings', () => {
  it('reports the exact finding for every failed frame', () => {
    const result = evaluateTranslationFrames({
      witness: {
        strategy: 'regression',
        touched: [],
        red_green: [{ test_ref: 'tests/missing.test.ts' }],
        frame: {
          authority_role: 'engineer',
          inventory_delta_confined_to: [],
          effects_claimed: [],
        },
      },
      registered_test_refs: [],
      task_scope: ['src/**'],
      diff_paths: ['product/journeys/login.json'],
      base_executions: [],
      candidate_executions: [],
      weakening_clean: false,
      inventory_delta_modules: ['core'],
      inferred_effects: ['proc:network'],
      expected_state_changes: [{ path: 'proof.json', operation: 'create' }],
      observed_state_changes: [],
      strategy_coverage: { status: 'fail' },
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.executed_test_refs).toEqual([]);
    expect(result.frames).toEqual([
      {
        name: 'witness-structure',
        status: 'FAIL',
        evidence_refs: [],
        finding: 'Witness cites an unregistered or empty test set.',
      },
      { name: 'no-op', status: 'PASS', evidence_refs: [] },
      {
        name: 'red-proof',
        status: 'FAIL',
        evidence_refs: [],
        finding: 'Base or feature-overlay execution does not provide an assertion-red proof.',
      },
      {
        name: 'candidate-proof',
        status: 'FAIL',
        evidence_refs: [],
        finding: 'Candidate execution is not green.',
      },
      {
        name: 'scope',
        status: 'FAIL',
        evidence_refs: [],
        finding: 'Candidate diff escapes the declared task scope.',
      },
      {
        name: 'authority',
        status: 'FAIL',
        evidence_refs: [],
        finding: 'Candidate diff crosses the declared role authority.',
      },
      {
        name: 'test-weakening',
        status: 'FAIL',
        evidence_refs: [],
        finding: 'Candidate weakens test evidence.',
      },
      {
        name: 'inventory',
        status: 'FAIL',
        evidence_refs: [],
        finding: 'Inventory delta escapes the witness frame.',
      },
      {
        name: 'effects',
        status: 'FAIL',
        evidence_refs: [],
        finding: 'Inferred effects exceed the witness claim.',
      },
      {
        name: 'strategy-coverage',
        status: 'FAIL',
        evidence_refs: [],
        finding: 'Strategy coverage could not be verified.',
      },
      {
        name: 'expected-diff',
        status: 'FAIL',
        evidence_refs: [],
        finding: 'Observed state changes differ from the trusted manifest.',
      },
    ]);
  });

  function passing(): FrameInput {
    return {
      witness: {
        strategy: 'regression',
        touched: ['src/a.ts'],
        red_green: [{ test_ref: 'tests/a.test.ts' }],
        frame: {
          authority_role: 'engineer',
          inventory_delta_confined_to: ['core'],
          effects_claimed: ['fs:plant'],
        },
      },
      registered_test_refs: ['tests/a.test.ts'],
      task_scope: ['src/**'],
      diff_paths: ['src/a.ts'],
      base_executions: [
        { test_ref: 'tests/a.test.ts', outcome: 'fail', failure_mode: 'assertion' },
      ],
      candidate_executions: [
        { test_ref: 'tests/a.test.ts', outcome: 'pass', failure_mode: 'none' },
      ],
      weakening_clean: true,
      inventory_delta_modules: ['core'],
      inferred_effects: ['fs:plant'],
      expected_state_changes: [{ path: 'proof.json', operation: 'create' }],
      observed_state_changes: [{ path: 'proof.json', operation: 'create' }],
      strategy_coverage: { status: 'pass' },
    };
  }

  it('reports the exact no-op finding for an empty candidate diff', () => {
    const input = passing();
    const result = evaluateTranslationFrames({
      ...input,
      diff_paths: [],
      witness: { ...input.witness, touched: [] },
    });
    expect(result.frames.find((item) => item.name === 'no-op')).toEqual({
      name: 'no-op',
      status: 'FAIL',
      evidence_refs: [],
      finding: 'Candidate has no changed paths.',
    });
  });

  it('rejects a diff population wider than the witness claim', () => {
    const input = passing();
    const result = evaluateTranslationFrames({
      ...input,
      diff_paths: ['src/a.ts', 'src/b.ts'],
      task_scope: ['src/**'],
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.executed_test_refs).toEqual([]);
    expect(result.frames.filter((item) => item.status === 'FAIL').map((item) => item.name)).toEqual(
      ['witness-structure', 'red-proof', 'candidate-proof'],
    );
  });

  it('passes an unexecuted red proof only as an explicit empty-evidence frame', () => {
    const input = passing();
    const result = evaluateTranslationFrames({
      ...input,
      witness: { ...input.witness, strategy: 'structural', red_green: [] },
    });
    expect(result.verdict).toBe('REVIEW');
    expect(result.frames.find((item) => item.name === 'red-proof')).toEqual({
      name: 'red-proof',
      status: 'PASS',
      evidence_refs: [],
    });
  });
});

describe('invariant strategy classification', () => {
  const active = {
    id: 'INV-AUTH-001',
    status: 'active',
    severity: 'hard-fail',
  } as const;
  it.each([
    ['regression', true],
    ['regression', false],
    ['semantic-review', false],
  ] as const)(
    'does not flag %s with deterministic_check_available %s',
    (primary, deterministic_check_available) => {
      expect(
        validateInvariantStrategies([
          { ...active, verification: { strategy: { primary, deterministic_check_available } } },
        ]),
      ).toEqual({ status: 'pass', population: 1, findings: [] });
    },
  );

  it('does not flag a semantic review that declares no deterministic check', () => {
    expect(
      validateInvariantStrategies([
        { ...active, verification: { strategy: { primary: 'semantic-review' } } },
      ]),
    ).toEqual({ status: 'pass', population: 1, findings: [] });
  });
});

describe('linux runner mount reconciliation', () => {
  const marker = 'DEVAI_TRANSLATION_ISOLATION_STARTED\n';
  const spawned = { status: 0, signal: null, stdout: marker, stderr: '' } as const;
  function runnerFixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-translation-runner-')));
    roots.push(root);
    const dependencies = join(root, 'deps');
    mkdirSync(join(dependencies, 'node_modules'), { recursive: true });
    return {
      root,
      dependencies,
      mount: join(root, 'node_modules'),
      input: {
        repo_root: root,
        dependencies_root: dependencies,
        image: `sha256:${'a'.repeat(64)}`,
        argv: ['node', 'test.mjs'],
        timeout_ms: 12000,
      },
    };
  }

  it.each(['prepare', 'remove'] as const)(
    'requires the %s adapter before starting an isolated run',
    async (provided) => {
      const f = runnerFixture();
      let started = false;
      await expect(
        runLinuxIsolated({
          ...f.input,
          ...(provided === 'prepare'
            ? { prepare_dependency_mount_point: () => mkdirSync(f.mount) }
            : { remove_dependency_mount_point: () => rmSync(f.mount, { recursive: true }) }),
          spawn: () => {
            started = true;
            return spawned;
          },
        }),
      ).rejects.toThrow('LINUX_DEPENDENCY_MOUNT_ADAPTER_MISSING');
      expect(started).toBe(false);
      expect(existsSync(f.mount)).toBe(false);
    },
  );

  it('mounts shared dependencies read-only with the exact bind arguments', async () => {
    const f = runnerFixture();
    const calls: unknown[][] = [];
    await runLinuxIsolated({
      ...f.input,
      prepare_dependency_mount_point: () => mkdirSync(f.mount),
      remove_dependency_mount_point: () => rmSync(f.mount, { recursive: true }),
      spawn: (command, args, options) => {
        calls.push([command, args, options]);
        return spawned;
      },
    });
    expect(calls).toEqual([
      [
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--mount',
          `type=bind,src=${f.root},dst=/workspace,readonly`,
          '--mount',
          `type=bind,src=${join(f.dependencies, 'node_modules')},dst=/workspace/node_modules,readonly`,
          '--workdir',
          '/workspace',
          f.input.image,
          'sh',
          '-c',
          'printf \'%s\\n\' DEVAI_TRANSLATION_ISOLATION_STARTED; exec "$@"',
          'devai-translation-isolation',
          'node',
          'test.mjs',
        ],
        { encoding: 'utf8', timeout: 12000 },
      ],
    ]);
  });

  it.each(['EACCES', 'EBUSY', 'ENOTEMPTY'] as const)(
    'retries a busy mount point reported as %s until it is released',
    async (code) => {
      const f = runnerFixture();
      let attempts = 0;
      const result = await runLinuxIsolated({
        ...f.input,
        prepare_dependency_mount_point: () => mkdirSync(f.mount),
        remove_dependency_mount_point: (path) => {
          attempts += 1;
          if (attempts < 3) throw Object.assign(new Error(`busy: ${code}`), { code });
          rmSync(path, { recursive: true });
        },
        spawn: () => spawned,
      });
      expect(attempts).toBe(3);
      expect(result.isolation_applied).toBe(true);
      expect(existsSync(f.mount)).toBe(false);
    },
  );

  it('does not retry a mount point failure outside the released-resource set', async () => {
    const f = runnerFixture();
    const failure = Object.assign(new Error('cleanup refused'), { code: 'EPERM' });
    let attempts = 0;
    await expect(
      runLinuxIsolated({
        ...f.input,
        prepare_dependency_mount_point: () => mkdirSync(f.mount),
        remove_dependency_mount_point: () => {
          attempts += 1;
          throw failure;
        },
        spawn: () => spawned,
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it('refuses to report success when the mount point is never released', async () => {
    const f = runnerFixture();
    let attempts = 0;
    await expect(
      runLinuxIsolated({
        ...f.input,
        prepare_dependency_mount_point: () => mkdirSync(f.mount),
        remove_dependency_mount_point: () => {
          attempts += 1;
        },
        spawn: () => spawned,
      }),
    ).rejects.toThrow('LINUX_DEPENDENCY_MOUNT_CLEANUP_FAILED');
    expect(attempts).toBe(20);
    expect(existsSync(f.mount)).toBe(true);
  });

  it('reports empty standard error when the process supplies neither a stream nor an error', async () => {
    const f = runnerFixture();
    const result = await runLinuxIsolated({
      repo_root: f.root,
      image: f.input.image,
      argv: f.input.argv,
      timeout_ms: f.input.timeout_ms,
      spawn: () => ({ status: 0, signal: null, stdout: marker, stderr: null }),
    });
    expect(result).toEqual({
      exit_code: 0,
      stdout: '',
      stderr: '',
      isolation_applied: true,
    });
  });
});
