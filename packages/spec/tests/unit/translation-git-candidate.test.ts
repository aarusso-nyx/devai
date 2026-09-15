import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAuthorityDecisionIssuer, runWithAuthorityHostEffects } from '@devai-nyx/authority';
import { validators } from '@devai-nyx/schemas';
import { canonicalJson } from '@devai-nyx/utils';
import {
  recordMutationCandidate,
  recordMutationEvidenceCommit,
} from '../../src/translation-validation/index.js';

type Data = Record<string, unknown>;
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
function put(root: string, path: string, value: string) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}
function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return result.stdout.trim();
}
function fixture(sourcePath = 'packages/core/src/example.ts', initiallyPresent = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai candidate ç ')));
  roots.push(root);
  const task = example('task');
  const invariant = example('invariant');
  const claim = example('translation-witness');
  const intent = example('mutation-intent');
  const implementation = structuredClone(claim['implements']) as Data[];
  if (!implementation[0]) throw new Error('missing implementation fixture');
  implementation[0]['invariant_id'] = invariant['id'];
  Object.assign(intent, {
    declared_touched: [sourcePath],
    task_id: task['id'],
    strategy: 'regression',
    implements: implementation,
    red_green: claim['red_green'],
  });
  task['intent_diff'] = { planned_files: intent['declared_touched'] };
  expect(validators.task(task)).toBe(true);
  expect(validators.invariant(invariant)).toBe(true);
  put(root, `.devai/state/tasks/${String(task['id'])}.json`, JSON.stringify(task));
  put(root, `law/invariants/${String(invariant['id'])}.json`, JSON.stringify(invariant));
  put(root, '.gitignore', '.devai/state/r28-index-*\n');
  if (initiallyPresent) put(root, sourcePath, 'export const value = 1;\n');
  git(root, 'init', '-b', 'fixture');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture base');
  intent['base_sha'] = git(root, 'rev-parse', 'HEAD');
  expect(validators.mutationIntent(intent)).toBe(true);
  return { root, intent, sourcePath };
}

// A trusted unit-fixture adapter executes real Git only inside this disposable
// repository. It tests recorder behavior, not installed policy authorization.
async function runRecorder<T>(root: string, callback: () => Promise<T>): Promise<T> {
  let ordinal = 0;
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'git-recorder-fixture',
    issuer_version: '1.0.0',
    invocation_id: 'fixture-invocation',
    canonicalSha256: (value: unknown) =>
      createHash('sha256').update(canonicalJson(value)).digest('hex'),
    randomId: () => `fixture-${++ordinal}`,
    now: () => '2026-09-07T00:00:00.000Z',
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
          expect(request.symbol).toBe('spawnSync');
          const [executable, args, options] = request.arguments;
          expect(executable).toBe('git');
          expect(Array.isArray(args)).toBe(true);
          const argv = args as string[];
          expect(verbs.has(argv[0] ?? '')).toBe(true);
          expect(options).toMatchObject({ cwd: root, shell: false });
          if (argv[0] === 'clean')
            expect(argv).toEqual([
              'clean',
              '-f',
              '-x',
              '--',
              '.devai/state/r28-index-MI-0123456789abcdef',
            ]);
          if (argv[0] === 'update-ref')
            expect([
              'refs/devai/r28/candidates/MI-0123456789abcdef',
              'refs/devai/r28/evidence/MI-0123456789abcdef',
            ]).toContain(argv[1]);
          return apply();
        },
      },
      callback,
    );
  } finally {
    issuer.dispose();
  }
}

