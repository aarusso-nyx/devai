// ADR-GOV-0026 IA-001, IA-002 and IA-004 (issue #412) through `round dispatch`: the attempt diff
// check admits an Engineer regression test only when it imports a source the same attempt
// changed, never an assertion edit to an existing test, and only under a pinned constitution
// that grants the verb (1.1.0). A scripted provider writes the files; no live provider runs.
import { runWithAuthorityHostEffects, type AuthorityHostEffectScope } from '@devai-nyx/authority';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import {
  loadTask,
  runRoundTasks,
  saveTask,
  type ExperimentalActivation,
  type TaskRecord,
} from '@devai-nyx/loop';
import { composeAgentPrompt } from '@devai-nyx/skills';
import {
  dispatchExperimentalTask,
  type ExperimentalBudget,
} from '../../src/services/experimental-dispatch/index.js';

const ROUND = 'R-0412';
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) Reflect.deleteProperty(process.env, name);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

const EXISTING_TEST = [
  "import { expect, it } from 'vitest';",
  "import { a } from '../../src/a.js';",
  '',
  "it('is one', () => expect(a).toBe(1));",
  '',
].join('\n');

/** A provider that applies the edits named in the JSON file it is given, then succeeds. */
const PROVIDER = `
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
for await (const _chunk of process.stdin);
const edits = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const [path, content] of Object.entries(edits)) {
  if (content === null) rmSync(path);
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: 'Done.',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  total_cost_usd: 0.01,
}) + '\\n');
`;

function repository(constitution: string): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-focused-regression-dispatch-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'fixture');
  git(root, 'config', 'commit.gpgsign', 'false');
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  put('.gitignore', '.devai/\n');
  put('AGENTS.md', '# Fixture adopter\n');
  put('packages/app/src/a.ts', 'export const a = 1;\n');
  put('packages/app/src/b.ts', 'export const b = 1;\n');
  put('packages/app/tests/unit/a.test.ts', EXISTING_TEST);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');
  put(
    '.devai/pin/constitution.md',
    `# DEVAI Constitution — ${constitution}\n\n**Version:** ${constitution}\n`,
  );
  put(join('work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

const ACTIVATION: ExperimentalActivation = {
  schemaVersion: '1.0.0',
  id: 'experimental-activation',
  authority: 'Owner',
  issued_at: '2026-10-04T00:00:00.000Z',
  expires_at: '2026-10-18T00:00:00.000Z',
  runtimes: [{ runtime: 'claude-cli', models: ['sonnet'], efforts: ['high'] }],
  disciplines: ['engineer', 'inspector'],
  budgets: {
    attempts_per_task: 4,
    attempts_per_invocation: 8,
    attempt_wall_clock_minutes: 1,
    tokens_per_invocation: 1_000_000,
  },
};

function agentTask(root: string, id: string): TaskRecord {
  const draft = {
    schemaVersion: '2.0.0',
    id,
    round_id: ROUND,
    status: 'ready',
    discipline: 'engineer',
    title: `Repair ${id}`,
    target_modules: [`MOD-${id}`],
    target_substrates: ['F2'],
    created_at: '2026-10-04T00:00:00.000Z',
    db_isolation: 'database',
    iteration_count: 0,
    executor: {
      kind: 'agent',
      runtime: 'claude-cli',
      model: 'sonnet',
      effort: 'high',
      selection: { mode: 'exact', registry_id: 'claude-cli' },
      prompt_composition_id: 'PC-0000000000000000',
      max_iterations: 4,
      capabilities: ['repository-context'],
      recipe_name: 'devai-fix',
    },
  } as TaskRecord;
  const id16 = composeAgentPrompt({ repoRoot: root, task: draft }).composition.id;
  return { ...draft, executor: { ...draft.executor, prompt_composition_id: id16 } } as TaskRecord;
}

async function permissive<T>(run: () => Promise<T>): Promise<T> {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'focused-regression' });
  const scope: AuthorityHostEffectScope = {
    action_id: 'round dispatch',
    invocation_id: 'focused-regression',
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

async function dispatch(root: string, edits: Readonly<Record<string, string | null>>) {
  const scripts = mkdtempSync(join(tmpdir(), 'devai-focused-regression-provider-'));
  roots.push(scripts);
  writeFileSync(join(scripts, 'provider.mjs'), PROVIDER);
  writeFileSync(join(scripts, 'edits.json'), JSON.stringify(edits));
  await permissive(async () => {
    saveTask(root, agentTask(root, 'TASK-0412'));
  });
  const budget: ExperimentalBudget = { attempts: 0, tokens: 0, unverifiable: false };
  return permissive(() =>
    runRoundTasks({
      repoRoot: root,
      round: ROUND,
      dispatch: (task) =>
        dispatchExperimentalTask(
          {
            repoRoot: root,
            roundId: ROUND,
            activation: ACTIVATION,
            budget,
            invocation: (selection) => ({
              runtime: selection.runtime,
              command: process.execPath,
              args: [join(scripts, 'provider.mjs'), join(scripts, 'edits.json')],
            }),
          },
          task,
        ),
    }),
  );
}

function failureMessages(root: string): string[] {
  const dir = join(root, '.devai/state/round-runs', ROUND, 'task-executions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
      readonly failure?: { readonly message: string };
    };
    return record.failure === undefined ? [] : [record.failure.message];
  });
}

