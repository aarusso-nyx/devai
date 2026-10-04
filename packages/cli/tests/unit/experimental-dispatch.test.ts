// ADR-MDL-0005 IA-001..IA-007 end to end against a scripted fake provider: the ladder, the
// bumped tier, budgets, the Article 6 write-scope check, the journal and non-promoting
// evidence, through the real round runner, worktrees and governed spawn. No live provider.
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
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import {
  loadTask,
  readDispatchJournal,
  runRoundTasks,
  saveTask,
  type ExperimentalActivation,
  type TaskRecord,
} from '@devai-nyx/loop';
import { composeAgentPrompt } from '@devai-nyx/skills';
import {
  EXPERIMENTAL_TIER_ORDER,
  article6Role,
  bumpedModel,
  dispatchExperimentalTask,
  experimentalTaskRefusal,
  type ExperimentalBudget,
} from '../../src/services/experimental-dispatch/index.js';

const FAKE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'skills',
  'tests',
  'fixtures',
  'fake-agent-cli.mjs',
);
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ROUND = 'R-0012';
// These fixtures create their own repositories; an inherited GIT_DIR or GIT_INDEX_FILE (for
// example when a host test runs this file inside another fixture) must never retarget them.
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

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-experimental-dispatch-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'fixture');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, '.gitignore'), '.devai/\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Fixture adopter\n');
  mkdirSync(join(root, 'packages/app/src'), { recursive: true });
  writeFileSync(join(root, 'packages/app/src/index.ts'), 'export const x = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');
  mkdirSync(join(root, 'work/rounds', ROUND), { recursive: true });
  writeFileSync(join(root, 'work/rounds', ROUND, 'AUTHORIZATION.md'), 'status: active\nGRANTED\n');
  return root;
}

function activation(overrides: Partial<ExperimentalActivation> = {}): ExperimentalActivation {
  return {
    schemaVersion: '1.0.0',
    id: 'experimental-activation',
    authority: 'Owner',
    issued_at: '2026-10-04T00:00:00.000Z',
    expires_at: '2026-10-18T00:00:00.000Z',
    runtimes: [{ runtime: 'claude-cli', models: ['sonnet', 'opus'], efforts: ['high'] }],
    disciplines: ['engineer', 'inspector'],
    budgets: {
      attempts_per_task: 4,
      attempts_per_invocation: 8,
      attempt_wall_clock_minutes: 1,
      tokens_per_invocation: 1_000_000,
    },
    ...overrides,
  };
}

function agentTask(root: string, id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const draft = {
    schemaVersion: '2.0.0',
    id,
    round_id: ROUND,
    status: 'ready',
    discipline: 'engineer',
    title: `Implement ${id}`,
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
    },
    ...overrides,
  } as TaskRecord;
  const id16 = composeAgentPrompt({ repoRoot: root, task: draft }).composition.id;
  return { ...draft, executor: { ...draft.executor, prompt_composition_id: id16 } } as TaskRecord;
}