it('records exact candidate bytes without moving HEAD or staging runtime proofs in the caller index', async () => {
  const f = fixture();
  const indexBefore = readFileSync(join(f.root, '.git/index'));
  const runtime = 'record/proofs/work/recipe-runs/devai-fix/test/run.json';
  const result = await runRecorder(f.root, () =>
    recordMutationCandidate({
      repo_root: f.root,
      intent: f.intent,
      emitted_at: '2026-09-07T00:00:00.000Z',
      run: async () => {
        put(f.root, 'packages/core/src/example.ts', 'export const value = 2;\n');
        put(f.root, runtime, '{"status":"pass"}\n');
        return { status: 'pass' };
      },
    }),
  );
  expect(readFileSync(join(f.root, '.git/index'))).toEqual(indexBefore);
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.intent['base_sha']);
  expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/fixture');
  expect(git(f.root, 'rev-parse', `${result.candidate_sha}^`)).toBe(f.intent['base_sha']);
  expect(git(f.root, 'rev-parse', result.candidate_ref)).toBe(result.candidate_sha);
  expect(git(f.root, 'show', `${result.candidate_sha}:packages/core/src/example.ts`)).toBe(
    'export const value = 2;',
  );
  expect(
    git(f.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.candidate_sha),
  ).toBe('packages/core/src/example.ts');
  expect(result.touched).toEqual(['packages/core/src/example.ts']);
  expect(result.runtime_state_paths).toEqual([runtime]);
  expect(validators.translationWitness(result.witness)).toBe(true);
  expect(result.witness).toMatchObject({
    base_sha: f.intent['base_sha'],
    candidate_sha: result.candidate_sha,
    trust: 'untrusted-claim',
  });
  expect(existsSync(join(f.root, '.devai/state/r28-index-MI-0123456789abcdef'))).toBe(false);
});

it.each([
  ['noop', 'MUTATION_NO_OP'],
  ['runtime-only', 'MUTATION_NO_OP'],
  ['undeclared', 'MUTATION_UNDECLARED_PATH'],
  ['ref-change', 'MUTATION_UNEXPECTED_GIT_STATE'],
  ['branch-change', 'MUTATION_UNEXPECTED_GIT_STATE'],
  ['temp-index', 'MUTATION_TEMP_INDEX_EXISTS'],
] as const)(
  'refuses %s without publishing a candidate or replacing the caller index',
  async (kind, reason) => {
    const f = fixture();
    if (kind === 'branch-change') git(f.root, 'branch', 'other');
    const index = readFileSync(join(f.root, '.git/index'));
    await expect(
      runRecorder(f.root, () =>
        recordMutationCandidate({
          repo_root: f.root,
          intent: f.intent,
          emitted_at: '2026-09-07T00:00:00.000Z',
          run: async () => {
            if (kind !== 'noop' && kind !== 'runtime-only')
              put(f.root, 'packages/core/src/example.ts', 'export const value = 2;\n');
            if (kind === 'runtime-only')
              put(f.root, 'record/proofs/work/recipe-runs/devai-fix/test/run.json', '{}');
            if (kind === 'undeclared') put(f.root, 'packages/core/src/extra.ts', 'export {};\n');
            if (kind === 'ref-change')
              git(f.root, 'update-ref', 'refs/heads/extra', String(f.intent['base_sha']));
            if (kind === 'branch-change') git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/other');
            if (kind === 'temp-index')
              put(
                f.root,
                '.devai/state/r28-index-MI-0123456789abcdef',
                'preserve this preexisting index',
              );
            return { status: 'pass' };
          },
        }),
      ),
    ).rejects.toThrow(reason);
    expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/candidates')).toBe(
      '',
    );
    if (kind === 'temp-index')
      expect(readFileSync(join(f.root, '.devai/state/r28-index-MI-0123456789abcdef'), 'utf8')).toBe(
        'preserve this preexisting index',
      );
  },
);

it('refuses a dirty initial checkout before calling the recipe', async () => {
  const f = fixture();
  put(f.root, 'packages/core/src/example.ts', 'user-owned dirty bytes');
  let invoked = false;
  await expect(
    runRecorder(f.root, () =>
      recordMutationCandidate({
        repo_root: f.root,
        intent: f.intent,
        emitted_at: '2026-09-07T00:00:00.000Z',
        run: async () => {
          invoked = true;
        },
      }),
    ),
  ).rejects.toThrow('MUTATION_WORKTREE_NOT_CLEAN');
  expect(invoked).toBe(false);
  expect(readFileSync(join(f.root, 'packages/core/src/example.ts'), 'utf8')).toBe(
    'user-owned dirty bytes',
  );
});

it.each(['with space.ts', 'café.ts', 'quoted"name.ts'])(
  'records the literal Git path %s without interpreting display quoting',
  async (name) => {
    const f = fixture(`packages/core/src/${name}`);
    const result = await runRecorder(f.root, () =>
      recordMutationCandidate({
        repo_root: f.root,
        intent: f.intent,
        emitted_at: '2026-09-07T00:00:00.000Z',
        run: async () => {
          put(f.root, f.sourcePath, 'export const value = 2;\n');
        },
      }),
    );
    expect(result.touched).toEqual([f.sourcePath]);
    expect(git(f.root, 'show', `${result.candidate_sha}:${f.sourcePath}`)).toBe(
      'export const value = 2;',
    );
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.intent['base_sha']);
    expect(validators.translationWitness(result.witness)).toBe(true);
  },
);

