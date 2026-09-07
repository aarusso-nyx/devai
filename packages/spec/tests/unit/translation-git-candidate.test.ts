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
import { afterEach, expect, it } from 'vitest';
import { createAuthorityDecisionIssuer, runWithAuthorityHostEffects } from '@devai-nyx/authority';
import { validators } from '@devai-nyx/schemas';
import { canonicalJson } from '@devai-nyx/utils';
import { recordMutationCandidate } from '../../src/translation-validation/index.js';

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
            expect(argv[1]).toBe('refs/devai/r28/candidates/MI-0123456789abcdef');
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