async function permissive<T>(run: () => Promise<T>): Promise<T> {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'experimental-dispatch' });
  const scope: AuthorityHostEffectScope = {
    action_id: 'round dispatch',
    invocation_id: 'experimental-dispatch',
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

/** Scenario per attempt model; `writes` sets the path the fake provider changes. */
async function dispatch(
  root: string,
  options: {
    readonly activation?: ExperimentalActivation;
    readonly scenario: (model: string) => string;
    readonly writes?: string;
    readonly taskIds?: readonly string[];
  },
) {
  const budget: ExperimentalBudget = { attempts: 0, tokens: 0, unverifiable: false };
  const result = await permissive(() =>
    runRoundTasks({
      repoRoot: root,
      round: ROUND,
      ...(options.taskIds !== undefined && { taskIds: options.taskIds }),
      dispatch: (task) =>
        dispatchExperimentalTask(
          {
            repoRoot: root,
            roundId: ROUND,
            activation: options.activation ?? activation(),
            budget,
            env: {
              ...process.env,
              FAKE_AGENT_WRITE_PATH: options.writes ?? 'packages/app/src/feature.ts',
            },
            invocation: (selection) => ({
              runtime: selection.runtime,
              command: process.execPath,
              args: [FAKE, options.scenario(selection.model)],
            }),
          },
          task,
        ),
    }),
  );
  return { result, budget };
}

function evidence(root: string): Record<string, unknown>[] {
  const dir = join(root, '.devai/state/round-runs', ROUND, 'task-executions');
  return existsSync(dir)
    ? readdirSync(dir).map(
        (name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>,
      )
    : [];
}

describe('experimental dispatch engine', () => {
  it('passes a contained attempt to human review with its worktree, journal and evidence (IA-007)', async () => {
    const root = repository();
    await permissive(async () => {
      saveTask(root, agentTask(root, 'TASK-0101'));
    });
    const { result, budget } = await dispatch(root, { scenario: () => 'claude-writes' });
    expect(result.results).toMatchObject([{ task_id: 'TASK-0101', ok: true }]);
    const task = loadTask(root, 'TASK-0101');
    expect(task.status).toBe('awaiting_human_review');
    expect(task.worktree_id).toBe('WT-TASK-0101-A1');
    expect(
      existsSync(join(root, '.devai/worktrees/WT-TASK-0101-A1/packages/app/src/feature.ts')),
    ).toBe(true);
    expect(readDispatchJournal(root, ROUND).map((event) => event.event)).toEqual([
      'intent',
      'spawned',
      'exited',
      'evidence-written',
      'settled',
    ]);
    const [record] = evidence(root);
    expect(record).toMatchObject({
      experimental: true,
      verdict: 'pass',
      usage: { usage_version: 2, input_tokens: { value: 1200, status: 'reported' } },
      cost: { source: 'provider-reported' },
    });
    expect(budget).toEqual({ attempts: 1, tokens: 1500, unverifiable: false });
  });

  it('fails every attempt that writes outside the discipline paths and blocks the task (IA-003)', async () => {
    const root = repository();
    await permissive(async () => {
      saveTask(root, agentTask(root, 'TASK-0102'));
    });
    const { result } = await dispatch(root, {
      activation: activation({
        runtimes: [{ runtime: 'claude-cli', models: ['sonnet'], efforts: ['high'] }],
      }),
      scenario: () => 'claude-writes',
      writes: 'docs/notes.md',
    });
    expect(result.results).toMatchObject([
      { task_id: 'TASK-0102', ok: false, code: 'EXPERIMENTAL_WRITE_SCOPE_VIOLATION' },
    ]);
    expect(loadTask(root, 'TASK-0102').status).toBe('experimental_blocked');
    expect(evidence(root)).toHaveLength(3);
    expect(existsSync(join(root, '.devai/worktrees/WT-TASK-0102-A1'))).toBe(false);
  });

  it('runs three default-tier attempts then exactly one bumped-tier attempt (IA-006)', async () => {
    const root = repository();
    await permissive(async () => {
      saveTask(root, agentTask(root, 'TASK-0103'));
    });
    const { result } = await dispatch(root, {
      scenario: (model) => (model === 'opus' ? 'claude-writes' : 'claude-error'),
    });
    expect(result.results).toMatchObject([{ task_id: 'TASK-0103', ok: true }]);
    const journal = readDispatchJournal(root, ROUND).filter((event) => event.event === 'intent');
    expect(journal.map((event) => [event.attempt, event.model, event.tier])).toEqual([
      [1, 'sonnet', 'default'],
      [2, 'sonnet', 'default'],
      [3, 'sonnet', 'default'],
      [4, 'opus', 'bumped'],
    ]);
    const bumped = evidence(root).find((record) => record['verdict'] === 'pass');
    expect(bumped).toMatchObject({
      resolved_executor: { model: 'opus' },
      selection: { fallback: true, fallback_reason: 'experimental-bumped-tier' },
    });
  });

  it('never exceeds the invocation attempt budget across tasks (IA-002)', async () => {
    const root = repository();
    await permissive(async () => {
      saveTask(root, agentTask(root, 'TASK-0104'));
    });
    await permissive(async () => {
      saveTask(root, agentTask(root, 'TASK-0105'));
    });
    const { result, budget } = await dispatch(root, {
      activation: activation({ budgets: { ...activation().budgets, attempts_per_invocation: 2 } }),
      scenario: () => 'claude-error',
    });
    expect(budget.attempts).toBe(2);
    expect(result.results.at(-1)).toMatchObject({
      ok: false,
      code: 'EXPERIMENTAL_ATTEMPT_BUDGET_EXHAUSTED',
    });
  });

  it('stops spending once a provider leaves its token usage unreported (IA-005)', async () => {
    const root = repository();
    await permissive(async () => {
      saveTask(root, agentTask(root, 'TASK-0106'));
      saveTask(root, agentTask(root, 'TASK-0108'));
    });
    const { result, budget } = await dispatch(root, { scenario: () => 'claude-missing-usage' });
    expect(budget).toMatchObject({ attempts: 1, unverifiable: true });
    expect(result.results).toMatchObject([
      { task_id: 'TASK-0106', ok: true },
      { task_id: 'TASK-0108', ok: false, code: 'EXPERIMENTAL_USAGE_UNVERIFIABLE' },
    ]);
  });

  it('refuses a task whose bound prompt composition drifted (Article 37)', async () => {
    const root = repository();
    const task = agentTask(root, 'TASK-0107');
    await permissive(async () => {
      saveTask(root, {
        ...task,
        executor: { ...task.executor, prompt_composition_id: 'PC-ffffffffffffffff' },
      } as TaskRecord);
    });
    const { result, budget } = await dispatch(root, { scenario: () => 'claude-writes' });
    expect(result.results).toMatchObject([{ ok: false, code: 'TASK_PROMPT_COMPOSITION_DRIFT' }]);
    expect(budget.attempts).toBe(0);
  });
});

describe('experimental admission rules', () => {
  it('admits only activated disciplines, runtimes, models, efforts and exact selection', () => {
    const root = repository();
    const task = agentTask(root, 'TASK-0110');
    expect(experimentalTaskRefusal(task, activation())).toBeUndefined();
    expect(
      experimentalTaskRefusal({ ...task, discipline: 'architect' } as TaskRecord, activation()),
    ).toBe('EXPERIMENTAL_DISCIPLINE_NOT_ACTIVATED');
    expect(
      experimentalTaskRefusal(
        task,
        activation({
          runtimes: [{ runtime: 'codex-cli', models: ['gpt-6-sol'], efforts: ['high'] }],
        }),
      ),
    ).toBe('EXPERIMENTAL_RUNTIME_NOT_ACTIVATED');
    expect(
      experimentalTaskRefusal(
        task,
        activation({ runtimes: [{ runtime: 'claude-cli', models: ['opus'], efforts: ['high'] }] }),
      ),
    ).toBe('EXPERIMENTAL_SELECTION_NOT_ACTIVATED');
    expect(
      experimentalTaskRefusal(
        {
          ...task,
          executor: { ...task.executor, selection: { mode: 'preferred' } },
        } as unknown as TaskRecord,
        activation(),
      ),
    ).toBe('EXPERIMENTAL_SELECTION_NOT_EXACT');
  });

  it('bumps only to the next tier the Owner also activated, mirroring model-tiers.json', () => {
    const tiers = (
      JSON.parse(readFileSync(join(ROOT, 'law/policy/model-tiers.json'), 'utf8')) as {
        tiers: Record<string, { rank: number; hosts: Record<string, string> }>;
      }
    ).tiers;
    const order = (host: string) => [
      ...new Set(
        Object.values(tiers)
          .sort((a, b) => b.rank - a.rank)
          .map((tier) => tier.hosts[host] as string),
      ),
    ];
    expect(EXPERIMENTAL_TIER_ORDER['claude-cli']).toEqual(order('claude'));
    expect(EXPERIMENTAL_TIER_ORDER['codex-cli']).toEqual(order('codex'));
    expect(bumpedModel('claude-cli', 'sonnet', activation())).toBe('opus');
    expect(bumpedModel('claude-cli', 'opus', activation())).toBeUndefined();
    expect(
      bumpedModel(
        'claude-cli',
        'sonnet',
        activation({
          runtimes: [{ runtime: 'claude-cli', models: ['sonnet'], efforts: ['high'] }],
        }),
      ),
    ).toBeUndefined();
  });

  it('maps paths to their Article 6 role', () => {
    expect(article6Role('packages/app/src/a.ts')).toBe('engineer');
    expect(article6Role('packages/app/tests/a.test.ts')).toBe('inspector');
    expect(article6Role('tests/e2e/a.test.ts')).toBe('inspector');
    expect(article6Role('package.json')).toBe('engineer');
    expect(article6Role('AGENTS.md')).toBeUndefined();
    expect(article6Role('docs/a.md')).toBe('architect');
    expect(article6Role('law/x.json')).toBe('architect');
    expect(article6Role('law/glossary/x.md')).toBeUndefined();
  });
});