it.each(['new café.ts', 'new"quote.ts', 'trailing.ts '])(
  'records the exact untracked filename %j',
  async (name) => {
    const f = fixture(`packages/core/src/${name}`, false);
    const result = await runRecorder(f.root, () =>
      recordMutationCandidate({
        repo_root: f.root,
        intent: f.intent,
        emitted_at: '2026-09-07T00:00:00.000Z',
        run: async () => {
          put(f.root, f.sourcePath, 'export const value = 2;\n');
        },
      }),
    );
    expect(result.touched).toEqual([f.sourcePath]);
    expect(git(f.root, 'show', `${result.candidate_sha}:${f.sourcePath}`)).toBe(
      'export const value = 2;',
    );
  },
);

async function evidenceFixture(sourcePath = 'packages/core/src/example.ts') {
  const f = fixture(sourcePath);
  const candidate = await runRecorder(f.root, () =>
    recordMutationCandidate({
      repo_root: f.root,
      intent: f.intent,
      emitted_at: '2026-09-07T00:00:00.000Z',
      run: async () => {
        put(f.root, f.sourcePath, 'export const value = 2;\n');
      },
    }),
  );
  const witness = candidate.witness;
  const witnessPath = `record/proofs/compliance/translation-validation/witnesses/${String(witness['id'])}.json`;
  const recipePath = 'record/proofs/work/recipe-runs/devai-fix/test/run.json';
  const agent = example('agent-run');
  agent['started_at'] = '2026-09-07T00:00:00.000Z';
  agent['ended_at'] = '2026-09-07T00:01:00.000Z';
  agent['caller'] = { kind: 'recipe', name: 'devai-fix' };
  agent['files_written'] = [recipePath, witnessPath];
  const { manifest_hash: _oldHash, ...draft } = agent;
  agent['manifest_hash'] = createHash('sha256').update(canonicalJson(draft)).digest('hex');
  expect(validators.agentRun(agent)).toBe(true);
  const agentPath = `record/proofs/work/agent-runs/${String(agent['run_id'])}.json`;
  put(f.root, witnessPath, JSON.stringify(witness));
  put(
    f.root,
    recipePath,
    JSON.stringify({
      recipe_name: 'devai-fix',
      recipe_variant: 'test',
      status: 'pass',
      evidence: { translation_witness: witness },
    }),
  );
  put(f.root, agentPath, JSON.stringify(agent));
  const inputs = {
    repo_root: f.root,
    intent_id: String(f.intent['id']),
    candidate_sha: candidate.candidate_sha,
    timestamp: '2026-09-07T00:01:00.000Z',
    recipe_name: 'devai-fix',
    recipe_variant: 'test',
    witness,
    state_paths: [
      witnessPath,
      recipePath,
      agentPath,
      `.devai/state/tasks/${String(f.intent['task_id'])}.json`,
    ],
  };
  return { ...f, candidate, inputs };
}

it.each(['example.ts', 'café.ts'])(
  'records evidence on the exact candidate without rebuilding %s',
  async (name) => {
    const f = await evidenceFixture(`packages/core/src/${name}`);
    const index = readFileSync(join(f.root, '.git/index'));
    const expected = new Map(
      f.inputs.state_paths.map((path) => [path, readFileSync(join(f.root, path), 'utf8')]),
    );
    const result = await runRecorder(f.root, async () => recordMutationEvidenceCommit(f.inputs));
    expect(git(f.root, 'rev-parse', `${result.evidence_sha}^`)).toBe(f.candidate.candidate_sha);
    expect(git(f.root, 'rev-parse', result.evidence_ref)).toBe(result.evidence_sha);
    expect(
      git(f.root, 'diff', f.candidate.candidate_sha, result.evidence_sha, '--', 'packages'),
    ).toBe('');
    for (const [path, bytes] of expected)
      expect(git(f.root, 'show', `${result.evidence_sha}:${path}`)).toBe(bytes.trim());
    expect(result.state_paths).toEqual([...f.inputs.state_paths].sort());
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.intent['base_sha']);
    expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
    expect(existsSync(join(f.root, '.devai/state/r28-index-MI-0123456789abcdef'))).toBe(false);
  },
);