const CHANGED_A = { 'packages/app/src/a.ts': 'export const a = 2;\n' };
const ADJACENT = {
  'packages/app/tests/unit/a-regression.test.ts': [
    "import { expect, it } from 'vitest';",
    "import { a } from '../../src/a.js';",
    "it('is two', () => expect(a).toBe(2));",
    '',
  ].join('\n'),
};

describe('round dispatch judges Engineer test writes by diff adjacency (ADR-GOV-0026)', () => {
  it('passes an attempt that changes a source and adds its adjacent test (IA-001)', async () => {
    const root = repository('1.1.0');
    const result = await dispatch(root, { ...CHANGED_A, ...ADJACENT });
    expect(result.results).toMatchObject([{ task_id: 'TASK-0412', ok: true }]);
    expect(loadTask(root, 'TASK-0412').status).toBe('awaiting_human_review');
  });

  it('fails an attempt whose test imports no source it changed (IA-001)', async () => {
    const root = repository('1.1.0');
    const result = await dispatch(root, {
      ...CHANGED_A,
      'packages/app/tests/unit/b.test.ts': [
        "import { expect, it } from 'vitest';",
        "import { b } from '../../src/b.js';",
        "it('is one', () => expect(b).toBe(1));",
        '',
      ].join('\n'),
    });
    expect(result.results).toMatchObject([
      { task_id: 'TASK-0412', ok: false, code: 'EXPERIMENTAL_WRITE_SCOPE_VIOLATION' },
    ]);
    expect(failureMessages(root).join('\n')).toContain('packages/app/tests/unit/b.test.ts');
  });

  it('fails an attempt that edits an assertion of an existing test (IA-002)', async () => {
    const root = repository('1.1.0');
    const result = await dispatch(root, {
      ...CHANGED_A,
      'packages/app/tests/unit/a.test.ts': EXISTING_TEST.replace('toBe(1)', 'toBe(2)'),
    });
    expect(result.results).toMatchObject([
      { task_id: 'TASK-0412', ok: false, code: 'EXPERIMENTAL_WRITE_SCOPE_VIOLATION' },
    ]);
  });

  it('fails an attempt that deletes a test (IA-002)', async () => {
    const root = repository('1.1.0');
    const result = await dispatch(root, {
      ...CHANGED_A,
      'packages/app/tests/unit/a.test.ts': null,
    });
    expect(result.results).toMatchObject([
      { task_id: 'TASK-0412', ok: false, code: 'EXPERIMENTAL_WRITE_SCOPE_VIOLATION' },
    ]);
  });

  it('fails the adjacent test of IA-001 under a constitution without the verb (IA-004)', async () => {
    const root = repository('1.0.2');
    const result = await dispatch(root, { ...CHANGED_A, ...ADJACENT });
    expect(result.results).toMatchObject([
      { task_id: 'TASK-0412', ok: false, code: 'EXPERIMENTAL_WRITE_SCOPE_VIOLATION' },
    ]);
  });
});
