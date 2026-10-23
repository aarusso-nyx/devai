// Owner ruling (b) on #412: non-experimental `round run` gets its diff-scope check in 2.7.0.
// A literal routine is judged like an experimental attempt: every tracked path the routine
// changes in its execution root must belong to the task discipline by Article 6 (the Engineer
// focused-regression verb of ADR-GOV-0026 included) and lie inside the declared task boundary.
// Changes already present before the routine started are not its own; runtime state under
// `.devai/state/` is the executing verb's.
import { runWithAuthorityHostEffects, type AuthorityHostEffectScope } from '@devai-nyx/authority';
import type { TaskRecord } from '@devai-nyx/loop';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import { dispatchRoundTask } from '../../src/commands/round/dispatch.js';

const ROUND = 'R-9412';
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) Reflect.deleteProperty(process.env, name);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const EXISTING_TEST = [
  "import { expect, it } from 'vitest';",
  "import { a } from '../../src/a.js';",
  "it('is one', () => expect(a).toBe(1));",
  '',
].join('\n');

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, stdio: 'ignore' },
  );
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function repository(constitution?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-round-run-write-scope-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'commit.gpgsign', 'false');
  put(root, 'AGENTS.md', '# Fixture adopter\n');
  put(root, 'packages/app/src/a.ts', 'export const a = 1;\n');
  put(root, 'packages/app/src/b.ts', 'export const b = 1;\n');
  put(root, 'packages/app/tests/unit/a.test.ts', EXISTING_TEST);
  put(root, 'docs/index.md', '# Docs\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');
  if (constitution !== undefined) {
    put(
      root,
      '.devai/pin/constitution.md',
      `# DEVAI Constitution — ${constitution}\n\n**Version:** ${constitution}\n`,
    );
  }
  return root;
}

/** A Node routine that applies `edits` (null deletes) in its working directory. */
function editing(edits: Readonly<Record<string, string | null>>, commit = false): string[] {
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `for (const [file, content] of Object.entries(${JSON.stringify(edits)})) {`,
    '  if (content === null) fs.rmSync(file);',
    '  else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }',
    '}',
    ...(commit
      ? [
          "const run = (...args) => require('node:child_process').execFileSync('git', ['-c', 'user.name=R', '-c', 'user.email=r@example.invalid', '-c', 'commit.gpgsign=false', ...args]);",
          "run('add', '-A'); run('commit', '-qm', 'routine');",
        ]
      : []),
  ].join('\n');
  return [process.execPath, '-e', script];
}

function routineTask(argv: readonly string[], overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: '2.0.0',
    id: 'TASK-9412',
    round_id: ROUND,
    status: 'queued',
    discipline: 'engineer',
    title: 'Routine write-scope fixture',
    target_modules: [],
    target_substrates: ['F2'],
    created_at: '2026-10-22T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'routine',
      argv: [...argv],
      cwd: '.',
      inputs: [],
      outputs: [],
      effects: ['local-write'],
      timeout_ms: 60_000,
      authority_checks: ['discipline'],
    },
    ...overrides,
  } as TaskRecord;
}

async function permissive<T>(run: () => Promise<T>): Promise<T> {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'round-run-write-scope' });
  const scope: AuthorityHostEffectScope = {
    action_id: 'round run',
    invocation_id: 'round-run-write-scope',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: (_request, apply) => apply(),
  };
  try {
    return await runWithAuthorityHostEffects(scope, run);
  } finally {
    issuer.dispose();
  }
}

function dispatch(root: string, task: TaskRecord) {
  return permissive(() => dispatchRoundTask(root, task));
}

function evidence(root: string): Record<string, unknown> {
  const dir = join(root, '.devai/state/round-runs', ROUND, 'task-executions');
  const [name] = readdirSync(dir);
  return JSON.parse(readFileSync(join(dir, name ?? ''), 'utf8')) as Record<string, unknown>;
}