it('refuses a different candidate commit even when its source tree and changed paths are identical', async () => {
  const f = await evidenceFixture();
  const tree = git(f.root, 'rev-parse', `${f.candidate.candidate_sha}^{tree}`);
  const other = git(
    f.root,
    'commit-tree',
    tree,
    '-p',
    String(f.intent['base_sha']),
    '-m',
    'another candidate identity',
  );
  expect(other).not.toBe(f.candidate.candidate_sha);
  await expect(
    runRecorder(f.root, async () =>
      recordMutationEvidenceCommit({ ...f.inputs, candidate_sha: other }),
    ),
  ).rejects.toThrow('MUTATION_EVIDENCE_CANDIDATE_MISMATCH');
  expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
});

it.each([
  ['devai-verify', 'test'],
  ['devai-fix', 'other'],
])(
  'binds the evidence recorder recipe to the witness: %s/%s',
  async (recipeName, recipeVariant) => {
    const f = await evidenceFixture();
    const oldPath = 'record/proofs/work/recipe-runs/devai-fix/test/run.json';
    const newPath = `record/proofs/work/recipe-runs/${recipeName}/${recipeVariant}/run.json`;
    put(
      f.root,
      newPath,
      JSON.stringify({
        recipe_name: recipeName,
        recipe_variant: recipeVariant,
        status: 'pass',
        evidence: { translation_witness: f.inputs.witness },
      }),
    );
    rmSync(join(f.root, oldPath));
    const agentPath = f.inputs.state_paths.find((path) =>
      path.startsWith('record/proofs/work/agent-runs/'),
    );
    if (!agentPath) throw new Error('fixture agent run missing');
    const agent = JSON.parse(readFileSync(join(f.root, agentPath), 'utf8')) as Data;
    agent['caller'] = { kind: 'recipe', name: recipeName };
    agent['files_written'] = (agent['files_written'] as string[]).map((path) =>
      path === oldPath ? newPath : path,
    );
    const { manifest_hash: _oldHash, ...draft } = agent;
    agent['manifest_hash'] = createHash('sha256').update(canonicalJson(draft)).digest('hex');
    expect(validators.agentRun(agent)).toBe(true);
    put(f.root, agentPath, JSON.stringify(agent));
    const input = {
      ...f.inputs,
      recipe_name: recipeName,
      recipe_variant: recipeVariant,
      state_paths: f.inputs.state_paths.map((path) => (path === oldPath ? newPath : path)),
    };
    await expect(
      runRecorder(f.root, async () => recordMutationEvidenceCommit(input)),
    ).rejects.toThrow('MUTATION_EVIDENCE_RECIPE_MISMATCH');
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
  },
);

it('rejects a corrupt agent-run hash even when its schema and claimed output paths are valid', async () => {
  const f = await evidenceFixture();
  const path = f.inputs.state_paths.find((value) =>
    value.startsWith('record/proofs/work/agent-runs/'),
  );
  if (!path) throw new Error('fixture agent run missing');
  const agent = JSON.parse(readFileSync(join(f.root, path), 'utf8')) as Data;
  agent['manifest_hash'] = '0'.repeat(64);
  expect(validators.agentRun(agent)).toBe(true);
  put(f.root, path, JSON.stringify(agent));
  await expect(
    runRecorder(f.root, async () => recordMutationEvidenceCommit(f.inputs)),
  ).rejects.toThrow('MUTATION_EVIDENCE_AGENT_RUN_INVALID');
  expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
});

it.each(['standalone', 'embedded'] as const)(
  'accepts reordered keys in the %s witness without rewriting its bytes',
  async (location) => {
    const f = await evidenceFixture();
    const reordered = Object.fromEntries(Object.entries(f.inputs.witness).reverse());
    expect(validators.translationWitness(reordered)).toBe(true);
    expect(canonicalJson(reordered)).toBe(canonicalJson(f.inputs.witness));
    const path = f.inputs.state_paths.find((value) =>
      location === 'standalone'
        ? value.startsWith('record/proofs/compliance/translation-validation/witnesses/')
        : value.startsWith('record/proofs/work/recipe-runs/'),
    );
    if (!path) throw new Error('fixture witness path missing');
    const content =
      location === 'standalone'
        ? reordered
        : {
            recipe_name: 'devai-fix',
            recipe_variant: 'test',
            status: 'pass',
            evidence: { translation_witness: reordered },
          };
    put(f.root, path, JSON.stringify(content));
    const bytes = readFileSync(join(f.root, path), 'utf8');
    const index = readFileSync(join(f.root, '.git/index'));
    const result = await runRecorder(f.root, async () => recordMutationEvidenceCommit(f.inputs));
    expect(git(f.root, 'show', `${result.evidence_sha}:${path}`)).toBe(bytes);
    expect(readFileSync(join(f.root, path), 'utf8')).toBe(bytes);
    expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
  },
);

it.each(['standalone', 'embedded'] as const)(
  'refuses changed semantic content in the %s witness',
  async (location) => {
    const f = await evidenceFixture();
    const changed = { ...f.inputs.witness, notes: ['Different untrusted witness claim.'] };
    expect(validators.translationWitness(changed)).toBe(true);
    const path = f.inputs.state_paths.find((value) =>
      location === 'standalone'
        ? value.startsWith('record/proofs/compliance/translation-validation/witnesses/')
        : value.startsWith('record/proofs/work/recipe-runs/'),
    );
    if (!path) throw new Error('fixture witness path missing');
    put(
      f.root,
      path,
      JSON.stringify(
        location === 'standalone'
          ? changed
          : {
              recipe_name: 'devai-fix',
              recipe_variant: 'test',
              status: 'pass',
              evidence: { translation_witness: changed },
            },
      ),
    );
    const bytes = readFileSync(join(f.root, path));
    const index = readFileSync(join(f.root, '.git/index'));
    await expect(
      runRecorder(f.root, async () => recordMutationEvidenceCommit(f.inputs)),
    ).rejects.toThrow('MUTATION_EVIDENCE_WITNESS_MISMATCH');
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
    expect(readFileSync(join(f.root, path))).toEqual(bytes);
    expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
  },
);

it.each([
  ['duplicate', 'MUTATION_EVIDENCE_STATE_DUPLICATE'],
  ['missing-file', 'MUTATION_EVIDENCE_STATE_MISSING'],
  ['directory', 'MUTATION_EVIDENCE_STATE_PATH_INVALID'],
  ['symlink', 'MUTATION_EVIDENCE_STATE_PATH_INVALID'],
  ['outside-prefix', 'MUTATION_EVIDENCE_STATE_PATH_INVALID'],
  ['parent-segment', 'MUTATION_EVIDENCE_STATE_PATH_INVALID'],
  ['unrelated-proof', 'MUTATION_EVIDENCE_STATE_PATH_INVALID'],
  ['agent-suffix', 'MUTATION_EVIDENCE_STATE_PATH_INVALID'],
  ['omitted-witness', 'MUTATION_EVIDENCE_WITNESS_MISSING'],
  ['omitted-task', 'MUTATION_EVIDENCE_TASK_MISSING'],
] as const)(
  'refuses %s evidence population without altering the index or existing proof bytes',
  async (kind, code) => {
    const f = await evidenceFixture();
    const recipe = 'record/proofs/work/recipe-runs/devai-fix/test/run.json';
    let paths = [...f.inputs.state_paths];
    if (kind === 'duplicate') paths.push(recipe);
    else if (kind === 'missing-file')
      paths.push('record/proofs/work/recipe-runs/devai-fix/test/missing.json');
    else if (kind === 'directory') {
      const directory = 'record/proofs/work/recipe-runs/devai-fix/test/directory.json';
      mkdirSync(join(f.root, directory));
      paths.push(directory);
    } else if (kind === 'symlink') {
      const backing = 'record/proofs/work/recipe-runs/devai-fix/test/backing.json';
      renameSync(join(f.root, recipe), join(f.root, backing));
      symlinkSync('backing.json', join(f.root, recipe));
    } else if (kind === 'outside-prefix') {
      put(f.root, 'unrelated.json', '{}');
      paths.push('unrelated.json');
    } else if (kind === 'parent-segment') {
      paths.push('record/proofs/work/recipe-runs/devai-fix/test/../test/run.json');
    } else if (kind === 'unrelated-proof') {
      put(f.root, 'record/proofs/unrelated.json', '{}');
      paths.push('record/proofs/unrelated.json');
    } else if (kind === 'agent-suffix') {
      const path = 'record/proofs/work/agent-runs/AR-extra.json.backup';
      put(f.root, path, '{}');
      paths.push(path);
    } else if (kind === 'omitted-witness') {
      paths = paths.filter(
        (path) => !path.startsWith('record/proofs/compliance/translation-validation/witnesses/'),
      );
    } else if (kind === 'omitted-task') {
      paths = paths.filter((path) => !path.startsWith('.devai/state/tasks/'));
    }
    const retained = new Map(
      f.inputs.state_paths.map((path) => [path, readFileSync(join(f.root, path))]),
    );
    const index = readFileSync(join(f.root, '.git/index'));
    await expect(
      runRecorder(f.root, async () =>
        recordMutationEvidenceCommit({ ...f.inputs, state_paths: paths }),
      ),
    ).rejects.toThrow(code);
    expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.intent['base_sha']);
    for (const [path, bytes] of retained) expect(readFileSync(join(f.root, path))).toEqual(bytes);
  },
);