describe('round run judges a routine diff by Article 6 (ruling (b))', () => {
  it('passes an Engineer routine that writes only Engineer paths', async () => {
    const root = repository();
    const result = await dispatch(
      root,
      routineTask(editing({ 'packages/app/src/c.ts': 'export const c = 1;\n' })),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('fails an Engineer routine that writes outside its paths and names the path', async () => {
    const root = repository();
    const result = await dispatch(root, routineTask(editing({ 'docs/index.md': '# Changed\n' })));
    expect(result).toMatchObject({ ok: false, code: 'TASK_WRITE_SCOPE_VIOLATION' });
    expect(evidence(root)).toMatchObject({
      verdict: 'fail',
      failure: {
        code: 'TASK_WRITE_SCOPE_VIOLATION',
        message: expect.stringContaining('docs/index.md') as unknown,
      },
    });
  });

  it('fails an Inspector routine that writes a source', async () => {
    const root = repository();
    const result = await dispatch(
      root,
      routineTask(editing({ 'packages/app/src/a.ts': 'export const a = 2;\n' }), {
        discipline: 'inspector',
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'TASK_WRITE_SCOPE_VIOLATION' });
  });

  it('sees a change the routine committed itself', async () => {
    const root = repository();
    const result = await dispatch(
      root,
      routineTask(editing({ 'docs/index.md': '# Committed\n' }, true)),
    );
    expect(result).toMatchObject({ ok: false, code: 'TASK_WRITE_SCOPE_VIOLATION' });
  });

  it('sees a deletion outside the paths', async () => {
    const root = repository();
    const result = await dispatch(root, routineTask(editing({ 'docs/index.md': null })));
    expect(result).toMatchObject({ ok: false, code: 'TASK_WRITE_SCOPE_VIOLATION' });
  });

  it('does not charge the routine with changes present before it started', async () => {
    const root = repository();
    put(root, 'docs/index.md', '# Edited by a human before the run\n');
    put(root, 'docs/draft.md', '# Untracked draft\n');
    const result = await dispatch(
      root,
      routineTask(editing({ 'packages/app/src/c.ts': 'export const c = 1;\n' })),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('charges the routine with a further change to an already changed path', async () => {
    const root = repository();
    put(root, 'docs/index.md', '# Edited by a human before the run\n');
    const result = await dispatch(root, routineTask(editing({ 'docs/index.md': '# Again\n' })));
    expect(result).toMatchObject({ ok: false, code: 'TASK_WRITE_SCOPE_VIOLATION' });
  });

  it('leaves runtime state under .devai/state/ to the executing verb', async () => {
    const root = repository();
    const result = await dispatch(
      root,
      routineTask(editing({ '.devai/state/readings/r.json': '{}\n' })),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('keeps a routine that changed nothing passing', async () => {
    const root = repository();
    const result = await dispatch(root, routineTask([process.execPath, '-e', 'process.exit(0)']));
    expect(result).toMatchObject({ ok: true });
  });
});

// Codex review on #426: Git tracks a file's executable bit and a symbolic link's target, not only
// regular-file bytes, so a routine must not be able to change either outside its scope unseen.
describe('round run sees mode and symbolic-link changes', () => {
  const node = (script: string): string[] => [process.execPath, '-e', script];

  it('fails a routine that only makes an out-of-scope file executable', async () => {
    const root = repository();
    const result = await dispatch(
      root,
      routineTask(node("require('node:fs').chmodSync('docs/index.md', 0o755)")),
    );
    expect(result).toMatchObject({ ok: false, code: 'TASK_WRITE_SCOPE_VIOLATION' });
  });

  it('passes a routine that makes an in-scope file executable', async () => {
    const root = repository();
    const result = await dispatch(
      root,
      routineTask(node("require('node:fs').chmodSync('packages/app/src/a.ts', 0o755)")),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('fails a routine that adds an out-of-scope symbolic link', async () => {
    const root = repository();
    const result = await dispatch(
      root,
      routineTask(node("require('node:fs').symlinkSync('../AGENTS.md', 'docs/link.md')")),
    );
    expect(result).toMatchObject({ ok: false, code: 'TASK_WRITE_SCOPE_VIOLATION' });
    expect(evidence(root)).toMatchObject({
      failure: { message: expect.stringContaining('docs/link.md') as unknown },
    });
  });

  it('fails a routine that retargets a tracked out-of-scope symbolic link', async () => {
    const root = repository();
    symlinkSync('index.md', join(root, 'docs/current.md'));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'link');
    const result = await dispatch(
      root,
      routineTask(
        node(
          "const fs = require('node:fs'); fs.rmSync('docs/current.md'); fs.symlinkSync('../AGENTS.md', 'docs/current.md');",
        ),
      ),
    );
    expect(result).toMatchObject({ ok: false, code: 'TASK_WRITE_SCOPE_VIOLATION' });
  });

  it('fails a routine that adds a symbolic link outside the declared boundary', async () => {
    const root = repository();
    const result = await dispatch(
      root,
      routineTask(node("require('node:fs').symlinkSync('a.ts', 'packages/app/src/alias.ts')"), {
        intent_diff: { planned_files: ['packages/app/src/a.ts'] },
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'TASK_BOUNDARY_VIOLATION' });
  });
});

describe('round run judges a routine diff against the declared task boundary', () => {
  it('fails a write inside the discipline paths but outside intent_diff.planned_files', async () => {
    const root = repository();
    const result = await dispatch(
      root,
      routineTask(editing({ 'packages/app/src/b.ts': 'export const b = 2;\n' }), {
        intent_diff: { planned_files: ['packages/app/src/a.ts'] },
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'TASK_BOUNDARY_VIOLATION' });
  });

  it('passes a write under a declared directory boundary', async () => {
    const root = repository();
    const result = await dispatch(
      root,
      routineTask(editing({ 'packages/app/src/b.ts': 'export const b = 2;\n' }), {
        intent_diff: { planned_files: ['packages/app/src/'] },
      }),
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe('round run applies the Engineer focused-regression verb (ADR-GOV-0026)', () => {
  const ADJACENT = {
    'packages/app/src/a.ts': 'export const a = 2;\n',
    'packages/app/tests/unit/a-regression.test.ts': [
      "import { expect, it } from 'vitest';",
      "import { a } from '../../src/a.js';",
      "it('is two', () => expect(a).toBe(2));",
      '',
    ].join('\n'),
  };

  it('passes a source change with its adjacent test under constitution 1.1.0', async () => {
    const root = repository('1.1.0');
    expect(await dispatch(root, routineTask(editing(ADJACENT)))).toMatchObject({ ok: true });
  });

  it('fails the same routine under constitution 1.0.2', async () => {
    const root = repository('1.0.2');
    expect(await dispatch(root, routineTask(editing(ADJACENT)))).toMatchObject({
      ok: false,
      code: 'TASK_WRITE_SCOPE_VIOLATION',
    });
  });

  it('fails an edit to an assertion of an existing test', async () => {
    const root = repository('1.1.0');
    const result = await dispatch(
      root,
      routineTask(
        editing({
          'packages/app/src/a.ts': 'export const a = 2;\n',
          'packages/app/tests/unit/a.test.ts': EXISTING_TEST.replace('toBe(1)', 'toBe(2)'),
        }),
      ),
    );
    expect(result).toMatchObject({ ok: false, code: 'TASK_WRITE_SCOPE_VIOLATION' });
  });
});

// Codex review on #426 (second pass): a routine could commit an out-of-scope change and then
// restore the file in the working tree, so the final tree matched the baseline while the
// candidate commit carried the change. Committed changes are judged on their own.
describe('round run judges committed changes even when the working tree is restored', () => {
  const commitThenRestore = (path: string, content: string): string[] => [
    process.execPath,
    '-e',
    [
      "const fs = require('node:fs');",
      "const run = (...args) => require('node:child_process').execFileSync('git', ['-c', 'user.name=R', '-c', 'user.email=r@example.invalid', '-c', 'commit.gpgsign=false', ...args]);",
      `const original = fs.readFileSync(${JSON.stringify(path)});`,
      `fs.writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)});`,
      "run('add', '-A'); run('commit', '-qm', 'routine');",
      `fs.writeFileSync(${JSON.stringify(path)}, original);`,
    ].join('\n'),
  ];

  it('fails a routine that commits an out-of-scope change and restores the file', async () => {
    const root = repository();
    const result = await dispatch(
      root,
      routineTask(commitThenRestore('docs/index.md', '# Hidden\n')),
    );
    expect(result).toMatchObject({ ok: false, code: 'TASK_WRITE_SCOPE_VIOLATION' });
    expect(evidence(root)).toMatchObject({
      failure: { message: expect.stringContaining('docs/index.md') as unknown },
    });
  });

  it('fails a routine whose committed change the working tree no longer matches', async () => {
    const root = repository();
    const result = await dispatch(
      root,
      routineTask(commitThenRestore('packages/app/src/a.ts', 'export const a = 3;\n')),
    );
    expect(result).toMatchObject({ ok: false, code: 'TASK_WRITE_SCOPE_VIOLATION' });
  });

  it('still passes a routine that commits an in-scope change and keeps it', async () => {
    const root = repository();
    const result = await dispatch(
      root,
      routineTask(editing({ 'packages/app/src/a.ts': 'export const a = 3;\n' }, true)),
    );
    expect(result).toMatchObject({ ok: true });
  });
});