it.each(['run-id', 'caller-kind', 'caller-name', 'recipe-output', 'witness-output'] as const)(
  'refuses a schema-valid, correctly hashed agent manifest with a mismatched %s',
  async (kind) => {
    const f = await evidenceFixture();
    const path = f.inputs.state_paths.find((value) =>
      value.startsWith('record/proofs/work/agent-runs/'),
    );
    if (!path) throw new Error('fixture agent path missing');
    const agent = JSON.parse(readFileSync(join(f.root, path), 'utf8')) as Data;
    if (kind === 'run-id') agent['run_id'] = 'AR-01990000-0000-7000-8000-000000000001';
    else if (kind === 'caller-kind') agent['caller'] = { kind: 'cli', name: 'devai-fix' };
    else if (kind === 'caller-name') agent['caller'] = { kind: 'recipe', name: 'devai-verify' };
    else {
      const written = agent['files_written'];
      if (!Array.isArray(written)) throw new Error('fixture files missing');
      agent['files_written'] = written.filter(
        (value) =>
          typeof value === 'string' &&
          !(kind === 'recipe-output'
            ? value.startsWith('record/proofs/work/recipe-runs/')
            : value.startsWith('record/proofs/compliance/')),
      );
    }
    const { manifest_hash: _oldHash, ...draft } = agent;
    agent['manifest_hash'] = createHash('sha256').update(canonicalJson(draft)).digest('hex');
    expect(validators.agentRun(agent)).toBe(true);
    put(f.root, path, JSON.stringify(agent));
    const bytes = readFileSync(join(f.root, path));
    const index = readFileSync(join(f.root, '.git/index'));
    await expect(
      runRecorder(f.root, async () => recordMutationEvidenceCommit(f.inputs)),
    ).rejects.toThrow('MUTATION_EVIDENCE_AGENT_RUN_MISMATCH');
    expect(readFileSync(join(f.root, path))).toEqual(bytes);
    expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/devai/r28/evidence')).toBe('');
  },
);

it('accepts absolute agent output paths inside the candidate and retains their original bytes', async () => {
  const f = await evidenceFixture();
  const path = f.inputs.state_paths.find((value) =>
    value.startsWith('record/proofs/work/agent-runs/'),
  );
  if (!path) throw new Error('fixture agent path missing');
  const agent = JSON.parse(readFileSync(join(f.root, path), 'utf8')) as Data;
  const written = agent['files_written'];
  if (!Array.isArray(written)) throw new Error('fixture files missing');
  agent['files_written'] = written.map((value) => {
    if (typeof value !== 'string') throw new Error('fixture path not a string');
    return join(f.root, value);
  });
  const { manifest_hash: _oldHash, ...draft } = agent;
  agent['manifest_hash'] = createHash('sha256').update(canonicalJson(draft)).digest('hex');
  expect(validators.agentRun(agent)).toBe(true);
  put(f.root, path, JSON.stringify(agent));
  const bytes = readFileSync(join(f.root, path), 'utf8');
  const result = await runRecorder(f.root, async () => recordMutationEvidenceCommit(f.inputs));
  expect(git(f.root, 'show', `${result.evidence_sha}:${path}`)).toBe(bytes);
  expect(readFileSync(join(f.root, path), 'utf8')).toBe(bytes);
});
